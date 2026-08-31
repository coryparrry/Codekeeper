import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { ensureGhAwBinary } from "../src/gh-aw/binary.mjs";
import {
  compileGhAwWorkflow,
  validateGhAwWorkflow,
} from "../src/gh-aw/compile.mjs";
import { renderRivetMaintenanceWorkflow } from "../src/workflows/maintenance.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKFLOW_ID = "rivet-review";
const FIXTURE_ROOT = path.join(PACKAGE_ROOT, "test", "fixtures", "review");
const LOCK_PATH = path.join(".github", "workflows", `${WORKFLOW_ID}.lock.yml`);
const MAINTENANCE_FIXTURE_ROOT = path.join(
  PACKAGE_ROOT,
  "test",
  "fixtures",
  "maintenance",
);
const MAINTENANCE_WORKFLOW_ID = "rivet-maintenance";
const MAINTENANCE_LOCK_PATH = path.join(
  ".github",
  "workflows",
  `${MAINTENANCE_WORKFLOW_ID}.lock.yml`,
);

function fail(message) {
  throw new Error(`review-lock-check: ${message}`);
}

export async function checkMaintenanceLocks({
  fixtureRoot = MAINTENANCE_FIXTURE_ROOT,
  temporaryParent = os.tmpdir(),
  ensureBinary = ensureGhAwBinary,
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
} = {}) {
  const binaryPath = await ensureBinary();
  for (const mode of ["manual", "scheduled"]) {
    const temporaryRoot = await realpath(
      await mkdtemp(
        path.join(temporaryParent, "rivet-maintenance-lock-check-"),
      ),
    );
    try {
      const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
      configuration.maintenance.mode = mode;
      await mkdir(path.join(temporaryRoot, ".github", "workflows"), {
        recursive: true,
      });
      await mkdir(path.join(temporaryRoot, ".github", "rivet", "agents"), {
        recursive: true,
      });
      await cp(
        path.join(PACKAGE_ROOT, "assets", "agents", "repository-auditor.md"),
        path.join(
          temporaryRoot,
          ".github",
          "rivet",
          "agents",
          "repository-auditor.md",
        ),
        { recursive: true },
      );
      await cp(
        path.join(PACKAGE_ROOT, "assets", "maintenance", ".github", "rivet"),
        path.join(temporaryRoot, ".github", "rivet"),
        { recursive: true },
      );
      await writeFile(
        path.join(
          temporaryRoot,
          ".github",
          "workflows",
          `${MAINTENANCE_WORKFLOW_ID}.md`,
        ),
        renderRivetMaintenanceWorkflow({ configuration }),
      );
      await compileWorkflow({
        repositoryRoot: temporaryRoot,
        workflowId: MAINTENANCE_WORKFLOW_ID,
        binaryPath,
      });
      await validateWorkflow({
        repositoryRoot: temporaryRoot,
        workflowId: MAINTENANCE_WORKFLOW_ID,
        binaryPath,
      });
      const [encodedFixture, regenerated] = await Promise.all([
        readFile(
          path.join(fixtureRoot, `rivet-maintenance-${mode}.lock.yml.gz.b64`),
          "utf8",
        ),
        readFile(path.join(temporaryRoot, MAINTENANCE_LOCK_PATH)),
      ]);
      if (
        !gunzipSync(Buffer.from(encodedFixture, "base64")).equals(regenerated)
      ) {
        fail(
          `checked-in rivet-maintenance-${mode}.lock.yml fixture does not match the pinned gh-aw compiler output`,
        );
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
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
  await checkMaintenanceLocks();
  process.stdout.write("Rivet workflow locks are current\n");
}
