import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildCodekeeperPackageStage,
} from "../../../scripts/build-codekeeper-package.mjs";
import { verifyCodekeeperRelease } from "../src/release-verifier.mjs";
import {
  git,
  REPOSITORY_ROOT,
  temporaryDirectory,
} from "./helpers.mjs";

const execFile = promisify(execFileCallback);
const ACTION_PATH = path.join(
  REPOSITORY_ROOT,
  ".github/codekeeper/actions/acquire-package/action.yml",
);

function actionRunScript(source) {
  const marker = "      run: |\n";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "composite action contains one run script");
  return `${source
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("        ") ? line.slice(8) : line))
    .join("\n")}\n`;
}

async function localPackage(t) {
  const root = await temporaryDirectory(t, "codekeeper-acquisition-package-");
  const stage = path.join(root, "stage");
  const archiveRoot = path.join(root, "archive");
  const archivePackage = path.join(archiveRoot, "package");
  const packed = path.join(root, "packed");
  await mkdir(archiveRoot);
  await mkdir(packed);
  const sourceCommit = git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim();
  const { manifest } = await buildCodekeeperPackageStage({
    repositoryRoot: REPOSITORY_ROOT,
    destination: stage,
    sourceCommit,
    requireClean: false,
  });
  await cp(stage, archivePackage, { recursive: true });
  const filename = `codekeeper-${manifest.package.version}.tgz`;
  const tarball = path.join(packed, filename);
  await execFile("tar", ["-czf", tarball, "-C", archiveRoot, "package"]);
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
  return {
    integrity,
    manifest,
    tarball,
  };
}

async function runAction(t, { expectedIntegrity, reportShape = "object" }) {
  const fixture = await localPackage(t);
  const root = await temporaryDirectory(t, "codekeeper-acquisition-run-");
  const fakeBin = path.join(root, "bin");
  const runnerTemp = path.join(root, "runner");
  const workspace = path.join(root, "workspace");
  const output = path.join(root, "output.txt");
  const script = path.join(root, "action.sh");
  await mkdir(fakeBin);
  await mkdir(runnerTemp);
  await mkdir(workspace);
  const fakeNpm = path.join(fakeBin, "npm");
  await writeFile(
    fakeNpm,
    `#!/usr/bin/env node
const { basename } = require("node:path");
const { copyFileSync } = require("node:fs");
const destinationIndex = process.argv.indexOf("--pack-destination");
if (process.argv[2] !== "pack" || destinationIndex < 0) process.exit(2);
const filename = basename(process.env.CODEKEEPER_TEST_TARBALL);
copyFileSync(process.env.CODEKEEPER_TEST_TARBALL, require("node:path").join(process.argv[destinationIndex + 1], filename));
const entry = { name: "codekeeper", version: process.env.CODEKEEPER_PACKAGE_VERSION, integrity: process.env.CODEKEEPER_PACKAGE_INTEGRITY, filename };
process.stdout.write(JSON.stringify(process.env.CODEKEEPER_TEST_REPORT_SHAPE === "array" ? [entry] : { codekeeper: entry }));
`,
  );
  await chmod(fakeNpm, 0o755);
  await writeFile(script, actionRunScript(await readFile(ACTION_PATH, "utf8")));

  const environment = {
    ...process.env,
    CODEKEEPER_PACKAGE_INTEGRITY: expectedIntegrity ?? fixture.integrity,
    CODEKEEPER_PACKAGE_SOURCE: "registry",
    CODEKEEPER_PACKAGE_VERSION: fixture.manifest.package.version,
    CODEKEEPER_TEST_TARBALL: fixture.tarball,
    CODEKEEPER_TEST_REPORT_SHAPE: reportShape,
    GITHUB_OUTPUT: output,
    GITHUB_WORKSPACE: workspace,
    NPM_CONFIG_USERCONFIG: path.join(runnerTemp, "codekeeper-empty-npmrc"),
    PATH: `${fakeBin}:${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
  };
  return {
    environment,
    fixture,
    output,
    tooling: path.join(workspace, "tooling/tools/codekeeper"),
    execute: () => execFile("bash", [script], { env: environment }),
  };
}

async function outputsFrom(file) {
  return Object.fromEntries(
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
}

async function runArtifactAction(t, acquired, { tamperVerifier = false } = {}) {
  const root = await temporaryDirectory(t, "codekeeper-artifact-verification-");
  const runnerTemp = path.join(root, "runner");
  const workspace = path.join(root, "workspace");
  const tooling = path.join(workspace, "tooling/tools/codekeeper");
  const output = path.join(root, "output.txt");
  const script = path.join(root, "action.sh");
  await mkdir(runnerTemp);
  await mkdir(path.dirname(tooling), { recursive: true });
  await cp(acquired.tooling, tooling, { recursive: true });
  if (tamperVerifier) {
    await writeFile(
      path.join(tooling, "bin/verify-package.mjs"),
      "process.exit(0);\n",
    );
  }
  await writeFile(script, actionRunScript(await readFile(ACTION_PATH, "utf8")));
  const acquiredOutputs = await outputsFrom(acquired.output);
  const environment = {
    ...process.env,
    CODEKEEPER_EXPECTED_MANIFEST_SHA256:
      acquiredOutputs.package_manifest_sha256,
    CODEKEEPER_EXPECTED_SOURCE_COMMIT: acquiredOutputs.source_commit,
    CODEKEEPER_PACKAGE_INTEGRITY: acquired.fixture.integrity,
    CODEKEEPER_PACKAGE_SOURCE: "artifact",
    CODEKEEPER_PACKAGE_VERSION: acquired.fixture.manifest.package.version,
    GITHUB_OUTPUT: output,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
  };
  return {
    execute: () => execFile("bash", [script], { env: environment }),
    output,
  };
}

test("exact package acquisition accepts npm 11 and npm 12 pack reports", async (t) => {
  for (const reportShape of ["array", "object"]) {
    await t.test(reportShape, async (subtest) => {
      const run = await runAction(subtest, { reportShape });
      await run.execute();
      const outputs = await outputsFrom(run.output);
      assert.equal(outputs.source_commit, run.fixture.manifest.source.commit);
      assert.match(outputs.package_manifest_sha256, /^[0-9a-f]{64}$/);
      const verified = await verifyCodekeeperRelease({
        root: run.tooling,
        expectedName: run.fixture.manifest.package.name,
        expectedVersion: run.fixture.manifest.package.version,
        expectedIntegrity: run.fixture.integrity,
        expectedManifestSha256: outputs.package_manifest_sha256,
        expectedSourceCommit: run.fixture.manifest.source.commit,
      });
      assert.equal(verified.source.commit, run.fixture.manifest.source.commit);
    });
  }
});

test("exact package acquisition rejects changed bytes before extraction", async (t) => {
  const wrongIntegrity = `sha512-${Buffer.alloc(64, 9).toString("base64")}`;
  const run = await runAction(t, { expectedIntegrity: wrongIntegrity });
  await assert.rejects(run.execute(), /tarball integrity mismatch/);
  await assert.rejects(readFile(run.output), /ENOENT/);
});

test("artifact revalidation authenticates its verifier before execution", async (t) => {
  const acquired = await runAction(t, { reportShape: "array" });
  await acquired.execute();

  const pristine = await runArtifactAction(t, acquired);
  await pristine.execute();
  assert.deepEqual(
    await outputsFrom(pristine.output),
    await outputsFrom(acquired.output),
  );

  const tampered = await runArtifactAction(t, acquired, {
    tamperVerifier: true,
  });
  await assert.rejects(tampered.execute(), /package verifier digest mismatch/);
  await assert.rejects(readFile(tampered.output), /ENOENT/);
});
