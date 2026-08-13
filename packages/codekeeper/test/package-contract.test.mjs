import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SOURCE_COMMIT } from "../src/constants.mjs";
import { git, REPOSITORY_ROOT, temporaryDirectory } from "./helpers.mjs";

const SOURCE_DEFAULT_BRANCH = "main";
const REVIEWED_SOURCE_CHECKPOINT = "cf9e0cabadb3bc638a42bfc21ed9db58b176ecb3";

function resolveDefaultBranchRef(repositoryRoot, defaultBranch) {
  const localRef = `refs/heads/${defaultBranch}`;
  if (git(repositoryRoot, ["for-each-ref", "--format=%(refname)", localRef]).trim() === localRef) {
    const upstreamRef = git(repositoryRoot, [
      "for-each-ref",
      "--format=%(upstream)",
      localRef,
    ]).trim();
    const upstreamBranchRef = git(repositoryRoot, [
      "for-each-ref",
      "--format=%(upstream:remoteref)",
      localRef,
    ]).trim();
    if (upstreamRef && upstreamBranchRef !== `refs/heads/${defaultBranch}`) {
      throw new Error(`${localRef} tracks ${upstreamBranchRef}, not refs/heads/${defaultBranch}`);
    }
    if (
      upstreamRef &&
      git(repositoryRoot, [
        "for-each-ref",
        "--format=%(refname)",
        upstreamRef,
      ]).trim() === upstreamRef
    ) {
      return upstreamRef;
    }
    return localRef;
  }
  const remoteRefs = git(repositoryRoot, [
    "for-each-ref", "--format=%(refname)", `refs/remotes/*/${defaultBranch}`
  ]).trim().split("\n").filter(Boolean);
  if (remoteRefs.length !== 1) {
    throw new Error(`Expected one local or remote-tracking ref for ${defaultBranch}; found ${remoteRefs.length}`);
  }
  return remoteRefs[0];
}

test("installer checks include hardening audit tests", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /node --test test\/\*\.test\.mjs audit\/\*\.test\.mjs/);
  assert.match(packageJson.scripts.check, /audit\/\*\.mjs/);
  assert.match(packageJson.scripts.check, /node --test test\/\*\.test\.mjs audit\/\*\.test\.mjs/);
});

test("installer source pin is a full reviewed checkpoint reachable from the repository default branch", () => {
  assert.match(SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(SOURCE_COMMIT, REVIEWED_SOURCE_CHECKPOINT);
  const defaultBranchRef = resolveDefaultBranchRef(REPOSITORY_ROOT, SOURCE_DEFAULT_BRANCH);
  git(REPOSITORY_ROOT, ["merge-base", "--is-ancestor", SOURCE_COMMIT, defaultBranchRef]);
});

test("source-pin ancestry accepts local and renamed-remote default-branch refs", async (t) => {
  const repositoryRoot = await temporaryDirectory(t, "codekeeper-source-pin-ref-");
  git(repositoryRoot, ["init", "--initial-branch=trunk"]);
  git(repositoryRoot, ["config", "user.name", "Codekeeper Test"]);
  git(repositoryRoot, ["config", "user.email", "codekeeper-test@example.invalid"]);
  git(repositoryRoot, ["commit", "--allow-empty", "-m", "initial"]);
  const commit = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  assert.equal(resolveDefaultBranchRef(repositoryRoot, "trunk"), "refs/heads/trunk");

  git(repositoryRoot, ["remote", "add", "upstream", "."]);
  git(repositoryRoot, ["update-ref", "refs/remotes/upstream/release", commit]);
  git(repositoryRoot, ["config", "branch.trunk.remote", "upstream"]);
  git(repositoryRoot, ["config", "branch.trunk.merge", "refs/heads/release"]);
  assert.throws(() => resolveDefaultBranchRef(repositoryRoot, "trunk"), /tracks refs\/heads\/release/);
  git(repositoryRoot, ["config", "--unset", "branch.trunk.remote"]);
  git(repositoryRoot, ["config", "--unset", "branch.trunk.merge"]);

  git(repositoryRoot, ["update-ref", "refs/remotes/upstream/trunk", commit]);
  git(repositoryRoot, ["checkout", "--detach", commit]);
  git(repositoryRoot, ["branch", "--delete", "--force", "trunk"]);
  assert.equal(resolveDefaultBranchRef(repositoryRoot, "trunk"), "refs/remotes/upstream/trunk");
  git(repositoryRoot, ["update-ref", "refs/remotes/mirror/trunk", commit]);
  assert.throws(() => resolveDefaultBranchRef(repositoryRoot, "trunk"), /found 2/);
});

test("source-pin ancestry prefers an updated renamed remote over stale local main", async (t) => {
  const sourceRoot = await temporaryDirectory(
    t,
    "codekeeper-source-pin-source-",
  );
  git(sourceRoot, ["init", "--initial-branch=main"]);
  git(sourceRoot, ["config", "user.name", "Codekeeper Test"]);
  git(sourceRoot, ["config", "user.email", "codekeeper-test@example.invalid"]);
  git(sourceRoot, ["commit", "--allow-empty", "-m", "initial"]);

  const repositoryRoot = await temporaryDirectory(
    t,
    "codekeeper-source-pin-clone-",
  );
  git(repositoryRoot, ["clone", sourceRoot, "."]);
  git(repositoryRoot, ["remote", "rename", "origin", "upstream"]);
  git(repositoryRoot, ["checkout", "-b", "feature"]);
  const staleLocalMain = git(repositoryRoot, [
    "rev-parse",
    "refs/heads/main",
  ]).trim();

  git(sourceRoot, ["commit", "--allow-empty", "-m", "reviewed checkpoint"]);
  const reviewedCheckpoint = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
  git(repositoryRoot, ["fetch", "upstream"]);

  assert.notEqual(staleLocalMain, reviewedCheckpoint);
  assert.equal(
    resolveDefaultBranchRef(repositoryRoot, "main"),
    "refs/remotes/upstream/main",
  );
  git(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    reviewedCheckpoint,
    resolveDefaultBranchRef(repositoryRoot, "main"),
  ]);
});
