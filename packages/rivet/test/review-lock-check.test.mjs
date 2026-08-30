import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkReviewLock } from "../scripts/check-review-lock.mjs";

const LOCK_PATH = path.join(".github", "workflows", "rivet-review.lock.yml");

test("rejects a stale review lock and removes its temporary repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-review-lock-test-"));
  const fixtureRoot = path.join(root, "fixture");
  const temporaryParent = path.join(root, "temporary");
  let validated = false;
  try {
    await mkdir(path.join(fixtureRoot, ".github", "workflows"), {
      recursive: true,
    });
    await mkdir(temporaryParent);
    await writeFile(path.join(fixtureRoot, LOCK_PATH), "checked-in\n");
    await writeFile(
      path.join(fixtureRoot, ".github", "workflows", "rivet-review.md"),
      "---\nname: fixture\n---\n",
    );

    await assert.rejects(
      checkReviewLock({
        fixtureRoot,
        temporaryParent,
        ensureBinary: async () => "/verified/gh-aw",
        compileWorkflow: async ({ repositoryRoot, workflowId, binaryPath }) => {
          assert.equal(workflowId, "rivet-review");
          assert.equal(binaryPath, "/verified/gh-aw");
          await writeFile(
            path.join(repositoryRoot, LOCK_PATH),
            "regenerated\n",
          );
        },
        validateWorkflow: async ({ workflowId, binaryPath }) => {
          assert.equal(workflowId, "rivet-review");
          assert.equal(binaryPath, "/verified/gh-aw");
          validated = true;
        },
      }),
      /checked-in rivet-review\.lock\.yml does not match/,
    );
    assert.equal(validated, true);
    assert.deepEqual(await readdir(temporaryParent), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
