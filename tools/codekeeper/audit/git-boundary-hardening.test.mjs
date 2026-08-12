import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPatch } from "../src/lib/git.mjs";
import { validatePatch } from "../src/lib/policy.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
);

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("workspace capture never invokes a configured external diff helper", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-external-diff-audit-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Audit"]);
  git(repository, ["config", "user.email", "audit@example.invalid"]);
  await writeFile(path.join(repository, "README.md"), "baseline\n", "utf8");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "--quiet", "-m", "baseline"]);
  await writeFile(path.join(repository, "README.md"), "changed\n", "utf8");
  const sentinel = path.join(repository, "external-diff-ran");
  const helper = path.join(repository, "external-diff.mjs");
  await writeFile(helper, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nprocess.exit(1);\n`);
  await chmod(helper, 0o700);
  git(repository, ["config", "diff.external", helper]);

  const patchPath = path.join(repository, "captured.patch");
  const changes = await createPatch(patchPath, repository, {
    maximumFileBytes: 10_000,
    maximumPatchBytes: 10_000
  });

  assert.equal(changes.captureSkipped, false);
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

test("workspace capture bounds oversized content before materializing the patch", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-git-boundary-audit-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Audit"]);
  git(repository, ["config", "user.email", "audit@example.invalid"]);
  await writeFile(path.join(repository, "README.md"), "baseline\n", "utf8");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "--quiet", "-m", "baseline"]);

  const oversized = Buffer.alloc(config.audit.repair.maximumPatchBytes + 128 * 1024, "x");
  await writeFile(path.join(repository, "oversized.txt"), oversized);
  const patchPath = path.join(repository, "captured.patch");
  const changes = await createPatch(patchPath, repository, config.audit.repair);
  const policy = validatePatch(changes, config);

  assert.equal(policy.valid, false, "the policy must reject the oversized workspace");
  assert.ok(changes.files[0].bytes > config.audit.repair.maximumFileBytes);
  assert.equal(changes.captureSkipped, true, "oversized content should be rejected before diff materialization");
  assert.ok(
    changes.patchBytes <= config.audit.repair.maximumPatchBytes,
    `capture materialized ${changes.patchBytes} bytes before policy rejection`
  );
});

test("workspace capture enforces the per-file limit for tracked modifications", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-tracked-file-boundary-audit-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Audit"]);
  git(repository, ["config", "user.email", "audit@example.invalid"]);
  const trackedPath = path.join(repository, "tracked.txt");
  await writeFile(trackedPath, "baseline\n", "utf8");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "--quiet", "-m", "baseline"]);

  await writeFile(trackedPath, Buffer.alloc(2_048, "x"));
  const patchPath = path.join(repository, "captured.patch");
  const changes = await createPatch(patchPath, repository, {
    maximumFileBytes: 1_000,
    maximumPatchBytes: 10_000
  });

  assert.equal(changes.files[0].bytes, 2_048);
  assert.equal(changes.files[0].captureSkipped, true);
  assert.equal(changes.captureSkipped, true);
  assert.equal((await readFile(patchPath)).length, 0);
});

test("workspace capture rejects an oversized pre-change blob before materializing a deletion", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-old-blob-boundary-audit-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Audit"]);
  git(repository, ["config", "user.email", "audit@example.invalid"]);
  const trackedPath = path.join(repository, "tracked.txt");
  await writeFile(trackedPath, Buffer.alloc(2_048, "x"));
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "--quiet", "-m", "baseline"]);

  await rm(trackedPath);
  const patchPath = path.join(repository, "captured.patch");
  const changes = await createPatch(patchPath, repository, {
    maximumFileBytes: 1_000,
    maximumPatchBytes: 10_000
  });

  assert.equal(changes.files[0].bytes, 0);
  assert.equal(changes.files[0].captureSkipped, true);
  assert.equal(changes.captureSkipped, true);
  assert.equal((await readFile(patchPath)).length, 0);
});

test("patch policy rejects a shrink when oversized source capture was skipped", async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-old-blob-shrink-audit-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Audit"]);
  git(repository, ["config", "user.email", "audit@example.invalid"]);
  await mkdir(path.join(repository, "src"));
  const trackedPath = path.join(repository, "src", "tracked.mjs");
  await writeFile(trackedPath, Buffer.alloc(2_048, "x"));
  git(repository, ["add", "src/tracked.mjs"]);
  git(repository, ["commit", "--quiet", "-m", "baseline"]);

  await writeFile(trackedPath, "small\n");
  const patchPath = path.join(repository, "captured.patch");
  const changes = await createPatch(patchPath, repository, {
    maximumFileBytes: 1_000,
    maximumPatchBytes: 10_000
  });
  const policy = validatePatch(changes, config);

  assert.equal(changes.files[0].bytes, 6);
  assert.equal(changes.captureSkipped, true);
  assert.equal(policy.valid, false);
  assert.match(policy.reasons.join("\n"), /capture.*incomplete/i);
});
