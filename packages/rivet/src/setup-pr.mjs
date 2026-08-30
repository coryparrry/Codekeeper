import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  applyReviewInstallation,
  prepareReviewInstallation,
} from "./install.mjs";

const execFileAsync = promisify(execFile);
const PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

async function runCommand(command, args, { cwd }) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function assertExactPaths(actual, expected) {
  const actualPaths = actual.split("\0").filter(Boolean).sort();
  const expectedPaths = [...expected].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      "Rivet installer: staged files do not match the install plan",
    );
  }
}

function pullRequestBody(plan) {
  const files = plan.files.map(({ path }) => `- \`${path}\``).join("\n");
  const authority = plan.productAuthority.map((line) => `- ${line}`).join("\n");
  return `## Summary

This draft installs Rivet's review-only workflow. Repair, issue implementation, maintenance, and merge authority remain disabled.

## Product authority

${authority}

## Managed files

${files}

Rivet created this pull request but will never merge it automatically.`;
}

export async function createReviewSetupPullRequest({
  branch = "rivet/setup-review",
  run = runCommand,
  ...installOptions
} = {}) {
  const plan = await prepareReviewInstallation(installOptions);
  const cwd = plan.repositoryRoot;
  const paths = plan.files.map(({ path }) => path);

  await run("git", ["check-ref-format", "--branch", branch], { cwd });
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd },
  );
  if (status) {
    throw new Error("Rivet installer: repository working tree must be clean");
  }

  const repositoryDetails = JSON.parse(
    await run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      { cwd },
    ),
  );
  const repository = repositoryDetails.nameWithOwner;
  const defaultBranch = repositoryDetails.defaultBranchRef?.name;
  if (!repository || !defaultBranch) {
    throw new Error("Rivet installer: could not resolve the GitHub repository");
  }

  await run("git", ["fetch", "origin", defaultBranch], { cwd });
  const head = await run("git", ["rev-parse", "HEAD"], { cwd });
  const base = await run(
    "git",
    ["rev-parse", `refs/remotes/origin/${defaultBranch}`],
    { cwd },
  );
  if (head !== base) {
    throw new Error(
      `Rivet installer: HEAD must match origin/${defaultBranch} before setup`,
    );
  }

  const localBranch = await run("git", ["branch", "--list", branch], { cwd });
  const remoteBranch = await run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd },
  );
  if (localBranch || remoteBranch) {
    throw new Error(`Rivet installer: setup branch already exists: ${branch}`);
  }

  await run("git", ["switch", "-c", branch, base], { cwd });
  await applyReviewInstallation(plan);
  await run("git", ["add", "--", ...paths], { cwd });
  assertExactPaths(
    await run("git", ["diff", "--cached", "--name-only", "-z"], { cwd }),
    paths,
  );
  await run("git", ["diff", "--cached", "--check"], { cwd });
  await run(
    "git",
    ["commit", "--only", "-m", "chore: set up Rivet review", "--", ...paths],
    { cwd },
  );

  const parent = await run("git", ["rev-parse", "HEAD^"], { cwd });
  if (parent !== base) {
    throw new Error("Rivet installer: setup commit has an unexpected parent");
  }
  const commit = await run("git", ["rev-parse", "HEAD"], { cwd });
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Rivet installer: setup commit is not a full Git SHA");
  }

  await run(
    "git",
    [
      "push",
      `--force-with-lease=refs/heads/${branch}:`,
      "origin",
      `${commit}:refs/heads/${branch}`,
    ],
    { cwd },
  );
  const pushedBranch = await run(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    { cwd },
  );
  if (pushedBranch.split(/\s+/)[0] !== commit) {
    throw new Error(
      "Rivet installer: pushed setup branch does not match the setup commit",
    );
  }
  const pullRequestUrl = await run(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      defaultBranch,
      "--head",
      branch,
      "--draft",
      "--title",
      "chore: set up Rivet review",
      "--body",
      pullRequestBody(plan),
    ],
    { cwd },
  );
  if (!PULL_REQUEST_URL.test(pullRequestUrl)) {
    throw new Error(
      "Rivet installer: GitHub returned an invalid pull-request URL",
    );
  }
  const pullRequest = JSON.parse(
    await run(
      "gh",
      [
        "pr",
        "view",
        pullRequestUrl,
        "--json",
        "baseRefName,headRefName,headRefOid,isDraft,state,url",
      ],
      { cwd },
    ),
  );
  if (
    pullRequest.url !== pullRequestUrl ||
    pullRequest.baseRefName !== defaultBranch ||
    pullRequest.headRefName !== branch ||
    pullRequest.headRefOid !== commit ||
    pullRequest.isDraft !== true ||
    pullRequest.state !== "OPEN"
  ) {
    throw new Error(
      "Rivet installer: setup pull request does not match the verified plan",
    );
  }

  return Object.freeze({
    repository,
    defaultBranch,
    branch,
    commit,
    pullRequestUrl,
  });
}
