import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildCodekeeperPackageStage } from "../../../scripts/build-codekeeper-package.mjs";
import { git, PACKAGE_ROOT, REPOSITORY_ROOT, temporaryDirectory, VERSION, fixturePackageStageOptions } from "./helpers.mjs";

const execFile = promisify(execFileCallback);

async function runGuard(root) {
  return execFile(process.execPath, ["bin/prepublish-guard.mjs"], {
    cwd: root,
  });
}

async function buildStage(t) {
  const root = await temporaryDirectory(t, "codekeeper-prepublish-guard-");
  const destination = path.join(root, "package");
  await buildCodekeeperPackageStage({
    repositoryRoot: REPOSITORY_ROOT,
    destination,
    ...fixturePackageStageOptions(git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim()),
  });
  return destination;
}

test("publication guard rejects the source package because it is not a generated release stage", async () => {
  await assert.rejects(
    runGuard(PACKAGE_ROOT),
    /missing release manifest; publish only a generated release stage or its verified tarball/,
  );
});

test("publication guard accepts a closed generated package stage", async (t) => {
  const stage = await buildStage(t);
  const result = await runGuard(stage);
  const stdout = String(result.stdout);
  assert.ok(stdout.includes(VERSION));
  assert.match(stdout, /from [0-9a-f]{40}/);
});

test("publication guard rejects a stage whose verifier no longer matches its manifest", async (t) => {
  const stage = await buildStage(t);
  const verifier = path.join(stage, "bin", "verify-package.mjs");
  await writeFile(verifier, `${await readFile(verifier, "utf8")}\n// tampered\n`);
  await assert.rejects(runGuard(stage), /digest mismatch for bin\/verify-package\.mjs/);
});
