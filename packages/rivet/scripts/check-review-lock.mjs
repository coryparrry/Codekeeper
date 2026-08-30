import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGhAwBinary } from "../src/gh-aw/binary.mjs";
import {
  compileGhAwWorkflow,
  validateGhAwWorkflow,
} from "../src/gh-aw/compile.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKFLOW_ID = "rivet-review";
const FIXTURE_ROOT = path.join(PACKAGE_ROOT, "test", "fixtures", "review");
const LOCK_PATH = path.join(".github", "workflows", `${WORKFLOW_ID}.lock.yml`);

function fail(message) {
  throw new Error(`review-lock-check: ${message}`);
}

export async function checkReviewLock({
  fixtureRoot = FIXTURE_ROOT,
  temporaryParent = os.tmpdir(),
  ensureBinary = ensureGhAwBinary,
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
} = {}) {
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(temporaryParent, "rivet-review-lock-check-")),
  );
  try {
    await cp(fixtureRoot, temporaryRoot, { recursive: true });
    const temporaryLock = path.join(temporaryRoot, LOCK_PATH);
    await rm(temporaryLock, { force: true });

    const binaryPath = await ensureBinary();
    await compileWorkflow({
      repositoryRoot: temporaryRoot,
      workflowId: WORKFLOW_ID,
      binaryPath,
    });
    await validateWorkflow({
      repositoryRoot: temporaryRoot,
      workflowId: WORKFLOW_ID,
      binaryPath,
    });

    const [checkedIn, regenerated] = await Promise.all([
      readFile(path.join(fixtureRoot, LOCK_PATH)),
      readFile(temporaryLock),
    ]);
    if (!checkedIn.equals(regenerated)) {
      fail(
        "checked-in rivet-review.lock.yml does not match the pinned gh-aw compiler output",
      );
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await checkReviewLock();
  process.stdout.write("Rivet review lock is current\n");
}
