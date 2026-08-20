import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildCodekeeperPackageStage,
  verifyCodekeeperPackageStage,
} from "../../../scripts/build-codekeeper-package.mjs";
import {
  INTEGRITY_RECEIPT_PATH,
  verifyCodekeeperRelease,
} from "../src/release-verifier.mjs";
import { git, REPOSITORY_ROOT, temporaryDirectory } from "./helpers.mjs";

const INSTALLER_DEPENDENCIES = Object.freeze(["ink", "react"]);
const REPLACED_RUNTIME_FILES = new Set([
  "package-lock.json",
  "package.json",
]);

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildFixtureStage(t, name = "stage") {
  const temporaryRoot = await temporaryDirectory(t, "codekeeper-package-stage-test-");
  const destination = path.join(temporaryRoot, name);
  const sourceCommit = git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim();
  return buildCodekeeperPackageStage({
    repositoryRoot: REPOSITORY_ROOT,
    destination,
    sourceCommit,
    requireClean: false,
  });
}

async function cloneStage(t, source, name) {
  const temporaryRoot = await temporaryDirectory(t, `codekeeper-package-${name}-`);
  const destination = path.join(temporaryRoot, name);
  await cp(source, destination, { recursive: true });
  return destination;
}

test("package stage contains one release with separate closed installer and runtime dependency graphs", async (t) => {
  const { destination, manifest } = await buildFixtureStage(t);
  const paths = manifest.files.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(manifest.package.name, "@coryparry/codekeeper");
  assert.match(manifest.package.version, /^\d+\.\d+\.\d+/);
  assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(paths.includes("runtime/action.yml"), false);

  for (const requiredPath of [
    "bin/codekeeper.mjs",
    "bin/verify-package.mjs",
    "src/tui.mjs",
    "assets/agents/fixer.md",
    "runtime/agents/fixer.md",
    "runtime/presets/catalogue.mjs",
    "runtime/package.json",
    "runtime/package-lock.json",
    "runtime/scripts/verify-tooling-artifact.mjs",
    "runtime/src/cli.mjs",
    "runtime/src/lib/agents-runtime.mjs",
    "runtime/src/lib/runtime-paths.mjs",
    "release/actions/acquire-package/action.yml",
    "release/workflows/codekeeper-assistant.yml",
    "release/workflows/codekeeper-fix.yml",
    "release/workflows/codekeeper-issues.yml",
    "release/workflows/codekeeper-maintain.yml",
    "release/workflows/codekeeper-review.yml",
    "package.json",
  ]) {
    assert.ok(paths.includes(requiredPath), `${requiredPath} is staged`);
  }
  assert.ok(
    paths.every(
      (filePath) =>
        !filePath.includes("/test/") &&
        !filePath.includes("/audit/") &&
        !filePath.includes("/evals/") &&
        filePath !== "package-lock.json" &&
        !filePath.endsWith("tooling-manifest.json"),
    ),
  );

  for (const entry of manifest.files) {
    const source = await readFile(path.join(REPOSITORY_ROOT, entry.sourcePath));
    const staged = await readFile(path.join(destination, entry.path));
    assert.deepEqual(staged, source, `${entry.path} matches ${entry.sourcePath}`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  }

  const packageManifest = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "packages/codekeeper/package-lock.json"), "utf8"));
  const stagedRuntimeManifest = JSON.parse(await readFile(path.join(destination, "runtime/package.json"), "utf8"));
  const runtimePackageLock = JSON.parse(await readFile(path.join(destination, "runtime/package-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(packageManifest.dependencies).sort(), [...INSTALLER_DEPENDENCIES]);
  assert.deepEqual(packageManifest.bundleDependencies, INSTALLER_DEPENDENCIES);
  assert.deepEqual(packageLock.packages[""].dependencies, packageManifest.dependencies);
  assert.deepEqual(packageLock.packages[""].bundleDependencies, packageManifest.bundleDependencies);
  assert.deepEqual(runtimePackageLock.packages[""].dependencies, stagedRuntimeManifest.dependencies);
  for (const [label, lock] of [["installer", packageLock], ["runtime", runtimePackageLock]]) {
    for (const [packagePath, metadata] of Object.entries(lock.packages)) {
      if (!packagePath.startsWith("node_modules/")) continue;
      assert.equal(typeof metadata.version, "string", `${label} ${packagePath} has an exact version`);
      assert.match(metadata.integrity, /^sha512-/, `${label} ${packagePath} has sha512 integrity`);
    }
  }
  assert.equal(Object.hasOwn(packageLock.packages, "node_modules/@openai/agents"), false);
  assert.equal(Object.hasOwn(packageLock.packages, "node_modules/@openai/codex"), false);
  assert.ok(Object.hasOwn(runtimePackageLock.packages, "node_modules/@openai/agents"));
  assert.ok(Object.hasOwn(runtimePackageLock.packages, "node_modules/@openai/codex"));

  const toolingManifest = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, "tools/codekeeper/tooling-manifest.json"), "utf8"),
  );
  const stagedByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  for (const toolingEntry of toolingManifest.files) {
    if (REPLACED_RUNTIME_FILES.has(toolingEntry.path)) continue;
    const stagePath = `runtime/${toolingEntry.path}`;
    assert.equal(
      stagedByPath.get(stagePath)?.sourcePath,
      `tools/codekeeper/${toolingEntry.path}`,
      `${toolingEntry.path} remains in the unified package inventory`,
    );
  }
  const canonicalAgentFiles = (await readdir(path.join(REPOSITORY_ROOT, "tools", "codekeeper", "agents"), {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    paths.filter((filePath) => filePath.startsWith("runtime/agents/")).map((filePath) => path.basename(filePath)).sort(),
    canonicalAgentFiles,
    "every canonical runtime agent is included without a hand-maintained stage inventory",
  );
  assert.ok(paths.every((filePath) => !filePath.startsWith("runtime/integrations/")));
});

test("package stage verification rejects omission, addition, tampering, hidden files, and symlinks", async (t) => {
  const { destination, manifest } = await buildFixtureStage(t);
  const target = manifest.files.find((entry) => entry.path === "runtime/src/cli.mjs").path;

  const omitted = await cloneStage(t, destination, "omitted");
  await unlink(path.join(omitted, target));
  await assert.rejects(verifyCodekeeperPackageStage(omitted), /inventory does not match/);

  const added = await cloneStage(t, destination, "added");
  await writeFile(path.join(added, "unexpected.txt"), "not released\n");
  await assert.rejects(verifyCodekeeperPackageStage(added), /inventory does not match/);

  const tampered = await cloneStage(t, destination, "tampered");
  await writeFile(path.join(tampered, target), "tampered\n");
  await assert.rejects(verifyCodekeeperPackageStage(tampered), /digest mismatch/);

  const hidden = await cloneStage(t, destination, "hidden");
  await writeFile(path.join(hidden, ".local-debris"), "hidden\n");
  await assert.rejects(verifyCodekeeperPackageStage(hidden), /hidden path is not allowed/);

  const linked = await cloneStage(t, destination, "linked");
  await unlink(path.join(linked, target));
  await symlink("../action.yml", path.join(linked, target));
  await assert.rejects(verifyCodekeeperPackageStage(linked), /symlink is not allowed/);

  await rm(path.join(linked, target), { force: true });
});

test("installed-package verifier binds external package identity, integrity receipt, manifest, and source", async (t) => {
  const { destination, manifest } = await buildFixtureStage(t);
  const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  const manifestBytes = await readFile(path.join(destination, "release", "manifest.json"));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  await writeFile(path.join(destination, ...INTEGRITY_RECEIPT_PATH.split("/")), `${JSON.stringify({
    version: 1,
    algorithm: "sha512",
    integrity,
  })}\n`);
  const expected = {
    root: destination,
    expectedName: manifest.package.name,
    expectedVersion: manifest.package.version,
    expectedIntegrity: integrity,
    expectedManifestSha256: manifestSha256,
    expectedSourceCommit: manifest.source.commit,
  };
  assert.equal((await verifyCodekeeperRelease(expected)).source.commit, manifest.source.commit);
  for (const [field, value, message] of [
    ["expectedName", "another-package", /package name does not match/],
    ["expectedVersion", "9.9.9", /package version does not match/],
    ["expectedIntegrity", `sha512-${Buffer.alloc(64, 8).toString("base64")}`, /integrity receipt does not match/],
    ["expectedManifestSha256", "0".repeat(64), /manifest SHA-256 does not match/],
    ["expectedSourceCommit", "0".repeat(40), /source commit does not match/],
  ]) {
    await assert.rejects(verifyCodekeeperRelease({ ...expected, [field]: value }), message);
  }
});

test("package stage rejects destination reuse, repository output, and mismatched release commits", async (t) => {
  const temporaryRoot = await temporaryDirectory(t, "codekeeper-package-boundary-");
  const sourceCommit = git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim();
  await assert.rejects(
    buildCodekeeperPackageStage({
      repositoryRoot: REPOSITORY_ROOT,
      destination: temporaryRoot,
      sourceCommit,
      requireClean: false,
    }),
    /destination already exists/,
  );
  await assert.rejects(
    buildCodekeeperPackageStage({
      repositoryRoot: REPOSITORY_ROOT,
      destination: path.join(REPOSITORY_ROOT, "dist", "unsafe-stage"),
      sourceCommit,
      requireClean: false,
    }),
    /outside the source repository/,
  );
  await assert.rejects(
    buildCodekeeperPackageStage({
      repositoryRoot: REPOSITORY_ROOT,
      destination: path.join(temporaryRoot, "mismatch"),
      sourceCommit: "0".repeat(40),
      requireClean: true,
    }),
    /source commit does not match repository HEAD/,
  );
});

test("failed package stages remove their partial destination", async (t) => {
  const repositoryRoot = await temporaryDirectory(t, "codekeeper-package-incomplete-source-");
  const destinationParent = await temporaryDirectory(t, "codekeeper-package-failed-stage-");
  const destination = path.join(destinationParent, "package");
  await assert.rejects(
    buildCodekeeperPackageStage({
      repositoryRoot,
      destination,
      sourceCommit: "0".repeat(40),
      requireClean: false,
    }),
    /ENOENT/,
  );
  assert.equal(await pathExists(destination), false);
  assert.deepEqual(await readdir(destinationParent), []);
});
