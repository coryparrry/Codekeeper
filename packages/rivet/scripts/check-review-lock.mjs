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
import { knownCompilerDrift } from "../src/install.mjs";
import {
  renderRivetIssueTriageWorkflow,
  renderRivetIssueTriageWorkflowV013,
} from "../src/workflows/issue-triage.mjs";
import { renderRivetMaintenanceWorkflow } from "../src/workflows/maintenance.mjs";
import { renderRivetReviewWorkflow } from "../src/workflows/review.mjs";

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
const ISSUE_TRIAGE_FIXTURE_ROOT = path.join(
  PACKAGE_ROOT,
  "test",
  "fixtures",
  "issue-triage",
);
const HISTORICAL_ISSUE_TRIAGE_FIXTURE_ROOT = path.join(
  PACKAGE_ROOT,
  "test",
  "fixtures",
  "v0.1.13",
);
const ISSUE_TRIAGE_WORKFLOW_ID = "rivet-issue-triage";
const ISSUE_TRIAGE_LOCK_PATH = path.join(
  ".github",
  "workflows",
  `${ISSUE_TRIAGE_WORKFLOW_ID}.lock.yml`,
);

function fail(message) {
  throw new Error(`review-lock-check: ${message}`);
}

export async function checkIssueTriageLocks({
  fixtureRoot = ISSUE_TRIAGE_FIXTURE_ROOT,
  historicalFixtureRoot = HISTORICAL_ISSUE_TRIAGE_FIXTURE_ROOT,
  temporaryParent = os.tmpdir(),
  ensureBinary = ensureGhAwBinary,
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
} = {}) {
  const variants = [
    ["codex", "gpt-5.6-luna", ""],
    ["claude", "claude-review-model", "-claude"],
    ["copilot", "copilot-review-model", "-copilot"],
    ["gemini", "gemini-review-model", "-gemini"],
  ].map(([engine, model, suffix]) => ({ engine, model, suffix }));
  variants.push({
    engine: "codex",
    model: "gpt-5.6-luna",
    name: "v0.1.13/rivet-issue-triage",
    source: renderRivetIssueTriageWorkflowV013(),
    fixturePath: path.join(
      historicalFixtureRoot,
      `${ISSUE_TRIAGE_WORKFLOW_ID}.lock.yml.gz.b64`,
    ),
  });
  const binaryPath = await ensureBinary();
  for (const variant of variants) {
    const temporaryRoot = await realpath(
      await mkdtemp(path.join(temporaryParent, "rivet-issue-lock-check-")),
    );
    try {
      const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
      configuration.models.review.engine = variant.engine;
      configuration.models.review.model = variant.model;
      await mkdir(path.join(temporaryRoot, ".github", "workflows"), {
        recursive: true,
      });
      await mkdir(path.join(temporaryRoot, ".github", "rivet", "agents"), {
        recursive: true,
      });
      await cp(
        path.join(PACKAGE_ROOT, "assets", "agents", "issue-triager.md"),
        path.join(
          temporaryRoot,
          ".github",
          "rivet",
          "agents",
          "issue-triager.md",
        ),
      );
      await writeFile(
        path.join(
          temporaryRoot,
          ".github",
          "workflows",
          `${ISSUE_TRIAGE_WORKFLOW_ID}.md`,
        ),
        variant.source ?? renderRivetIssueTriageWorkflow({ configuration }),
      );
      await compileWorkflow({
        repositoryRoot: temporaryRoot,
        workflowId: ISSUE_TRIAGE_WORKFLOW_ID,
        binaryPath,
      });
      await validateWorkflow({
        repositoryRoot: temporaryRoot,
        workflowId: ISSUE_TRIAGE_WORKFLOW_ID,
        binaryPath,
      });
      const fixturePath =
        variant.fixturePath ??
        path.join(
          fixtureRoot,
          `${ISSUE_TRIAGE_WORKFLOW_ID}${variant.suffix}.lock.yml.gz.b64`,
        );
      const [encodedFixture, regenerated] = await Promise.all([
        readFile(fixturePath, "utf8"),
        readFile(path.join(temporaryRoot, ISSUE_TRIAGE_LOCK_PATH)),
      ]);
      const checkedIn = gunzipSync(Buffer.from(encodedFixture, "base64"));
      if (
        !checkedIn.equals(regenerated) &&
        !knownCompilerDrift(
          ISSUE_TRIAGE_LOCK_PATH,
          checkedIn.toString("utf8"),
          regenerated.toString("utf8"),
        )
      ) {
        fail(
          `checked-in ${variant.name ?? `${ISSUE_TRIAGE_WORKFLOW_ID}${variant.suffix}`}.lock.yml fixture does not match the pinned gh-aw compiler output`,
        );
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
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
      const checkedIn = gunzipSync(Buffer.from(encodedFixture, "base64"));
      if (
        !checkedIn.equals(regenerated) &&
        !knownCompilerDrift(
          MAINTENANCE_LOCK_PATH,
          checkedIn.toString("utf8"),
          regenerated.toString("utf8"),
        )
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
  const disabledConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  disabledConfiguration.issues.triage = "disabled";
  const variants = [
    {
      name: "rivet-review.lock.yml",
      readFixture: () => readFile(path.join(fixtureRoot, LOCK_PATH)),
    },
    {
      name: "rivet-review-disabled.lock.yml",
      source: renderRivetReviewWorkflow({
        configuration: disabledConfiguration,
      }),
      readFixture: async () =>
        gunzipSync(
          Buffer.from(
            await readFile(
              path.join(fixtureRoot, "rivet-review-disabled.lock.yml.gz.b64"),
              "utf8",
            ),
            "base64",
          ),
        ),
    },
  ];
  const binaryPath = await ensureBinary();
  for (const variant of variants) {
    const temporaryRoot = await realpath(
      await mkdtemp(path.join(temporaryParent, "rivet-review-lock-check-")),
    );
    try {
      await cp(fixtureRoot, temporaryRoot, { recursive: true });
      const temporaryLock = path.join(temporaryRoot, LOCK_PATH);
      await rm(temporaryLock, { force: true });
      if (variant.source) {
        await writeFile(
          path.join(temporaryRoot, ".github", "workflows", `${WORKFLOW_ID}.md`),
          variant.source,
        );
      }
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
        variant.readFixture(),
        readFile(temporaryLock),
      ]);
      if (
        !checkedIn.equals(regenerated) &&
        !knownCompilerDrift(
          LOCK_PATH,
          checkedIn.toString("utf8"),
          regenerated.toString("utf8"),
        )
      ) {
        fail(
          `checked-in ${variant.name} fixture does not match the pinned gh-aw compiler output`,
        );
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await checkReviewLock();
  await checkMaintenanceLocks();
  await checkIssueTriageLocks();
  process.stdout.write("Rivet workflow locks are current\n");
}
