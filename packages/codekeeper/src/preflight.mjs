import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  ASSISTANT_WORKFLOW,
  BOT_LOGIN_VARIABLE,
  CLIENT_ID_VARIABLE,
  ENABLED_VARIABLE,
  MODE_IDS,
  MODES,
  POLICY_TARGET,
  SETUP_BRANCH
} from "./constants.mjs";
import { InstallerError } from "./errors.mjs";
import { requireSuccess } from "./command-runner.mjs";
import { upgradePolicy } from "./policy.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_WORKFLOW_REFERENCE = /(?:coryparrry\/Codekeeper|\/tools\/codekeeper@|\/.github\/workflows\/codekeeper-)/i;

function callerBoolean(source, name) {
  const matches = [...source.matchAll(new RegExp(`^\\s*${name}:\\s*(true|false)\\s*$`, "gm"))];
  if (matches.length > 1) throw new InstallerError(`Existing caller has duplicate ${name} controls.`, { code: "EXISTING_INSTALLATION_INVALID" });
  return matches.length ? matches[0][1] === "true" : null;
}

function callerSchedule(source) {
  const matches = [...source.matchAll(/^\s*-\s+cron:\s*["']([^"']+)["']\s*$/gm)];
  if (matches.length > 1) throw new InstallerError("Existing maintenance caller has duplicate schedules.", { code: "EXISTING_INSTALLATION_INVALID" });
  const value = matches[0]?.[1] ?? null;
  if (value !== null && !/^[^\s"'#]+(?:\s+[^\s"'#]+){4}$/.test(value)) {
    throw new InstallerError("Existing maintenance caller has an invalid schedule.", { code: "EXISTING_INSTALLATION_INVALID" });
  }
  return value;
}

function trimGitSuffix(value) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function repositoryFromPathname(pathname) {
  const parts = trimGitSuffix(pathname.replace(/^\//, "").replace(/\/$/, "")).split("/");
  const repository = parts.length === 2 ? `${parts[0]}/${parts[1]}` : "";
  if (!REPOSITORY.test(repository)) throw new InstallerError("origin is not a GitHub.com owner/repository URL.", { code: "UNSUPPORTED_ORIGIN" });
  return repository;
}

export function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) {
    throw new InstallerError("The Git origin URL is missing.", { code: "UNSUPPORTED_ORIGIN" });
  }
  const value = remoteUrl.trim();
  const scp = /^git@github\.com:([^?#]+)$/.exec(value);
  if (scp) return Object.freeze({ host: "github.com", repository: repositoryFromPathname(scp[1]), protocol: "ssh" });

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InstallerError("origin must use GitHub.com HTTPS or SSH.", { code: "UNSUPPORTED_ORIGIN" });
  }
  if (parsed.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:"].includes(parsed.protocol)) {
    throw new InstallerError("GitHub Enterprise Server and non-GitHub origins are not supported.", { code: "UNSUPPORTED_ORIGIN" });
  }
  if (parsed.search || parsed.hash || parsed.password || (parsed.protocol === "https:" && parsed.username)) {
    throw new InstallerError("origin must not contain credentials, query parameters, or fragments.", { code: "UNSUPPORTED_ORIGIN" });
  }
  if (parsed.protocol === "ssh:" && parsed.username !== "git") {
    throw new InstallerError("GitHub SSH origins must use the git user.", { code: "UNSUPPORTED_ORIGIN" });
  }
  return Object.freeze({
    host: "github.com",
    repository: repositoryFromPathname(parsed.pathname),
    protocol: parsed.protocol === "https:" ? "https" : "ssh"
  });
}

export function assertNodeVersion(nodeVersion = process.versions.node) {
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new InstallerError("Node.js 22 or newer is required.", { code: "UNSUPPORTED_NODE" });
  }
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new InstallerError(`${label} returned invalid JSON.`, { code: "PREFLIGHT_INVALID_RESPONSE", cause });
  }
}

async function exists(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function safeDirectoryEntries(fsImpl, target) {
  const stat = await exists(fsImpl, target);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new InstallerError(`${target} must be a regular directory, not a symlink.`, { code: "PATH_COLLISION" });
  }
  return fsImpl.readdir(target, { withFileTypes: true });
}

function caseEntry(entries, expected) {
  return entries.find((entry) => entry.name.toLowerCase() === expected.toLowerCase());
}

export async function assertNoInstallationFiles(root, {
  fsImpl = { lstat, readdir, readFile },
  allowExisting = false
} = {}) {
  const rootEntries = await safeDirectoryEntries(fsImpl, root);
  const githubEntry = caseEntry(rootEntries, ".github");
  if (!githubEntry) return;
  if (githubEntry.name !== ".github" || githubEntry.isSymbolicLink() || !githubEntry.isDirectory()) {
    throw new InstallerError("A case-colliding or symlinked .github path already exists.", { code: "PATH_COLLISION" });
  }

  const githubRoot = path.join(root, ".github");
  const githubEntries = await safeDirectoryEntries(fsImpl, githubRoot);
  const policyEntry = caseEntry(githubEntries, "codekeeper.json");
  if (policyEntry) {
    if (policyEntry.name !== "codekeeper.json" || policyEntry.isSymbolicLink() || !policyEntry.isFile()) {
      throw new InstallerError("A case-colliding or symlinked Codekeeper policy exists.", { code: "PATH_COLLISION" });
    }
    if (!allowExisting) throw new InstallerError("A Codekeeper policy already exists.", { code: "EXISTING_INSTALLATION" });
  }

  const codekeeperEntry = caseEntry(githubEntries, "codekeeper");
  if (codekeeperEntry) {
    if (codekeeperEntry.name !== "codekeeper" || codekeeperEntry.isSymbolicLink() || !codekeeperEntry.isDirectory()) {
      throw new InstallerError("A case-colliding or symlinked .github/codekeeper path already exists.", { code: "PATH_COLLISION" });
    }
    const codekeeperRoot = path.join(githubRoot, "codekeeper");
    const codekeeperEntries = await safeDirectoryEntries(fsImpl, codekeeperRoot);
    const agentsEntry = caseEntry(codekeeperEntries, "agents");
    if (agentsEntry) {
      if (agentsEntry.name !== "agents" || agentsEntry.isSymbolicLink() || !agentsEntry.isDirectory()) {
        throw new InstallerError("A case-colliding or symlinked Codekeeper agents path already exists.", { code: "PATH_COLLISION" });
      }
      const agentsRoot = path.join(codekeeperRoot, "agents");
      const agentEntries = await safeDirectoryEntries(fsImpl, agentsRoot);
      const knownProfileNames = new Map(AGENT_PROFILE_IDS.map((profile) => {
        const name = path.basename(AGENT_PROFILES[profile].target);
        return [name.toLowerCase(), name];
      }));
      for (const entry of agentEntries) {
        const expectedName = knownProfileNames.get(entry.name.toLowerCase());
        if (!expectedName) continue;
        if (entry.name !== expectedName
          || entry.isSymbolicLink() || !entry.isFile()) {
          throw new InstallerError("A case-colliding or symlinked Codekeeper agent profile exists.", { code: "PATH_COLLISION" });
        }
        if (!allowExisting) throw new InstallerError("A Codekeeper agent profile already exists.", { code: "EXISTING_INSTALLATION" });
      }
    }
  }

  const workflowsEntry = caseEntry(githubEntries, "workflows");
  if (!workflowsEntry) return;
  if (workflowsEntry.name !== "workflows" || workflowsEntry.isSymbolicLink() || !workflowsEntry.isDirectory()) {
    throw new InstallerError("A case-colliding or symlinked workflows path already exists.", { code: "PATH_COLLISION" });
  }

  const workflowsRoot = path.join(githubRoot, "workflows");
  const workflowEntries = await safeDirectoryEntries(fsImpl, workflowsRoot);
  const knownWorkflowNames = new Map([
    ...MODE_IDS.map((mode) => {
      const name = path.basename(MODES[mode].target);
      return [name.toLowerCase(), { mode, name }];
    }),
    [path.basename(ASSISTANT_WORKFLOW.target).toLowerCase(), { mode: ASSISTANT_WORKFLOW.id, name: path.basename(ASSISTANT_WORKFLOW.target) }]
  ]);
  for (const entry of workflowEntries) {
    const knownWorkflow = knownWorkflowNames.get(entry.name.toLowerCase());
    if (knownWorkflow) {
      if (entry.name !== knownWorkflow.name || entry.isSymbolicLink() || !entry.isFile()) {
        throw new InstallerError("A case-colliding or symlinked Codekeeper workflow exists.", { code: "PATH_COLLISION" });
      }
      if (!allowExisting) throw new InstallerError("A Codekeeper workflow already exists.", { code: "EXISTING_INSTALLATION" });
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (/codekeeper/i.test(entry.name)) throw new InstallerError("A symlinked Codekeeper workflow path already exists.", { code: "PATH_COLLISION" });
      continue;
    }
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const source = await fsImpl.readFile(path.join(workflowsRoot, entry.name), "utf8");
    if (GITHUB_WORKFLOW_REFERENCE.test(source)) {
      throw new InstallerError(`Existing workflow ${entry.name} already invokes Codekeeper.`, { code: "EXISTING_INSTALLATION" });
    }
  }
}

export async function inspectInstallationFiles(root, {
  fsImpl = { lstat, readdir, readFile }
} = {}) {
  const policyPath = path.join(root, ...POLICY_TARGET.split("/"));
  const policyStat = await exists(fsImpl, policyPath);
  if (!policyStat) {
    await assertNoInstallationFiles(root, { fsImpl });
    return null;
  }
  await assertNoInstallationFiles(root, { fsImpl, allowExisting: true });
  let policy;
  const installedPolicySource = await fsImpl.readFile(policyPath, "utf8");
  try {
    policy = JSON.parse(installedPolicySource);
  } catch (cause) {
    throw new InstallerError("The existing Codekeeper policy is not valid JSON.", { code: "EXISTING_INSTALLATION_INVALID", cause });
  }
  if (!policy?.ai?.agents || !policy?.repository || !policy?.audit || !policy?.issues || !policy?.merge) {
    throw new InstallerError("The existing Codekeeper policy does not have the required sections.", { code: "EXISTING_INSTALLATION_INVALID" });
  }
  try {
    policy = upgradePolicy(policy);
  } catch (cause) {
    throw new InstallerError("The existing Codekeeper policy version is unsupported.", { code: "EXISTING_INSTALLATION_INVALID", cause });
  }
  // The planner was removed from the production flow. Strip its legacy policy
  // entry during reruns so the current strict policy validator can accept the
  // existing installation and render the single-pass fixer contract.
  delete policy.ai.agents.plan;
  for (const agent of Object.values(policy.ai.agents)) {
    if (agent && typeof agent === "object" && !Array.isArray(agent)) agent.maxTurns = 1;
  }
  const contents = { [POLICY_TARGET]: installedPolicySource };
  for (const profile of AGENT_PROFILE_IDS) {
    const target = AGENT_PROFILES[profile].target;
    const filePath = path.join(root, ...target.split("/"));
    const stat = await exists(fsImpl, filePath);
    if (!stat && profile === "fixer") continue;
    if (!stat) throw new InstallerError(`The existing installation is missing ${target}.`, { code: "EXISTING_INSTALLATION_INVALID" });
    contents[target] = await fsImpl.readFile(filePath, "utf8");
  }
  const modes = [];
  for (const mode of MODE_IDS) {
    const target = MODES[mode].target;
    const filePath = path.join(root, ...target.split("/"));
    if (!await exists(fsImpl, filePath)) continue;
    modes.push(mode);
    contents[target] = await fsImpl.readFile(filePath, "utf8");
  }
  if (!modes.length) throw new InstallerError("The existing installation has no Codekeeper workflows.", { code: "EXISTING_INSTALLATION_INVALID" });
  if (contents[MODES.review.target]) {
    policy.automation.automaticPrReview = callerBoolean(contents[MODES.review.target], "auto_review") ?? policy.automation.automaticPrReview;
    policy.automation.reviewFeedbackTriage = callerBoolean(contents[MODES.review.target], "feedback_triage") ?? policy.automation.reviewFeedbackTriage;
  }
  if (contents[MODES.issues.target]) {
    policy.automation.issueTriage = callerBoolean(contents[MODES.issues.target], "auto_triage") ?? policy.automation.issueTriage;
  }
  if (contents[MODES.maintain.target]) {
    policy.automation.maintenanceSchedule = callerSchedule(contents[MODES.maintain.target]) ?? policy.automation.maintenanceSchedule;
  }
  const assistantPath = path.join(root, ...ASSISTANT_WORKFLOW.target.split("/"));
  if (await exists(fsImpl, assistantPath)) {
    contents[ASSISTANT_WORKFLOW.target] = await fsImpl.readFile(assistantPath, "utf8");
    policy.automation.ownerRequests = callerBoolean(contents[ASSISTANT_WORKFLOW.target], "owner_requests") ?? policy.automation.ownerRequests;
  }
  const policySource = `${JSON.stringify(policy, null, 2)}\n`;
  const legacyPlannerProfile = ".github/codekeeper/agents/maintenance-planner.md";
  const legacyFiles = await exists(fsImpl, path.join(root, ...legacyPlannerProfile.split("/")))
    ? [legacyPlannerProfile]
    : [];
  return Object.freeze({
    policy: Object.freeze(policy),
    policySource,
    modes: Object.freeze(modes),
    contents: Object.freeze(contents),
    legacyFiles: Object.freeze(legacyFiles)
  });
}

async function assertNoGitOperation(root, runner, fsImpl) {
  const names = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];
  for (const name of names) {
    const gitPath = await requireSuccess(runner, "git", ["rev-parse", "--git-path", name], { cwd: root }, "Could not inspect Git operation state.");
    const resolved = path.isAbsolute(gitPath) ? gitPath : path.join(root, gitPath);
    if (await exists(fsImpl, resolved)) {
      throw new InstallerError("Finish the active Git operation before installing Codekeeper.", { code: "GIT_OPERATION_ACTIVE" });
    }
  }
}

function remoteSha(output, defaultBranch) {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new InstallerError(`origin does not expose exactly one ${defaultBranch} branch tip.`, { code: "REMOTE_HEAD_INVALID" });
  const [sha, ref, ...extra] = lines[0].split(/\s+/);
  if (!FULL_SHA.test(sha) || ref !== `refs/heads/${defaultBranch}` || extra.length) {
    throw new InstallerError("origin returned an invalid default-branch tip.", { code: "REMOTE_HEAD_INVALID" });
  }
  return sha;
}

export async function assertNoSetupBranch({ runner, root, repository, branch = SETUP_BRANCH }) {
  const localRefs = await requireSuccess(
    runner,
    "git",
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
    { cwd: root },
    "Could not inspect local Git refs."
  );
  const collidingRefs = new Set([
    "refs/heads/codekeeper",
    `refs/heads/${branch}`,
    "refs/remotes/origin/codekeeper",
    `refs/remotes/origin/${branch}`
  ]);
  if (localRefs.split("\n").some((ref) => collidingRefs.has(ref.trim()) || ref.trim().startsWith(`refs/heads/${branch}/`) || ref.trim().startsWith(`refs/remotes/origin/${branch}/`))) {
    throw new InstallerError(`Local Git refs collide with ${branch}.`, { code: "SETUP_BRANCH_EXISTS" });
  }

  const remoteRefs = await requireSuccess(
    runner,
    "git",
    ["ls-remote", "--heads", "origin", "refs/heads/codekeeper", `refs/heads/${branch}`, `refs/heads/${branch}/*`],
    { cwd: root },
    "Could not inspect remote setup refs."
  );
  if (remoteRefs.trim()) throw new InstallerError(`Remote branch ${branch} or a colliding ref already exists.`, { code: "SETUP_BRANCH_EXISTS" });

  const pulls = parseJson(await requireSuccess(
    runner,
    "gh",
    ["pr", "list", "--repo", repository, "--state", "all", "--head", branch, "--json", "number,url"],
    { cwd: root },
    "Could not inspect existing setup pull requests."
  ), "GitHub pull-request query");
  if (!Array.isArray(pulls)) throw new InstallerError("GitHub returned an invalid pull-request list.", { code: "PREFLIGHT_INVALID_RESPONSE" });
  if (pulls.length) throw new InstallerError(`A setup pull request already exists for ${branch}.`, { code: "SETUP_BRANCH_EXISTS" });
}

async function repositoryVariable(runner, root, repository, name) {
  return requireSuccess(
    runner,
    "gh",
    ["variable", "get", name, "--repo", repository, "--json", "value", "--jq", ".value"],
    { cwd: root },
    `The existing installation is missing the ${name} repository variable.`
  );
}

async function optionalRepositoryVariable(runner, root, repository, name) {
  const variables = parseJson(await requireSuccess(
    runner,
    "gh",
    ["variable", "list", "--repo", repository, "--json", "name,value"],
    { cwd: root },
    "Could not inspect existing repository variables."
  ), "GitHub repository-variable query");
  if (!Array.isArray(variables) || variables.some((variable) => typeof variable?.name !== "string" || typeof variable?.value !== "string")) {
    throw new InstallerError("GitHub returned an invalid repository-variable list.", { code: "PREFLIGHT_INVALID_RESPONSE" });
  }
  return variables.find((variable) => variable.name === name)?.value ?? null;
}

export async function inspectRepository({
  runner,
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  interactive = true,
  fsImpl = { lstat, readdir, readFile, realpath }
}) {
  assertNodeVersion(nodeVersion);
  if (!interactive) throw new InstallerError("Codekeeper init requires an interactive terminal.", { code: "NON_INTERACTIVE" });
  await requireSuccess(runner, "git", ["--version"], { cwd }, "Git is required.");
  await requireSuccess(runner, "gh", ["--version"], { cwd }, "GitHub CLI is required.");
  const rootOutput = await requireSuccess(runner, "git", ["rev-parse", "--show-toplevel"], { cwd }, "Run Codekeeper init inside a Git checkout.");
  const root = await fsImpl.realpath(rootOutput);
  const bare = await requireSuccess(runner, "git", ["rev-parse", "--is-bare-repository"], { cwd: root }, "Could not inspect the Git checkout.");
  if (bare !== "false") throw new InstallerError("Bare repositories are not supported.", { code: "UNSUPPORTED_CHECKOUT" });
  const sparse = await runner.run("git", ["config", "--bool", "core.sparseCheckout"], { cwd: root });
  if (sparse.status === 0 && sparse.stdout.trim() === "true") throw new InstallerError("Sparse checkouts are not supported.", { code: "UNSUPPORTED_CHECKOUT" });
  if (![0, 1].includes(sparse.status)) throw new InstallerError("Could not inspect sparse-checkout state.", { code: "PREFLIGHT_COMMAND_FAILED" });
  await assertNoGitOperation(root, runner, fsImpl);

  const currentBranch = await requireSuccess(runner, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }, "Detached HEAD checkouts are not supported.");
  const originUrl = await requireSuccess(runner, "git", ["remote", "get-url", "origin"], { cwd: root }, "An origin remote is required.");
  const origin = parseGitHubRemote(originUrl);
  await requireSuccess(runner, "gh", ["auth", "status", "--hostname", "github.com"], { cwd: root }, "Authenticate GitHub CLI for github.com first.");
  const repositoryData = parseJson(await requireSuccess(
    runner,
    "gh",
    ["api", "--hostname", "github.com", `repos/${origin.repository}`],
    { cwd: root },
    "Could not read the GitHub repository."
  ), "GitHub repository query");
  const repository = repositoryData.full_name;
  if (typeof repository !== "string" || repository.toLowerCase() !== origin.repository.toLowerCase()) {
    throw new InstallerError("The GitHub repository does not match origin.", { code: "REPOSITORY_MISMATCH" });
  }
  const ownerType = repositoryData.owner?.type;
  if (!["User", "Organization"].includes(ownerType)) {
    throw new InstallerError("GitHub returned an unsupported repository owner type.", { code: "PREFLIGHT_INVALID_RESPONSE" });
  }
  if (repositoryData.permissions?.admin !== true) throw new InstallerError("Repository admin access is required.", { code: "ADMIN_REQUIRED" });
  if (repositoryData.archived || repositoryData.disabled) throw new InstallerError("Archived or disabled repositories are not supported.", { code: "UNSUPPORTED_REPOSITORY" });
  const actionsPermissions = parseJson(await requireSuccess(
    runner,
    "gh",
    ["api", "--hostname", "github.com", `repos/${repository}/actions/permissions`],
    { cwd: root },
    "Could not read GitHub Actions permissions."
  ), "GitHub Actions permissions query");
  if (actionsPermissions.enabled !== true) throw new InstallerError("GitHub Actions must be enabled for this repository.", { code: "ACTIONS_DISABLED" });
  const defaultBranch = repositoryData.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch || currentBranch !== defaultBranch) {
    throw new InstallerError(`The checkout must be attached to the GitHub default branch${defaultBranch ? ` (${defaultBranch})` : ""}.`, { code: "WRONG_BRANCH" });
  }

  const status = await requireSuccess(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }, "Could not inspect Git status.");
  if (status) throw new InstallerError("The Git checkout must be clean, including untracked files.", { code: "DIRTY_CHECKOUT" });
  const headSha = await requireSuccess(runner, "git", ["rev-parse", "HEAD"], { cwd: root }, "Could not read HEAD.");
  if (!FULL_SHA.test(headSha)) throw new InstallerError("Git returned an invalid HEAD commit.", { code: "INVALID_HEAD" });
  const remoteDefaultSha = remoteSha(await requireSuccess(
    runner,
    "git",
    ["ls-remote", "origin", `refs/heads/${defaultBranch}`],
    { cwd: root },
    "Could not read the remote default branch."
  ), defaultBranch);
  if (headSha !== remoteDefaultSha) throw new InstallerError("HEAD must exactly match the remote default branch before setup.", { code: "STALE_CHECKOUT" });

  const viewerLogin = await requireSuccess(runner, "gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"], { cwd: root }, "Could not identify the authenticated GitHub user.");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(viewerLogin)) throw new InstallerError("GitHub returned an invalid authenticated login.", { code: "PREFLIGHT_INVALID_RESPONSE" });
  const authorName = await runner.run("git", ["config", "--get", "user.name"], { cwd: root });
  const authorEmail = await runner.run("git", ["config", "--get", "user.email"], { cwd: root });
  if (authorName.status !== 0 || !authorName.stdout.trim() || authorEmail.status !== 0 || !authorEmail.stdout.trim()) {
    throw new InstallerError("Configure Git user.name and user.email before setup.", { code: "GIT_IDENTITY_REQUIRED" });
  }

  const installation = await inspectInstallationFiles(root, { fsImpl });
  const updateBranch = installation ? `codekeeper/update-${headSha.slice(0, 12)}` : SETUP_BRANCH;
  await assertNoSetupBranch({ runner, root, repository, branch: updateBranch });
  let existingSettings = null;
  if (installation) {
    existingSettings = Object.freeze({
      enabled: (await repositoryVariable(runner, root, repository, ENABLED_VARIABLE)) === "true",
      appClientId: await repositoryVariable(runner, root, repository, CLIENT_ID_VARIABLE),
      automationBotLogin: installation.modes.includes("review") || (installation.modes.includes("fix") && installation.policy.issues.allowAiImplementation)
        ? await optionalRepositoryVariable(runner, root, repository, BOT_LOGIN_VARIABLE)
        : null
    });
  }
  return Object.freeze({
    root,
    originUrl,
    repository,
    ownerType,
    defaultBranch,
    currentBranch,
    headSha,
    remoteDefaultSha,
    viewerLogin,
    displayName: repository.split("/")[1],
    ...(installation ? { installation, existingSettings, updateBranch } : {})
  });
}
