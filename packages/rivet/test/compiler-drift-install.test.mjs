import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import {
  applyInstallation,
  installReview,
  prepareReviewInstallation,
} from "../src/install.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCK_FIXTURES = Object.freeze({
  "rivet-issue-triage":
    "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
  "rivet-maintenance":
    "test/fixtures/maintenance/rivet-maintenance-scheduled.lock.yml.gz.b64",
});

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-drift-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const workflow = await readFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.md`),
    "utf8",
  );
  const source = LOCK_FIXTURES[workflowId]
    ? gunzipSync(
        Buffer.from(
          await readFile(
            path.join(PACKAGE_ROOT, LOCK_FIXTURES[workflowId]),
            "utf8",
          ),
          "base64",
        ),
      ).toString("utf8")
    : await currentReviewLock(PACKAGE_ROOT, workflow);
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    source,
  );
}

test("skips historical compilation and writes for compiler comments", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  const progress = [];
  const options = {
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
    onProgress: (message) => progress.push(message),
  };
  const installed = await installReview(options);
  assert.deepEqual(progress, [
    "Preparing Rivet installation",
    "Checking existing Rivet installation",
    "Writing Rivet installation",
  ]);
  const lockPaths = installed.files
    .map(({ path: relativePath }) => relativePath)
    .filter((relativePath) => relativePath.endsWith(".lock.yml"));
  assert.equal(lockPaths.length, 3);

  const before = new Map();
  const fixedTime = new Date("2020-01-02T03:04:05.000Z");
  for (const relativePath of lockPaths) {
    const destination = path.join(repositoryRoot, relativePath);
    const content = `# compiler metadata changed\n${await readFile(destination, "utf8")}`;
    await writeFile(destination, content);
    await utimes(destination, fixedTime, fixedTime);
    before.set(relativePath, {
      content,
      mtimeMs: (await stat(destination)).mtimeMs,
    });
  }

  let compileCalls = 0;
  const plan = await prepareReviewInstallation({
    ...options,
    compileWorkflow: async (compileOptions) => {
      compileCalls += 1;
      await fixtureCompiler(compileOptions);
    },
  });
  assert.equal(compileCalls, lockPaths.length);
  assert.ok(plan.files.every(({ status }) => status === "unchanged"));
  for (const relativePath of lockPaths) {
    const planned = plan.files.find(
      ({ path: filePath }) => filePath === relativePath,
    );
    const expected = before.get(relativePath);
    const expectedSha256 = createHash("sha256")
      .update(expected.content)
      .digest("hex");
    assert.equal(planned.content, expected.content);
    assert.equal(planned.previousSha256, expectedSha256);
    assert.equal(planned.sha256, expectedSha256);
  }

  await applyInstallation(plan);
  for (const relativePath of lockPaths) {
    const destination = path.join(repositoryRoot, relativePath);
    assert.equal(
      await readFile(destination, "utf8"),
      before.get(relativePath).content,
    );
    assert.equal(
      (await stat(destination)).mtimeMs,
      before.get(relativePath).mtimeMs,
    );
  }

  const changedPath = lockPaths[0];
  await writeFile(
    path.join(repositoryRoot, changedPath),
    `${before.get(changedPath).content}unexpected: true\n`,
  );
  await assert.rejects(
    prepareReviewInstallation(options),
    /refusing to overwrite/,
  );
});
