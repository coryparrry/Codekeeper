import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { prepareReviewInstallation } from "../src/install.mjs";
import {
  createReviewSetupPullRequest,
  repositoryFromGitHubOrigin,
} from "../src/setup-pr.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function fixtureCompiler({ repositoryRoot }) {
  const source = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/review/.github/workflows/rivet-review.lock.yml",
    ),
    "utf8",
  );
  await writeFile(path.join(repositoryRoot, LOCK_PATH), source);
}

async function repository(t) {
  const container = await mkdtemp(
    path.join(os.tmpdir(), "rivet-setup-pr-test-"),
  );
  const root = path.join(container, "repository");
  const remote = path.join(container, "remote.git");
  t.after(() => rm(container, { recursive: true, force: true }));
  await git(container, ["init", "--bare", "--initial-branch=main", remote]);
  await git(container, ["init", "--initial-branch=main", root]);
  await git(root, ["config", "user.name", "Rivet Test"]);
  await git(root, ["config", "user.email", "rivet@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial fixture"]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);
  return { root, remote };
}

function runner(calls) {
  return async (command, args, { cwd }) => {
    calls.push([command, args]);
    if (command === "gh" && args[0] === "repo") {
      return JSON.stringify({
        nameWithOwner: "acme/example",
        defaultBranchRef: { name: "main" },
      });
    }
    if (command === "git" && args[0] === "remote") {
      return "https://github.com/acme/example.git";
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return "https://github.com/acme/example/pull/17";
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "view") {
      return JSON.stringify({
        baseRefName: "main",
        headRefName: "rivet/setup-test",
        headRefOid: await git(cwd, ["rev-parse", "HEAD"]),
        isDraft: true,
        state: "OPEN",
        url: "https://github.com/acme/example/pull/17",
      });
    }
    return git(cwd, args);
  };
}

test("accepts only exact github.com origin identities", () => {
  for (const remote of [
    "https://github.com/acme/example.git",
    "ssh://git@github.com/acme/example.git",
    "git@github.com:acme/example.git",
  ]) {
    assert.equal(repositoryFromGitHubOrigin(remote), "acme/example");
  }
  for (const remote of [
    "https://github.example/acme/example.git",
    "https://token@github.com/acme/example.git",
    "git@github.com:acme/../example.git",
    "/tmp/example.git",
  ]) {
    assert.throws(
      () => repositoryFromGitHubOrigin(remote),
      /origin must be an exact github\.com repository URL/,
    );
  }
});

test("creates a verified draft setup pull request without merging", async (t) => {
  const { root, remote } = await repository(t);
  const calls = [];
  const result = await createReviewSetupPullRequest({
    repositoryRoot: root,
    branch: "rivet/setup-test",
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
    run: runner(calls),
  });

  assert.equal(result.repository, "acme/example");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.branch, "rivet/setup-test");
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.equal(
    result.pullRequestUrl,
    "https://github.com/acme/example/pull/17",
  );
  assert.equal(
    await git(root, ["branch", "--show-current"]),
    "rivet/setup-test",
  );
  assert.equal(
    await git(root, ["rev-parse", "HEAD^"]),
    await git(root, ["rev-parse", "origin/main"]),
  );
  assert.equal(
    await git(remote, ["rev-parse", "refs/heads/rivet/setup-test"]),
    result.commit,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(root, ".github/rivet.json"), "utf8"))
      .repair.authority,
    "never",
  );

  const pullRequestCall = calls.find(
    ([command, args]) =>
      command === "gh" && args[0] === "pr" && args[1] === "create",
  );
  assert.ok(pullRequestCall[1].includes("--draft"));
  assert.ok(!pullRequestCall[1].includes("merge"));
  assert.match(
    pullRequestCall[1][pullRequestCall[1].indexOf("--body") + 1],
    /Merge is impossible/,
  );
});

test("reuses a prepared review plan without compiling it again", async (t) => {
  const { root } = await repository(t);
  let compileCalls = 0;
  const preparedPlan = await prepareReviewInstallation({
    repositoryRoot: root,
    compileWorkflow: async (options) => {
      compileCalls += 1;
      await fixtureCompiler(options);
    },
    validateWorkflow: async () => {},
  });

  const result = await createReviewSetupPullRequest({
    preparedPlan,
    branch: "rivet/setup-test",
    compileWorkflow: async () => {
      throw new Error("prepared plan should not be compiled again");
    },
    validateWorkflow: async () => {},
    run: runner([]),
  });

  assert.equal(compileCalls, 1);
  assert.equal(result.branch, "rivet/setup-test");
});

test("refuses setup from a dirty repository before creating a branch", async (t) => {
  const { root } = await repository(t);
  await writeFile(path.join(root, "untracked.txt"), "keep me\n");
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner([]),
    }),
    /working tree must be clean/,
  );
  assert.equal(await git(root, ["branch", "--show-current"]), "main");
  assert.equal(
    await readFile(path.join(root, "untracked.txt"), "utf8"),
    "keep me\n",
  );
});

test("refuses setup when the branch already exists", async (t) => {
  const { root } = await repository(t);
  await git(root, ["branch", "rivet/setup-review"]);
  await assert.rejects(
    createReviewSetupPullRequest({
      repositoryRoot: root,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
      run: runner([]),
    }),
    /setup branch already exists/,
  );
  assert.equal(await git(root, ["branch", "--show-current"]), "main");
});
