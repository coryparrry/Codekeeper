import { createHash } from "node:crypto";
import { InstallerError } from "./errors.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_BRANCH = /^codekeeper\/(?:setup|update-[0-9a-f]{12})$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})(?:\[bot\])?$/;
const PROVIDER_SECRETS = Object.freeze({
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
});
const REQUIRED_BASE_SECRETS = Object.freeze(["CODEKEEPER_APP_PRIVATE_KEY"]);
const REQUIRED_BASE_VARIABLES = Object.freeze(["CODEKEEPER_ENABLED", "CODEKEEPER_APP_CLIENT_ID"]);

function fail(message, code = "RECOVERY_INVALID") {
  throw new InstallerError(message, { code });
}

async function checked(runner, command, args, options, message) {
  const result = await runner.run(command, args, options);
  if (
    !result ||
    result.status !== 0 ||
    result.timedOut === true ||
    result.truncated === true ||
    typeof result.stdout !== "string"
  ) {
    fail(message, "RECOVERY_COMMAND_FAILED");
  }
  return result.stdout.trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new InstallerError(`${label} is not valid JSON.`, {
      code: "RECOVERY_INVALID_RESPONSE",
      cause
    });
  }
}

export function parseRecoveryArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const options = { apply: false, json: false, branch: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--apply") options.apply = true;
    else if (value === "--json") options.json = true;
    else if (value === "--branch") {
      const branch = argv[index + 1];
      if (!branch || !SAFE_BRANCH.test(branch)) fail("--branch requires one Codekeeper setup or update branch.", "CLI_USAGE");
      options.branch = branch;
      index += 1;
    } else {
      fail(`Unsupported resume option: ${value}`, "CLI_USAGE");
    }
  }
  return Object.freeze(options);
}

export function parseGitHubRepository(originUrl) {
  const source = String(originUrl ?? "").trim();
  const match =
    source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    source.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    source.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) fail("origin must be a GitHub.com repository.", "UNSUPPORTED_REPOSITORY");
  return `${match[1]}/${match[2]}`;
}

export function parseRecoveryBranches(output) {
  const branches = [];
  for (const line of String(output ?? "").split("\n").map((item) => item.trim()).filter(Boolean)) {
    const [sha, ref, ...extra] = line.split(/\s+/);
    const prefix = "refs/heads/";
    if (!FULL_SHA.test(sha) || !ref?.startsWith(prefix) || extra.length) {
      fail("origin returned an invalid Codekeeper branch reference.", "RECOVERY_INVALID_RESPONSE");
    }
    const branch = ref.slice(prefix.length);
    if (!SAFE_BRANCH.test(branch)) continue;
    branches.push(Object.freeze({ branch, sha }));
  }
  const unique = new Map(branches.map((entry) => [entry.branch, entry]));
  if (unique.size !== branches.length) fail("origin returned duplicate Codekeeper branch references.", "RECOVERY_INVALID_RESPONSE");
  return Object.freeze([...unique.values()].sort((left, right) => left.branch.localeCompare(right.branch)));
}

function managedFiles(releaseManifest) {
  const files = releaseManifest?.managedFiles;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    fail("The recovery branch has no valid Codekeeper release manifest.", "RECOVERY_MANIFEST_INVALID");
  }
  return files;
}

function installedModes(releaseManifest) {
  const paths = Object.keys(managedFiles(releaseManifest));
  return Object.freeze({
    review: paths.some((path) => /codekeeper-(?:runtime-)?review\.ya?ml$/i.test(path)),
    issues: paths.some((path) => /codekeeper-(?:runtime-)?issues\.ya?ml$/i.test(path)),
    maintain: paths.some((path) => /codekeeper-(?:runtime-)?maintain\.ya?ml$/i.test(path)),
    fix: paths.some((path) => /codekeeper-(?:runtime-)?fix\.ya?ml$/i.test(path))
  });
}

export function requiredRecoverySecrets(policy, releaseManifest) {
  if (!policy?.ai?.agents || typeof policy.ai.agents !== "object") {
    fail("The recovery branch has no valid Codekeeper policy.", "RECOVERY_POLICY_INVALID");
  }
  const names = new Set(REQUIRED_BASE_SECRETS);
  for (const agent of Object.values(policy.ai.agents)) {
    if (!agent || typeof agent !== "object") continue;
    const provider = String(agent.provider ?? "");
    if (PROVIDER_SECRETS[provider]) names.add(PROVIDER_SECRETS[provider]);
    if (agent.workspace?.enabled === true) names.add("OPENAI_API_KEY");
  }
  if (policy.ai.tracing?.enabled === true) names.add("OPENAI_TRACE_API_KEY");
  if (!Object.values(installedModes(releaseManifest)).some(Boolean)) {
    fail("The recovery branch does not contain a supported Codekeeper workflow.", "RECOVERY_MANIFEST_INVALID");
  }
  return Object.freeze([...names].sort());
}

export function requiredRecoveryVariables(policy, releaseManifest) {
  const names = new Set(REQUIRED_BASE_VARIABLES);
  const modes = installedModes(releaseManifest);
  if (modes.review || policy?.automation?.ownerRequests === true) {
    names.add("CODEKEEPER_AUTOMATION_BOT_LOGIN");
  }
  return Object.freeze([...names].sort());
}

function namesFromGitHubList(value, label) {
  const parsed = parseJson(value, label);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry?.name !== "string")) {
    fail(`${label} is malformed.`, "RECOVERY_INVALID_RESPONSE");
  }
  return new Set(parsed.map((entry) => entry.name));
}

function parsePulls(value, branch, defaultBranch, remoteSha) {
  const pulls = parseJson(value, "GitHub pull-request response");
  if (!Array.isArray(pulls)) fail("GitHub returned an invalid pull-request list.", "RECOVERY_INVALID_RESPONSE");
  const matching = pulls.filter((pull) => pull?.headRefName === branch);
  if (matching.length > 1) fail(`More than one open pull request uses ${branch}.`, "RECOVERY_AMBIGUOUS");
  const pull = matching[0] ?? null;
  if (pull) {
    if (pull.baseRefName !== defaultBranch || pull.headRefOid !== remoteSha) {
      fail("The existing recovery pull request does not match the current branch tip and default branch.", "RECOVERY_STALE");
    }
    if (typeof pull.url !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(pull.url)) {
      fail("GitHub returned an invalid recovery pull-request URL.", "RECOVERY_INVALID_RESPONSE");
    }
  }
  return pull;
}

function recoveryTitle(branch) {
  return branch === "codekeeper/setup"
    ? "chore(codekeeper): add setup"
    : "chore(codekeeper): update installation";
}

function recoveryBody(branch, sha) {
  return [
    "## Codekeeper recovery",
    "",
    `This pull request resumes the already-pushed \`${branch}\` branch at \`${sha}\`.`,
    "",
    "No workflow was merged or executed by the recovery command. Review the generated policy, workflows, release receipt, model assignments, validation commands, and GitHub App authority before merging.",
    "",
    "Secrets are never read back from GitHub. Any missing secret remains an explicit manual action."
  ].join("\n");
}

export async function inspectRecoveryState({
  runner,
  cwd = process.cwd(),
  branch = null,
  apply = false
} = {}) {
  if (!runner || typeof runner.run !== "function") throw new TypeError("A command runner is required.");
  const root = await checked(runner, "git", ["rev-parse", "--show-toplevel"], { cwd }, "Run Codekeeper resume inside a Git checkout.");
  const originUrl = await checked(runner, "git", ["remote", "get-url", "origin"], { cwd: root }, "An origin remote is required.");
  const repository = parseGitHubRepository(originUrl);
  const repositoryData = parseJson(
    await checked(runner, "gh", ["api", "--hostname", "github.com", `repos/${repository}`], { cwd: root }, "Could not read the GitHub repository."),
    "GitHub repository response"
  );
  if (repositoryData?.permissions?.admin !== true) fail("Repository admin access is required to resume setup.", "ADMIN_REQUIRED");
  const defaultBranch = repositoryData?.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) fail("GitHub returned no default branch.", "RECOVERY_INVALID_RESPONSE");

  const candidates = parseRecoveryBranches(
    await checked(
      runner,
      "git",
      ["ls-remote", "--heads", "origin", "refs/heads/codekeeper/setup", "refs/heads/codekeeper/update-*"],
      { cwd: root },
      "Could not inspect remote Codekeeper recovery branches."
    )
  );
  const selected = branch
    ? candidates.find((entry) => entry.branch === branch)
    : candidates.length === 1
      ? candidates[0]
      : null;
  if (!selected) {
    if (branch) fail(`Remote branch ${branch} does not exist.`, "RECOVERY_BRANCH_MISSING");
    if (!candidates.length) fail("No pushed Codekeeper setup or update branch can be resumed.", "RECOVERY_BRANCH_MISSING");
    fail("More than one Codekeeper setup or update branch exists. Pass --branch explicitly.", "RECOVERY_AMBIGUOUS");
  }

  await checked(
    runner,
    "git",
    ["fetch", "--no-tags", "origin", `refs/heads/${selected.branch}`],
    { cwd: root },
    `Could not fetch ${selected.branch}.`
  );
  const fetchedSha = await checked(runner, "git", ["rev-parse", "FETCH_HEAD"], { cwd: root }, "Could not resolve the fetched recovery branch.");
  if (fetchedSha !== selected.sha) fail("The recovery branch moved while it was inspected.", "RECOVERY_STALE");

  const policy = parseJson(
    await checked(runner, "git", ["show", `${fetchedSha}:.github/codekeeper.json`], { cwd: root }, "The recovery branch has no readable Codekeeper policy."),
    "Codekeeper policy"
  );
  const releaseManifest = parseJson(
    await checked(runner, "git", ["show", `${fetchedSha}:.github/codekeeper-release.json`], { cwd: root }, "The recovery branch has no readable release manifest."),
    "Codekeeper release manifest"
  );

  const requiredSecrets = requiredRecoverySecrets(policy, releaseManifest);
  const requiredVariables = requiredRecoveryVariables(policy, releaseManifest);
  const presentSecrets = namesFromGitHubList(
    await checked(runner, "gh", ["secret", "list", "--app", "actions", "--repo", repository, "--json", "name"], { cwd: root }, "Could not inspect repository secret names."),
    "GitHub secret response"
  );
  const variablesSource = await checked(
    runner,
    "gh",
    ["variable", "list", "--repo", repository, "--json", "name,value"],
    { cwd: root },
    "Could not inspect repository variables."
  );
  const variables = parseJson(variablesSource, "GitHub variable response");
  if (!Array.isArray(variables) || variables.some((entry) => typeof entry?.name !== "string" || typeof entry?.value !== "string")) {
    fail("GitHub returned an invalid variable list.", "RECOVERY_INVALID_RESPONSE");
  }
  const presentVariables = new Map(variables.map((entry) => [entry.name, entry.value]));
  const pullsSource = await checked(
    runner,
    "gh",
    ["pr", "list", "--repo", repository, "--state", "open", "--json", "number,url,headRefName,baseRefName,headRefOid,title"],
    { cwd: root },
    "Could not inspect open pull requests."
  );
  let pull = parsePulls(pullsSource, selected.branch, defaultBranch, selected.sha);

  const actions = [];
  if (!presentVariables.has("CODEKEEPER_ENABLED")) {
    actions.push("set CODEKEEPER_ENABLED=false");
    if (apply) {
      await checked(
        runner,
        "gh",
        ["variable", "set", "CODEKEEPER_ENABLED", "--body", "false", "--repo", repository],
        { cwd: root },
        "Could not set the safe startup variable."
      );
      presentVariables.set("CODEKEEPER_ENABLED", "false");
    }
  }
  if (!pull) {
    actions.push("create setup or update pull request");
    if (apply) {
      const url = await checked(
        runner,
        "gh",
        [
          "pr", "create",
          "--repo", repository,
          "--base", defaultBranch,
          "--head", selected.branch,
          "--title", recoveryTitle(selected.branch),
          "--body", recoveryBody(selected.branch, selected.sha)
        ],
        { cwd: root },
        "The recovery branch exists, but GitHub did not create its pull request."
      );
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(url)) {
        fail("GitHub returned an invalid recovery pull-request URL.", "RECOVERY_INVALID_RESPONSE");
      }
      pull = Object.freeze({ url, headRefName: selected.branch, baseRefName: defaultBranch, headRefOid: selected.sha });
    }
  }

  const missingSecrets = requiredSecrets.filter((name) => !presentSecrets.has(name));
  const missingVariables = requiredVariables.filter((name) => !presentVariables.has(name));
  const invalidVariables = [];
  const clientId = presentVariables.get("CODEKEEPER_APP_CLIENT_ID");
  if (clientId !== undefined && !/^Iv(?:1\.)?[A-Za-z0-9]{16,253}$/.test(clientId)) invalidVariables.push("CODEKEEPER_APP_CLIENT_ID");
  const bot = presentVariables.get("CODEKEEPER_AUTOMATION_BOT_LOGIN");
  if (bot !== undefined && !LOGIN.test(bot)) invalidVariables.push("CODEKEEPER_AUTOMATION_BOT_LOGIN");
  const enabled = presentVariables.get("CODEKEEPER_ENABLED");
  if (enabled !== undefined && !["true", "false"].includes(enabled)) invalidVariables.push("CODEKEEPER_ENABLED");

  const ready = Boolean(pull) && missingSecrets.length === 0 && missingVariables.length === 0 && invalidVariables.length === 0;
  return Object.freeze({
    version: 1,
    repository,
    defaultBranch,
    branch: selected.branch,
    remoteSha: selected.sha,
    pullRequestUrl: pull?.url ?? null,
    requiredSecrets,
    missingSecrets: Object.freeze(missingSecrets),
    requiredVariables,
    missingVariables: Object.freeze(missingVariables),
    invalidVariables: Object.freeze(invalidVariables),
    actions: Object.freeze(actions),
    applied: apply,
    ready
  });
}

function printRecovery(report, output) {
  output.write("\nCodekeeper recovery\n");
  output.write(`  Repository: ${report.repository}\n`);
  output.write(`  Branch: ${report.branch} @ ${report.remoteSha}\n`);
  output.write(`  Pull request: ${report.pullRequestUrl ?? "missing"}\n`);
  output.write(`  Missing secrets: ${report.missingSecrets.join(", ") || "none"}\n`);
  output.write(`  Missing variables: ${report.missingVariables.join(", ") || "none"}\n`);
  output.write(`  Invalid variables: ${report.invalidVariables.join(", ") || "none"}\n`);
  if (report.missingSecrets.length) {
    output.write("  Re-enter missing secrets with GitHub CLI; Codekeeper cannot read secret values back.\n");
  }
  output.write(`  Status: ${report.ready ? "ready for review" : "recovery actions remain"}\n`);
}

export async function runRecoveryCli({
  argv = process.argv.slice(3),
  cwd = process.cwd(),
  runner,
  output = process.stdout,
  errorOutput = process.stderr
} = {}) {
  try {
    const options = parseRecoveryArgs(argv);
    const report = await inspectRecoveryState({ runner, cwd, ...options });
    if (options.json) output.write(`${JSON.stringify(report)}\n`);
    else printRecovery(report, output);
    return report.ready ? 0 : 1;
  } catch (error) {
    errorOutput.write(`Codekeeper resume stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    return error?.code === "CLI_USAGE" ? 2 : 1;
  }
}

export function recoveryFingerprint(report) {
  return createHash("sha256")
    .update(JSON.stringify({
      repository: report.repository,
      branch: report.branch,
      remoteSha: report.remoteSha,
      pullRequestUrl: report.pullRequestUrl,
      missingSecrets: report.missingSecrets,
      missingVariables: report.missingVariables,
      invalidVariables: report.invalidVariables
    }))
    .digest("hex");
}
