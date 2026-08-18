import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { InstallerError } from "./errors.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const RELEASE_MANIFEST = ".github/codekeeper-release.json";
const CLEANUP_SECRETS = Object.freeze([
  "CODEKEEPER_APP_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_TRACE_API_KEY"
]);
const CLEANUP_VARIABLES = Object.freeze([
  "CODEKEEPER_ENABLED",
  "CODEKEEPER_APP_CLIENT_ID",
  "CODEKEEPER_AUTOMATION_BOT_LOGIN"
]);

function fail(message, code = "REMOVAL_INVALID") {
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
    fail(message, "REMOVAL_COMMAND_FAILED");
  }
  return result.stdout.trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new InstallerError(`${label} is not valid JSON.`, {
      code: "REMOVAL_INVALID_RESPONSE",
      cause
    });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseRemovalArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const options = { apply: false, json: false };
  for (const value of argv) {
    if (value === "--apply") options.apply = true;
    else if (value === "--json") options.json = true;
    else fail(`Unsupported remove option: ${value}`, "CLI_USAGE");
  }
  return Object.freeze(options);
}

export function assertSafeManagedPath(value) {
  if (typeof value !== "string" || !value || value.length > 500 || path.posix.isAbsolute(value)) {
    fail("The release manifest contains an unsafe managed path.", "REMOVAL_MANIFEST_INVALID");
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || /[\u0000-\u001f\u007f]/.test(part))
  ) {
    fail(`The release manifest contains an unsafe managed path: ${value}`, "REMOVAL_MANIFEST_INVALID");
  }
  return value;
}

export function removalFileEntries(releaseManifest) {
  const managed = releaseManifest?.managedFiles;
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
    fail("The installed release manifest has no managed-file inventory.", "REMOVAL_MANIFEST_INVALID");
  }
  const entries = Object.entries(managed).map(([filePath, digest]) => {
    assertSafeManagedPath(filePath);
    if (typeof digest !== "string" || !DIGEST.test(digest)) {
      fail(`The installed release manifest has an invalid digest for ${filePath}.`, "REMOVAL_MANIFEST_INVALID");
    }
    return Object.freeze({ path: filePath, sha256: digest });
  });
  if (!entries.length || new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    fail("The installed release manifest has an empty or duplicate managed-file inventory.", "REMOVAL_MANIFEST_INVALID");
  }
  if (!entries.some((entry) => entry.path === ".github/codekeeper.json")) {
    fail("The installed release manifest does not own the Codekeeper policy.", "REMOVAL_MANIFEST_INVALID");
  }
  if (!entries.some((entry) => entry.path.startsWith(".github/workflows/"))) {
    fail("The installed release manifest does not own any Codekeeper workflow.", "REMOVAL_MANIFEST_INVALID");
  }
  return Object.freeze([
    ...entries,
    Object.freeze({ path: RELEASE_MANIFEST, sha256: null })
  ].sort((left, right) => left.path.localeCompare(right.path)));
}

function parseGitHubRepository(originUrl) {
  const source = String(originUrl ?? "").trim();
  const match =
    source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    source.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    source.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) fail("origin must be a GitHub.com repository.", "UNSUPPORTED_REPOSITORY");
  return `${match[1]}/${match[2]}`;
}

function parseRemoteBranchSha(output, defaultBranch) {
  const lines = String(output ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) fail("origin did not return exactly one default-branch tip.", "REMOVAL_STALE");
  const [sha, ref, ...extra] = lines[0].split(/\s+/);
  if (!FULL_SHA.test(sha) || ref !== `refs/heads/${defaultBranch}` || extra.length) {
    fail("origin returned an invalid default-branch tip.", "REMOVAL_STALE");
  }
  return sha;
}

async function verifyManagedFiles(root, entries, fsImpl) {
  for (const entry of entries) {
    const target = path.join(root, ...entry.path.split("/"));
    let stat;
    try {
      stat = await fsImpl.lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") fail(`Managed Codekeeper file is missing: ${entry.path}`, "REMOVAL_INSTALLATION_CHANGED");
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`Managed Codekeeper path is not a regular file: ${entry.path}`, "REMOVAL_INSTALLATION_CHANGED");
    }
    const contents = await fsImpl.readFile(target);
    if (entry.sha256 && sha256(contents) !== entry.sha256) {
      fail(`Managed Codekeeper file changed since installation: ${entry.path}`, "REMOVAL_INSTALLATION_CHANGED");
    }
  }
}

async function ensureRemovalBranchAvailable(runner, root, repository, branch) {
  const local = await checked(
    runner,
    "git",
    ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`],
    { cwd: root },
    "Could not inspect local removal refs."
  );
  if (local) fail(`Removal branch ${branch} already exists locally.`, "REMOVAL_BRANCH_EXISTS");
  const remote = await checked(
    runner,
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd: root },
    "Could not inspect the remote removal branch."
  );
  if (remote) fail(`Removal branch ${branch} already exists on origin.`, "REMOVAL_BRANCH_EXISTS");
  const pulls = parseJson(
    await checked(
      runner,
      "gh",
      ["pr", "list", "--repo", repository, "--state", "open", "--head", branch, "--json", "number,url"],
      { cwd: root },
      "Could not inspect removal pull requests."
    ),
    "GitHub removal pull-request response"
  );
  if (!Array.isArray(pulls)) fail("GitHub returned an invalid removal pull-request list.", "REMOVAL_INVALID_RESPONSE");
  if (pulls.length) fail(`An open removal pull request already exists for ${branch}.`, "REMOVAL_BRANCH_EXISTS");
}

export async function buildRemovalPlan({
  runner,
  cwd = process.cwd(),
  fsImpl = { lstat, readFile }
} = {}) {
  if (!runner || typeof runner.run !== "function") throw new TypeError("A command runner is required.");
  const root = await checked(runner, "git", ["rev-parse", "--show-toplevel"], { cwd }, "Run Codekeeper remove inside a Git checkout.");
  const originUrl = await checked(runner, "git", ["remote", "get-url", "origin"], { cwd: root }, "An origin remote is required.");
  const repository = parseGitHubRepository(originUrl);
  const repositoryData = parseJson(
    await checked(runner, "gh", ["api", "--hostname", "github.com", `repos/${repository}`], { cwd: root }, "Could not read the GitHub repository."),
    "GitHub repository response"
  );
  if (repositoryData?.permissions?.admin !== true) fail("Repository admin access is required to remove Codekeeper.", "ADMIN_REQUIRED");
  const defaultBranch = repositoryData?.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch) fail("GitHub returned no default branch.", "REMOVAL_INVALID_RESPONSE");
  const currentBranch = await checked(runner, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }, "A default-branch checkout is required.");
  if (currentBranch !== defaultBranch) fail(`Check out ${defaultBranch} before removing Codekeeper.`, "WRONG_BRANCH");
  const status = await checked(
    runner,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
    "Could not inspect Git status."
  );
  if (status) fail("The Git checkout must be clean, including untracked files.", "DIRTY_CHECKOUT");
  const headSha = await checked(runner, "git", ["rev-parse", "HEAD"], { cwd: root }, "Could not read HEAD.");
  if (!FULL_SHA.test(headSha)) fail("Git returned an invalid HEAD commit.", "REMOVAL_STALE");
  const remoteSha = parseRemoteBranchSha(
    await checked(
      runner,
      "git",
      ["ls-remote", "origin", `refs/heads/${defaultBranch}`],
      { cwd: root },
      "Could not read the remote default branch."
    ),
    defaultBranch
  );
  if (headSha !== remoteSha) fail("HEAD must exactly match the remote default branch before removal.", "REMOVAL_STALE");

  const manifestSource = await fsImpl.readFile(path.join(root, RELEASE_MANIFEST), "utf8").catch((error) => {
    if (error?.code === "ENOENT") fail("No installed Codekeeper release manifest was found.", "REMOVAL_NOT_INSTALLED");
    throw error;
  });
  const releaseManifest = parseJson(manifestSource, "Installed Codekeeper release manifest");
  const files = removalFileEntries(releaseManifest);
  await verifyManagedFiles(root, files, fsImpl);
  const branch = `codekeeper/remove-${headSha.slice(0, 12)}`;
  await ensureRemovalBranchAvailable(runner, root, repository, branch);

  return Object.freeze({
    version: 1,
    root,
    repository,
    defaultBranch,
    originalHead: headSha,
    branch,
    files,
    cleanup: Object.freeze({
      secrets: CLEANUP_SECRETS,
      variables: CLEANUP_VARIABLES,
      appInstallation: "Remove the adopter-owned GitHub App installation manually after the removal pull request merges."
    })
  });
}

function exactPaths(output, expected) {
  const actual = String(output ?? "").split("\0").filter(Boolean).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
    fail("The removal commit contains paths outside the verified Codekeeper inventory.", "REMOVAL_UNRELATED_PATH");
  }
}

function removalBody(plan) {
  return [
    "## Outcome",
    "",
    "- remove only files owned by the installed Codekeeper release manifest",
    "- disable Codekeeper before the removal pull request is opened",
    "- preserve repository secrets, variables, labels, and the adopter-owned GitHub App for explicit cleanup after merge",
    "",
    "## Safety",
    "",
    `The removal was prepared from \`${plan.originalHead}\`. Every managed file matched its recorded SHA-256 before deletion. This command did not merge the pull request.`,
    "",
    "After merge, review the printed cleanup list before deleting any repository setting or App installation."
  ].join("\n");
}

export async function applyRemovalPlan(plan, { runner } = {}) {
  if (!plan || !runner || typeof runner.run !== "function") throw new TypeError("A removal plan and command runner are required.");
  const paths = plan.files.map((entry) => entry.path);
  await checked(
    runner,
    "gh",
    ["variable", "set", "CODEKEEPER_ENABLED", "--body", "false", "--repo", plan.repository],
    { cwd: plan.root },
    "Could not disable Codekeeper before removal."
  );
  await checked(runner, "git", ["switch", "-c", plan.branch], { cwd: plan.root }, `Could not create ${plan.branch}.`);
  try {
    await checked(runner, "git", ["rm", "--", ...paths], { cwd: plan.root }, "Could not stage the verified Codekeeper file removals.");
    const staged = await checked(
      runner,
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      { cwd: plan.root },
      "Could not inspect staged removal paths."
    );
    exactPaths(staged, paths);
    await checked(runner, "git", ["diff", "--cached", "--check"], { cwd: plan.root }, "The staged removal fails git diff --check.");
    await checked(
      runner,
      "git",
      ["commit", "--only", "-m", "chore(codekeeper): remove installation", "--", ...paths],
      { cwd: plan.root },
      "Could not create the Codekeeper removal commit."
    );
    const parent = await checked(runner, "git", ["rev-parse", "HEAD^"], { cwd: plan.root }, "Could not verify the removal commit parent.");
    if (parent !== plan.originalHead) fail("The removal commit no longer descends directly from the reviewed default-branch head.", "REMOVAL_STALE");
    const committed = await checked(
      runner,
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"],
      { cwd: plan.root },
      "Could not inspect the removal commit."
    );
    exactPaths(committed, paths);
    const commit = await checked(runner, "git", ["rev-parse", "HEAD"], { cwd: plan.root }, "Could not read the removal commit.");
    if (!FULL_SHA.test(commit)) fail("Git returned an invalid removal commit.", "REMOVAL_STALE");
    await checked(
      runner,
      "git",
      ["push", "origin", `${commit}:refs/heads/${plan.branch}`],
      { cwd: plan.root },
      "The removal commit was created locally, but the push failed."
    );
    const url = await checked(
      runner,
      "gh",
      [
        "pr", "create",
        "--repo", plan.repository,
        "--base", plan.defaultBranch,
        "--head", plan.branch,
        "--title", "chore(codekeeper): remove installation",
        "--body", removalBody(plan)
      ],
      { cwd: plan.root },
      "The removal branch was pushed, but GitHub did not create the pull request."
    );
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(url)) {
      fail("GitHub returned an invalid removal pull-request URL.", "REMOVAL_INVALID_RESPONSE");
    }
    return Object.freeze({ ...plan, commit, pullRequestUrl: url, applied: true });
  } catch (error) {
    if (error instanceof InstallerError && !error.resume) {
      error.resume = `Inspect ${plan.branch}, then run: gh pr list --repo ${plan.repository} --state open --head ${plan.branch}`;
    }
    throw error;
  }
}

function printRemoval(plan, output) {
  output.write("\nCodekeeper removal plan\n");
  output.write(`  Repository: ${plan.repository}\n`);
  output.write(`  Base: ${plan.defaultBranch} @ ${plan.originalHead}\n`);
  output.write(`  Branch: ${plan.branch}\n`);
  output.write(`  Managed files to delete: ${plan.files.length}\n`);
  output.write("  Immediate setting change: CODEKEEPER_ENABLED=false\n");
  output.write("  Preserved until explicit cleanup: repository secrets, variables, labels, and GitHub App installation\n");
  if (plan.pullRequestUrl) output.write(`  Pull request: ${plan.pullRequestUrl}\n`);
}

export async function runRemovalCli({
  argv = process.argv.slice(3),
  cwd = process.cwd(),
  runner,
  output = process.stdout,
  errorOutput = process.stderr,
  fsImpl
} = {}) {
  try {
    const options = parseRemovalArgs(argv);
    let plan = await buildRemovalPlan({ runner, cwd, fsImpl });
    if (options.apply) plan = await applyRemovalPlan(plan, { runner });
    if (options.json) output.write(`${JSON.stringify(plan)}\n`);
    else printRemoval(plan, output);
    return 0;
  } catch (error) {
    errorOutput.write(`Codekeeper remove stopped: ${error instanceof Error ? error.message : String(error)}${error?.resume ? `\nResume: ${error.resume}` : ""}\n`);
    return error?.code === "CLI_USAGE" ? 2 : 1;
  }
}
