import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { installReview } from "../src/install.mjs";
import { renderRivetReviewWorkflowV0113 } from "../src/workflows/review.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CONTEXT_PATH = ".github/rivet/actions/prepare-review-context/index.mjs";
const CONTEXT_SHA256 =
  "ecaefbc8d295e9f27d5f4aaaf00c29f4dde27226642318e82ba4ddddd0d73caa";
const WORKFLOW_PATH = ".github/workflows/rivet-review.md";
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";

function configuration() {
  const value = structuredClone(DEFAULT_RIVET_CONFIG);
  value.issues.triage = "disabled";
  return value;
}

async function releasedLock() {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/v0.1.13/rivet-review-disabled.lock.yml.gz.b64",
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function releasedContextAction() {
  const content = await readFile(
    path.join(
      PACKAGE_ROOT,
      "assets/upgrades/v0.1.13/prepare-review-context-index.mjs",
    ),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(content).digest("hex"),
    CONTEXT_SHA256,
  );
  return content;
}

async function fixtureCompiler({ repositoryRoot, workflowId }) {
  assert.equal(workflowId, "rivet-review");
  const workflow = await readFile(
    path.join(repositoryRoot, WORKFLOW_PATH),
    "utf8",
  );
  const lock = workflow.includes("For every complete comparison")
    ? await currentReviewLock(PACKAGE_ROOT, workflow)
    : await releasedLock();
  await writeFile(path.join(repositoryRoot, LOCK_PATH), lock);
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-summary-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeReleasedInstallation(repositoryRoot) {
  const config = configuration();
  await installReview({
    repositoryRoot,
    configuration: config,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await writeFile(
    path.join(repositoryRoot, WORKFLOW_PATH),
    renderRivetReviewWorkflowV0113({ configuration: config }),
  );
  await writeFile(
    path.join(repositoryRoot, CONTEXT_PATH),
    await releasedContextAction(),
  );
  await writeFile(path.join(repositoryRoot, LOCK_PATH), await releasedLock());
  return config;
}

test("upgrades only an exact 0.1.13 review summary", async (t) => {
  const repositoryRoot = await repository(t);
  const config = await writeReleasedInstallation(repositoryRoot);
  const result = await installReview({
    repositoryRoot,
    configuration: config,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [CONTEXT_PATH, LOCK_PATH, WORKFLOW_PATH],
  );

  for (const relativePath of [CONTEXT_PATH, LOCK_PATH, WORKFLOW_PATH]) {
    await t.test(`rejects modified ${relativePath}`, async () => {
      const modifiedRoot = await repository(t);
      const modifiedConfig = await writeReleasedInstallation(modifiedRoot);
      const target = path.join(modifiedRoot, relativePath);
      const modified = `${await readFile(target, "utf8")}modified\n`;
      await writeFile(target, modified);
      await assert.rejects(
        installReview({
          repositoryRoot: modifiedRoot,
          configuration: modifiedConfig,
          dryRun: true,
          compileWorkflow: fixtureCompiler,
          validateWorkflow: async () => {},
        }),
        /refusing to overwrite/,
      );
      assert.equal(await readFile(target, "utf8"), modified);
    });
  }
});
