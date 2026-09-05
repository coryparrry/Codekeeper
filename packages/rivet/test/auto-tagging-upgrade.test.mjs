import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { installRepair, installReview } from "../src/install.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKFLOW_PATH = ".github/workflows/rivet-review.md";
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";
// Frozen from the last general-review installation before auto tagging,
// source commit 83927a86; these fixtures retain conversation-memory support.
const PREVIOUS_FIXTURES = "test/fixtures/pre-auto-tagging";

async function compressedFixture(relativePath) {
  return gunzipSync(
    Buffer.from(
      await readFile(path.join(PACKAGE_ROOT, relativePath), "utf8"),
      "base64",
    ),
  ).toString("utf8");
}
async function previousWorkflow() {
  return readFile(
    path.join(PACKAGE_ROOT, PREVIOUS_FIXTURES, "rivet-review.md"),
    "utf8",
  );
}
async function previousLock() {
  return compressedFixture(`${PREVIOUS_FIXTURES}/rivet-review.lock.yml.gz.b64`);
}
async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const workflow = await readFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.md`),
    "utf8",
  );
  let lock;
  if (workflowId === "rivet-review") {
    lock =
      workflow === (await previousWorkflow())
        ? await previousLock()
        : await currentReviewLock(PACKAGE_ROOT, workflow);
  } else if (workflowId === "rivet-issue-triage") {
    lock = await compressedFixture(
      "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
    );
  } else {
    assert.equal(workflowId, "rivet-repair");
    lock = "name: rivet-repair-current\n";
  }
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    lock,
  );
}
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-tagging-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const [mode, install] of [
  ["review", installReview],
  ["repair", installRepair],
]) {
  test(`upgrades the pre-tagging ${mode} installation and rejects edited locks`, async (t) => {
    const repositoryRoot = await repository(t);
    const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
    if (mode === "repair") configuration.repair.authority = "owner";
    const options = {
      repositoryRoot,
      configuration,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
    };
    await install(options);
    await writeFile(
      path.join(repositoryRoot, WORKFLOW_PATH),
      await previousWorkflow(),
    );
    await writeFile(path.join(repositoryRoot, LOCK_PATH), await previousLock());
    const configBefore = await readFile(
      path.join(repositoryRoot, ".github/rivet.json"),
      "utf8",
    );

    const editedLock = `${await previousLock()}\nunexpected: true\n`;
    await writeFile(path.join(repositoryRoot, LOCK_PATH), editedLock);
    await assert.rejects(
      install(options),
      /refusing to overwrite \.github\/workflows\/rivet-review\.lock\.yml/,
    );
    assert.equal(
      await readFile(path.join(repositoryRoot, LOCK_PATH), "utf8"),
      editedLock,
    );
    assert.equal(
      await readFile(path.join(repositoryRoot, WORKFLOW_PATH), "utf8"),
      await previousWorkflow(),
    );

    await writeFile(path.join(repositoryRoot, LOCK_PATH), await previousLock());
    const result = await install(options);
    assert.deepEqual(
      result.files
        .filter(({ status }) => status === "update")
        .map(({ path: relativePath }) => relativePath),
      [LOCK_PATH, WORKFLOW_PATH],
    );
    const upgraded = await readFile(
      path.join(repositoryRoot, WORKFLOW_PATH),
      "utf8",
    );
    assert.match(upgraded, /review_tags_pending:/);
    assert.match(upgraded, /publish-review-tags:/);
    assert.match(upgraded, /For every complete comparison/);
    assert.equal(
      await readFile(path.join(repositoryRoot, LOCK_PATH), "utf8"),
      await currentReviewLock(PACKAGE_ROOT, upgraded),
    );
    assert.equal(
      await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
      configBefore,
    );
  });
}
