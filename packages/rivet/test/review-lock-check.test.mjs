import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  checkIssueTriageLocks,
  checkMaintenanceLocks,
  checkReviewLock,
} from "../scripts/check-review-lock.mjs";

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
      path.join(fixtureRoot, "rivet-review-disabled.lock.yml.gz.b64"),
      gzipSync("checked-in\n").toString("base64"),
    );
    await writeFile(
      path.join(fixtureRoot, ".github", "workflows", "rivet-review.md"),
      "---\nname: fixture\n---\n",
    );

    const options = {
      fixtureRoot,
      temporaryParent,
      ensureBinary: async () => "/verified/gh-aw",
      compileWorkflow: async ({ repositoryRoot, workflowId, binaryPath }) => {
        assert.equal(workflowId, "rivet-review");
        assert.equal(binaryPath, "/verified/gh-aw");
        await writeFile(path.join(repositoryRoot, LOCK_PATH), "regenerated\n");
      },
      validateWorkflow: async ({ workflowId, binaryPath }) => {
        assert.equal(workflowId, "rivet-review");
        assert.equal(binaryPath, "/verified/gh-aw");
        validated = true;
      },
    };
    await assert.rejects(
      checkReviewLock(options),
      /checked-in rivet-review\.lock\.yml fixture does not match/,
    );
    await writeFile(path.join(fixtureRoot, LOCK_PATH), "regenerated\n");
    await assert.rejects(
      checkReviewLock(options),
      /checked-in rivet-review-disabled\.lock\.yml fixture does not match/,
    );
    await writeFile(
      path.join(fixtureRoot, "rivet-review-disabled.lock.yml.gz.b64"),
      gzipSync("# prior compiler formatting\nregenerated\n").toString("base64"),
    );
    await checkReviewLock(options);
    assert.equal(validated, true);
    assert.deepEqual(await readdir(temporaryParent), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects stale maintenance locks from the pinned compiler", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "rivet-maintenance-lock-test-"),
  );
  const fixtureRoot = path.join(root, "fixture");
  const temporaryParent = path.join(root, "temporary");
  try {
    await mkdir(fixtureRoot, { recursive: true });
    await mkdir(temporaryParent);
    for (const mode of ["manual", "scheduled"]) {
      await writeFile(
        path.join(fixtureRoot, `rivet-maintenance-${mode}.lock.yml.gz.b64`),
        gzipSync("checked-in\n").toString("base64"),
      );
    }
    await assert.rejects(
      checkMaintenanceLocks({
        fixtureRoot,
        temporaryParent,
        ensureBinary: async () => "/verified/gh-aw",
        compileWorkflow: async ({ repositoryRoot, binaryPath }) => {
          assert.equal(binaryPath, "/verified/gh-aw");
          await writeFile(
            path.join(
              repositoryRoot,
              ".github",
              "workflows",
              "rivet-maintenance.lock.yml",
            ),
            "regenerated\n",
          );
        },
        validateWorkflow: async () => {},
      }),
      /rivet-maintenance-manual\.lock\.yml fixture does not match/,
    );
    for (const mode of ["manual", "scheduled"]) {
      await writeFile(
        path.join(fixtureRoot, `rivet-maintenance-${mode}.lock.yml.gz.b64`),
        gzipSync("# prior compiler formatting\nregenerated\n").toString(
          "base64",
        ),
      );
    }
    await checkMaintenanceLocks({
      fixtureRoot,
      temporaryParent,
      ensureBinary: async () => "/verified/gh-aw",
      compileWorkflow: async ({ repositoryRoot }) => {
        await writeFile(
          path.join(
            repositoryRoot,
            ".github/workflows/rivet-maintenance.lock.yml",
          ),
          "regenerated\n",
        );
      },
      validateWorkflow: async () => {},
    });
    assert.deepEqual(await readdir(temporaryParent), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rejects stale issue-triage locks from the pinned compiler", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-issue-lock-test-"));
  const fixtureRoot = path.join(root, "fixture");
  const temporaryParent = path.join(root, "temporary");
  try {
    await mkdir(fixtureRoot, { recursive: true });
    await mkdir(temporaryParent);
    for (const suffix of ["", "-gemini"]) {
      await writeFile(
        path.join(fixtureRoot, `rivet-issue-triage${suffix}.lock.yml.gz.b64`),
        gzipSync("checked-in\n").toString("base64"),
      );
    }
    const options = {
      fixtureRoot,
      temporaryParent,
      ensureBinary: async () => "/verified/gh-aw",
      compileWorkflow: async ({ repositoryRoot, workflowId, binaryPath }) => {
        assert.equal(workflowId, "rivet-issue-triage");
        assert.equal(binaryPath, "/verified/gh-aw");
        await writeFile(
          path.join(
            repositoryRoot,
            ".github/workflows/rivet-issue-triage.lock.yml",
          ),
          "regenerated\n",
        );
      },
      validateWorkflow: async () => {},
    };
    await assert.rejects(
      checkIssueTriageLocks(options),
      /rivet-issue-triage\.lock\.yml fixture does not match/,
    );
    for (const suffix of ["", "-gemini"]) {
      await writeFile(
        path.join(fixtureRoot, `rivet-issue-triage${suffix}.lock.yml.gz.b64`),
        gzipSync("# prior compiler formatting\nregenerated\n").toString(
          "base64",
        ),
      );
    }
    await checkIssueTriageLocks(options);
    assert.deepEqual(await readdir(temporaryParent), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
