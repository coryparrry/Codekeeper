import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { installRepair, installReview } from "../src/install.mjs";
import { matchesHistoricalManagedFile } from "../src/issue-triage-upgrade.mjs";
import { renderRivetIssueTriageWorkflowV013 } from "../src/workflows/issue-triage.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const V013_ISSUE_LOCK = path.join(
  PACKAGE_ROOT,
  "test/fixtures/v0.1.13/rivet-issue-triage.lock.yml.gz.b64",
);

async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const workflow = await readFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.md`),
    "utf8",
  );
  let source;
  if (workflowId === "rivet-review") {
    source = await currentReviewLock(PACKAGE_ROOT, workflow);
  } else {
    const fixture =
      workflowId === "rivet-maintenance"
        ? "test/fixtures/maintenance/rivet-maintenance-manual.lock.yml.gz.b64"
        : workflow.includes('allowed-repos: "${{ github.repository }}"')
          ? "test/fixtures/v0.1.13/rivet-issue-triage.lock.yml.gz.b64"
          : "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64";
    source = gunzipSync(
      Buffer.from(
        await readFile(path.join(PACKAGE_ROOT, fixture), "utf8"),
        "base64",
      ),
    ).toString("utf8");
  }
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    source,
  );
}

async function writeScalarIssueGuard(repositoryRoot, configuration) {
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-issue-triage.md"),
    renderRivetIssueTriageWorkflowV013({ configuration }),
  );
  const encoded = await readFile(V013_ISSUE_LOCK, "utf8");
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-issue-triage.lock.yml"),
    gunzipSync(Buffer.from(encoded, "base64")),
  );
}

async function writeHistoricalLiveReviewFiles(repositoryRoot) {
  const reviewExtension = await readFile(
    path.join(PACKAGE_ROOT, "assets/upgrades/v0.1.13/review-extension.md"),
    "utf8",
  );
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/aw/review-extension.md"),
    reviewExtension,
  );
  const contextPath = path.join(
    repositoryRoot,
    ".github/rivet/actions/prepare-review-context/index.mjs",
  );
  const previous = await readFile(
    path.join(
      PACKAGE_ROOT,
      "assets/upgrades/v0.1.13/prepare-review-context-index.mjs",
    ),
    "utf8",
  );
  const context = previous
    .replace(
      "\nasync function boundedResponseText",
      '\nfunction serializePromptSnapshot(snapshot) {\n  return JSON.stringify(snapshot).replaceAll("_" + "_GH_AW_", "\\\\u005f_GH_AW_");\n}\n\nasync function boundedResponseText',
    )
    .replace(
      'if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > maxSnapshotBytes)',
      'if (\n    Buffer.byteLength(serializePromptSnapshot(snapshot), "utf8") >\n    maxSnapshotBytes\n  )',
    )
    .replace(
      "`snapshot=${JSON.stringify(snapshot)}\\n`",
      "`snapshot=${serializePromptSnapshot(snapshot)}\\n`",
    );
  await writeFile(contextPath, context);
  return contextPath;
}

test("enables triage from an exact disabled installation", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rivet-triage-upgrade-test-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const previousConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  previousConfiguration.issues.triage = "disabled";
  await installReview({
    repositoryRoot,
    configuration: previousConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });

  const result = await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    5,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    4,
  );
  assert.equal(result.githubApp.permissions.issues, "write");
});

test("upgrades the exact scalar issue guard in a repair installation", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rivet-scalar-guard-upgrade-test-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.repair.authority = "owner";
  await installRepair({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await writeScalarIssueGuard(repositoryRoot, configuration);

  const result = await installRepair({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/workflows/rivet-issue-triage.lock.yml",
      ".github/workflows/rivet-issue-triage.md",
    ],
  );
});

test("accepts only frozen historical managed-file digests", () => {
  assert.equal(
    matchesHistoricalManagedFile(
      ".github/rivet/actions/prepare-review-context/index.mjs",
      "375aa15b58e9cb04db91a56977ef3646a8aabda7493511b45b9dcbaeb13e666e",
    ),
    true,
  );
  assert.equal(
    matchesHistoricalManagedFile(
      ".github/workflows/rivet-review.lock.yml",
      "5affc04940c34a2a27e9e6de181a6abad9cb1fb98f30ea4f1b1ea6d43fc9dc7a",
    ),
    false,
  );
});

test("upgrades the exact historical live review state and rejects drift", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rivet-live-upgrade-test-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const previousConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  previousConfiguration.issues.triage = "disabled";
  await installReview({
    repositoryRoot,
    configuration: previousConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await writeHistoricalLiveReviewFiles(repositoryRoot);
  const result = await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.ok(
    result.files.some(
      ({ path: relativePath, status }) =>
        relativePath ===
          ".github/rivet/actions/prepare-review-context/index.mjs" &&
        status === "update",
    ),
  );

  const modifiedRoot = await mkdtemp(
    path.join(os.tmpdir(), "rivet-live-upgrade-modified-test-"),
  );
  t.after(() => rm(modifiedRoot, { recursive: true, force: true }));
  await installReview({
    repositoryRoot: modifiedRoot,
    configuration: previousConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  const modifiedPath = await writeHistoricalLiveReviewFiles(modifiedRoot);
  await writeFile(modifiedPath, `${await readFile(modifiedPath, "utf8")}x`);
  await assert.rejects(
    installReview({
      repositoryRoot: modifiedRoot,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
    }),
    /refusing to overwrite/,
  );
});

test("enables triage and maintenance from a fully disabled install", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rivet-combined-upgrade-test-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const previousConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  previousConfiguration.issues.triage = "disabled";
  await installReview({
    repositoryRoot,
    configuration: previousConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "manual";
  const result = await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.equal(result.githubApp.permissions.issues, "write");
  assert.ok(
    result.files.some(
      ({ path: relativePath, status }) =>
        relativePath === ".github/workflows/rivet-maintenance.md" &&
        status === "create",
    ),
  );
});
