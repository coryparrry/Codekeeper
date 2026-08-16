import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { SOURCE_COMMIT } from "../src/constants.mjs";
import { git, REPOSITORY_ROOT, temporaryDirectory } from "./helpers.mjs";

const SOURCE_DEFAULT_BRANCH = "main";
const REVIEWED_SOURCE_CHECKPOINT = "1b82427f34568795ba15b2f207041c6863102112";
const PRODUCTION_SOURCE_PATHS = [
  "tools/codekeeper",
  ".github/workflows/codekeeper-assistant.yml",
  ".github/workflows/codekeeper-fix.yml",
  ".github/workflows/codekeeper-issues.yml",
  ".github/workflows/codekeeper-maintain.yml",
  ".github/workflows/codekeeper-review.yml",
];

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
  assert.match(packageJson.scripts.test, /npm run prepare:runtime-test/);
  assert.match(packageJson.scripts.test, /npm run test:unit/);
  assert.match(packageJson.scripts["test:unit"], /node --test test\/\*\.test\.mjs audit\/\*\.test\.mjs/);
  assert.match(packageJson.scripts.check, /audit\/\*\.mjs/);
  assert.match(packageJson.scripts.check, /npm run prepare:runtime-test/);
  assert.match(packageJson.scripts.check, /npm run test:unit/);
});

test("root private-tarball instructions use the exact npm pack receipt", async () => {
  const installGuide = await readFile(new URL("../../../INSTALL.md", import.meta.url), "utf8");
  const packageReadme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const rootTarballCommands = installGuide.match(/```bash\n(.*?)\n```/s)?.[1] ?? "";
  assert.match(rootTarballCommands, /PACK_REPORT=.*npm pack --json --pack-destination/);
  assert.match(rootTarballCommands, /npm exec --package .*-- codekeeper init --current-package --package-integrity "\$PACKAGE_INTEGRITY"/);
  assert.match(packageReadme, /codekeeper init --current-package --package-integrity 'sha512-\.\.\.'/);
  const extractionScripts = [...rootTarballCommands.matchAll(/node -e '\n([\s\S]*?)\n' "\$PACK_REPORT"/g)].map(([, script]) => script);
  assert.equal(extractionScripts.length, 2);
  const keyedReport = {
    "codekeeper-0.2.0.tgz": {
      filename: "codekeeper-0.2.0.tgz",
      integrity: "sha512-receipt"
    }
  };
  const directReport = keyedReport["codekeeper-0.2.0.tgz"];
  for (const validReport of [[directReport], directReport, keyedReport]) {
    for (const [index, expected] of ["codekeeper-0.2.0.tgz", "sha512-receipt"].entries()) {
      const result = spawnSync(process.execPath, ["-e", extractionScripts[index], JSON.stringify(validReport)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
    }
  }
  for (const invalidReport of [[], [keyedReport, keyedReport], {}, { filename: "missing-integrity.tgz", integrity: "sha256-wrong" }]) {
    for (const script of extractionScripts) {
      const result = spawnSync(process.execPath, ["-e", script, JSON.stringify(invalidReport)], { encoding: "utf8" });
      assert.notEqual(result.status, 0, JSON.stringify(invalidReport));
    }
  }
});

test("release packaging uses one deterministic tarball with separate installer and runtime shrinkwraps", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(rootPackage.scripts["package:stage"], "node scripts/build-codekeeper-package.mjs");
  assert.match(rootPackage.scripts["package:stage:check"], /package-stage\.test\.mjs/);
  assert.ok(packageManifest.files.includes("release/"));
  assert.ok(packageManifest.files.includes("runtime/"));
  assert.equal(packageManifest.bin["codekeeper-verify-package"], "bin/verify-package.mjs");
  assert.deepEqual(packageManifest.dependencies, { ink: "7.1.1", react: "19.2.8" });
  await access(new URL("../npm-shrinkwrap.json", import.meta.url));
  await access(new URL("../runtime-package/package.json", import.meta.url));
  await access(new URL("../runtime-package/npm-shrinkwrap.json", import.meta.url));
  await assert.rejects(access(new URL("../package-lock.json", import.meta.url)), /ENOENT/);
  await assert.rejects(access(new URL("../runtime-package/package-lock.json", import.meta.url)), /ENOENT/);
});

test("installer source pin is a full reviewed checkpoint reachable from the repository default branch", () => {
  assert.match(SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  assert.equal(SOURCE_COMMIT, REVIEWED_SOURCE_CHECKPOINT);
  const defaultBranchRef = resolveDefaultBranchRef(REPOSITORY_ROOT, SOURCE_DEFAULT_BRANCH);
  git(REPOSITORY_ROOT, ["merge-base", "--is-ancestor", SOURCE_COMMIT, defaultBranchRef]);
});

test("installer source pin includes the latest production workflow checkpoint on the default branch", () => {
  const defaultBranchRef = resolveDefaultBranchRef(REPOSITORY_ROOT, SOURCE_DEFAULT_BRANCH);
  const latestProductionCheckpoint = git(REPOSITORY_ROOT, [
    "rev-list",
    "-1",
    defaultBranchRef,
    "--",
    ...PRODUCTION_SOURCE_PATHS,
  ]).trim();
  assert.equal(
    SOURCE_COMMIT,
    latestProductionCheckpoint,
    "Installer source pin is stale; publish a follow-up checkpoint update after production workflow changes land on the default branch",
  );
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
