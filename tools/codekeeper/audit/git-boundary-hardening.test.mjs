import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
