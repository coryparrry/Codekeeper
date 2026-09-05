import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  applyInstallation,
  installRepair,
  installReview,
  prepareRepairInstallation,
  prepareReviewInstallation,
} from "../src/install.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";
const REVIEWER_PATH = ".github/rivet/agents/pr-reviewer.md";
const ISSUE_TRIAGER_PATH = ".github/rivet/agents/issue-triager.md";
const FIXER_PATH = ".github/rivet/agents/fixer.md";
const ISSUE_TRIAGE_PATHS = [
  ISSUE_TRIAGER_PATH,
  ".github/rivet/actions/prepare-issue-context/action.yml",
  ".github/rivet/actions/prepare-issue-context/index.mjs",
  ".github/workflows/rivet-issue-triage.md",
  ".github/workflows/rivet-issue-triage.lock.yml",
];
const REVIEW_EXTENSION_PATH = ".github/rivet/aw/review-extension.md";
const REVIEW_ASSETS = [
  ".github/rivet/actions/authority-receipt/action.yml",
  ".github/rivet/actions/authority-receipt/index.mjs",
  REVIEW_EXTENSION_PATH,
];
const REPAIR_ASSETS = [
  ".github/rivet/actions/publish-repair/action.yml",
  ".github/rivet/actions/publish-repair/index.mjs",
  ".github/rivet/actions/validate-repair/action.yml",
  ".github/rivet/actions/validate-repair/index.mjs",
];
const V012_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.2");
const MAINTENANCE_FIXTURES = {
  manual: path.join(
    PACKAGE_ROOT,
    "test/fixtures/maintenance/rivet-maintenance-manual.lock.yml.gz.b64",
  ),
  scheduled: path.join(
    PACKAGE_ROOT,
    "test/fixtures/maintenance/rivet-maintenance-scheduled.lock.yml.gz.b64",
  ),
};
const MAINTENANCE_PATHS = [
  ".github/rivet/agents/repository-auditor.md",
  ".github/rivet/actions/validate-audit/action.yml",
  ".github/rivet/actions/validate-audit/index.mjs",
  ".github/workflows/rivet-maintenance.md",
  ".github/workflows/rivet-maintenance.lock.yml",
];
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function frozenV012Lock(workflowId) {
  const encoded = await readFile(
    path.join(V012_FIXTURES, `${workflowId}.lock.yml.gz.b64`),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}
async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const workflow = await readFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.md`),
    "utf8",
  );
  let source;
  if (workflowId === "rivet-issue-triage") {
    source = gunzipSync(
      Buffer.from(
        await readFile(
          path.join(
            PACKAGE_ROOT,
            "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
          ),
          "utf8",
        ),
        "base64",
      ),
    ).toString("utf8");
  } else if (workflowId === "rivet-maintenance") {
    const fixture = workflow.includes('cron: "17 3 * * 1"')
      ? MAINTENANCE_FIXTURES.scheduled
      : MAINTENANCE_FIXTURES.manual;
    source = gunzipSync(
      Buffer.from(await readFile(fixture, "utf8"), "base64"),
    ).toString("utf8");
  } else if (
    workflowId === "rivet-review" &&
    workflow.includes(REVIEWER_PATH)
  ) {
    source = await currentReviewLock(PACKAGE_ROOT, workflow);
  } else if (workflow.includes(FIXER_PATH)) {
    source = "name: rivet-repair-current\n";
  } else {
    source = await frozenV012Lock(workflowId);
  }
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    source,
  );
}
async function removeIssueTriage(repositoryRoot) {
  for (const relativePath of ISSUE_TRIAGE_PATHS) {
    await rm(path.join(repositoryRoot, relativePath));
  }
  const receiptPath = path.join(
    repositoryRoot,
    ".github/rivet/installation.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.managedFiles = receipt.managedFiles.filter(
    (relativePath) => !ISSUE_TRIAGE_PATHS.includes(relativePath),
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}
async function fixtureValidator() {}
function countStatus(result, status) {
  return result.files.filter(({ status: fileStatus }) => fileStatus === status)
    .length;
}
async function writeAsset(repositoryRoot, group, relativePath) {
  const destination = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(
    destination,
    await readFile(
      path.join(PACKAGE_ROOT, "assets", group, relativePath),
      "utf8",
    ),
  );
}
async function writeLegacyInstallation({
  repositoryRoot,
  mode,
  configuration,
}) {
  const expectedConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  if (mode === "repair") expectedConfiguration.repair.authority = "owner";
  assert.deepEqual(configuration, expectedConfiguration);
  for (const relativePath of REVIEW_ASSETS) {
    await writeAsset(repositoryRoot, "review", relativePath);
  }
  if (mode === "repair") {
    for (const relativePath of REPAIR_ASSETS) {
      await writeAsset(repositoryRoot, "repair", relativePath);
    }
  }
  await mkdir(path.join(repositoryRoot, ".github/workflows"), {
    recursive: true,
  });
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    await readFile(path.join(V012_FIXTURES, "rivet-review.md"), "utf8"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
    await frozenV012Lock("rivet-review"),
  );
  if (mode === "repair") {
    await writeFile(
      path.join(repositoryRoot, ".github/workflows/rivet-repair.md"),
      await readFile(path.join(V012_FIXTURES, "rivet-repair.md"), "utf8"),
    );
    await writeFile(
      path.join(repositoryRoot, ".github/workflows/rivet-repair.lock.yml"),
      await frozenV012Lock("rivet-repair"),
    );
  }
  await writeFile(
    path.join(repositoryRoot, ".github/rivet.json"),
    `${JSON.stringify(configuration, null, 2)}\n`,
  );
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/installation.json"),
    await readFile(
      path.join(V012_FIXTURES, `${mode}-installation.json`),
      "utf8",
    ),
  );
}
test("installs only the trusted Rivet review mode", async (t) => {
  const repositoryRoot = await repository(t);
  const result = await installReview({
    repositoryRoot,
    binaryPath: "/cache/gh-aw",
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.mode, "review");
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.githubApp, {
    clientIdVariable: "RIVET_APP_CLIENT_ID",
    privateKeySecret: "RIVET_APP_PRIVATE_KEY",
    permissions: {
      contents: "read",
      issues: "write",
      metadata: "read",
      pullRequests: "write",
    },
    events: [],
  });
  assert.equal(result.files.length, 15);
  assert.ok(result.files.every(({ status }) => status === "create"));
  const configuration = JSON.parse(
    await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
  );
  assert.equal(configuration.schemaVersion, 4);
  assert.equal(configuration.review.automatic, true);
  assert.equal(configuration.repair.authority, "never");
  assert.equal(configuration.issues.triage, "automatic");
  assert.equal(configuration.merge.authority, "never");
  const installation = JSON.parse(
    await readFile(
      path.join(repositoryRoot, ".github/rivet/installation.json"),
      "utf8",
    ),
  );
  assert.equal(installation.product, "Rivet");
  assert.equal(installation.configSchemaVersion, 4);
  assert.deepEqual(installation.productAuthority, result.productAuthority);
  assert.deepEqual(installation.githubApp, result.githubApp);
  assert.equal(installation.compiler.version, "0.86.2");
  assert.deepEqual(
    installation.managedFiles,
    result.files.map(({ path: filePath }) => filePath),
  );
  assert.doesNotMatch(
    await readFile(
      path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
      "utf8",
    ),
    /Codekeeper/i,
  );
  assert.equal(
    await readFile(path.join(repositoryRoot, REVIEWER_PATH), "utf8"),
    await readFile(
      path.join(PACKAGE_ROOT, "assets/agents/pr-reviewer.md"),
      "utf8",
    ),
  );
  assert.equal(
    await readFile(path.join(repositoryRoot, ISSUE_TRIAGER_PATH), "utf8"),
    await readFile(
      path.join(PACKAGE_ROOT, "assets/agents/issue-triager.md"),
      "utf8",
    ),
  );
  assert.match(
    await readFile(
      path.join(repositoryRoot, ".github/workflows/rivet-issue-triage.md"),
      "utf8",
    ),
    /issues:\n    types: \[opened\]/,
  );
  const repeated = await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.ok(repeated.files.every(({ status }) => status === "unchanged"));
});
test("dry-run compiles and reports without writing repository files", async (t) => {
  const repositoryRoot = await repository(t);
  const result = await installReview({
    repositoryRoot,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.dryRun, true);
  await assert.rejects(access(path.join(repositoryRoot, ".github")), {
    code: "ENOENT",
  });
});
test("installs scheduled report-only maintenance without widening App authority", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  const result = await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.files.length, 20);
  assert.deepEqual(result.githubApp.permissions, {
    contents: "read",
    issues: "write",
    metadata: "read",
    pullRequests: "write",
  });
  assert.ok(
    MAINTENANCE_PATHS.every((relativePath) =>
      result.files.some(({ path: filePath }) => filePath === relativePath),
    ),
  );
  assert.equal(
    await readFile(
      path.join(repositoryRoot, ".github/rivet/agents/repository-auditor.md"),
      "utf8",
    ),
    await readFile(
      path.join(PACKAGE_ROOT, "assets/agents/repository-auditor.md"),
      "utf8",
    ),
  );
  assert.equal(
    await readFile(
      path.join(
        repositoryRoot,
        ".github/rivet/actions/validate-audit/index.mjs",
      ),
      "utf8",
    ),
    await readFile(
      path.join(
        PACKAGE_ROOT,
        "assets/maintenance/.github/rivet/actions/validate-audit/index.mjs",
      ),
      "utf8",
    ),
  );
});
test("disabled maintenance omits its profile, workflow, and validator", async (t) => {
  const repositoryRoot = await repository(t);
  const result = await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.ok(
    MAINTENANCE_PATHS.every(
      (relativePath) =>
        !result.files.some(({ path: filePath }) => filePath === relativePath),
    ),
  );
});
test("upgrades an exact profiled installation with scheduled maintenance", async (t) => {
  const repositoryRoot = await repository(t);
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  const result = await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(countStatus(result, "create"), 5);
  assert.equal(countStatus(result, "update"), 2);
  assert.ok(
    MAINTENANCE_PATHS.every((relativePath) =>
      result.files.some(
        ({ path: filePath, status }) =>
          filePath === relativePath && status === "create",
      ),
    ),
  );
});
test("refuses a modified maintenance workflow before writes", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "manual";
  await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const workflowPath = path.join(
    repositoryRoot,
    ".github/workflows/rivet-maintenance.md",
  );
  const modified = `${await readFile(workflowPath, "utf8")}modified\n`;
  await writeFile(workflowPath, modified);
  await assert.rejects(
    installReview({
      repositoryRoot,
      configuration,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    }),
    /refusing to overwrite \.github\/workflows\/rivet-maintenance\.md/,
  );
  assert.equal(await readFile(workflowPath, "utf8"), modified);
});
test("transitions exact maintenance installs between manual and scheduled", async (t) => {
  const repositoryRoot = await repository(t);
  const manualConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  manualConfiguration.maintenance.mode = "manual";
  await installReview({
    repositoryRoot,
    configuration: manualConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const scheduledConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  scheduledConfiguration.maintenance.mode = "scheduled";
  const scheduledResult = await installReview({
    repositoryRoot,
    configuration: scheduledConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(countStatus(scheduledResult, "update"), 4);
  assert.equal(countStatus(scheduledResult, "delete"), 0);
  const manualResult = await installReview({
    repositoryRoot,
    configuration: manualConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(countStatus(manualResult, "update"), 4);
  assert.equal(countStatus(manualResult, "delete"), 0);
});
test("disables maintenance with five exact deletion entries", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const unrelatedPath = ".github/workflows/rivet-maintenance.extra.md";
  const unrelatedFile = path.join(repositoryRoot, unrelatedPath);
  await mkdir(path.dirname(unrelatedFile), { recursive: true });
  await writeFile(unrelatedFile, "adopter-owned\n");
  const result = await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "delete")
      .map(({ path: filePath }) => filePath)
      .sort(),
    [...MAINTENANCE_PATHS].sort(),
  );
  assert.equal(
    result.files.filter(({ status }) => status === "delete").length,
    5,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    2,
  );
  for (const relativePath of MAINTENANCE_PATHS) {
    await assert.rejects(access(path.join(repositoryRoot, relativePath)), {
      code: "ENOENT",
    });
  }
  assert.equal(
    await readFile(path.join(repositoryRoot, unrelatedPath), "utf8"),
    "adopter-owned\n",
  );
});
test("refuses a modified maintenance file when disabling", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "manual";
  await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const modifiedPath = MAINTENANCE_PATHS[2];
  const modifiedFile = path.join(repositoryRoot, modifiedPath);
  const modified = `${await readFile(modifiedFile, "utf8")}modified\n`;
  await writeFile(modifiedFile, modified);
  const configurationPath = path.join(repositoryRoot, ".github/rivet.json");
  const configurationBytes = await readFile(configurationPath, "utf8");
  await assert.rejects(
    installReview({
      repositoryRoot,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    }),
    new RegExp(`refusing to delete ${modifiedPath.replaceAll("/", "\\/")}`),
  );
  assert.equal(await readFile(modifiedFile, "utf8"), modified);
  assert.equal(await readFile(configurationPath, "utf8"), configurationBytes);
});
test("refuses a maintenance file changed after a disable plan", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const plan = await prepareReviewInstallation({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const modifiedPath = MAINTENANCE_PATHS[4];
  const modifiedFile = path.join(repositoryRoot, modifiedPath);
  const modified = `${await readFile(modifiedFile, "utf8")}modified\n`;
  await writeFile(modifiedFile, modified);
  await assert.rejects(applyInstallation(plan), /changed after planning/);
  assert.equal(await readFile(modifiedFile, "utf8"), modified);
  for (const relativePath of MAINTENANCE_PATHS) {
    await access(path.join(repositoryRoot, relativePath));
  }
});
test("transitions and disables maintenance in repair mode", async (t) => {
  const repositoryRoot = await repository(t);
  const manualConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  manualConfiguration.repair.authority = "owner";
  manualConfiguration.maintenance.mode = "manual";
  await installRepair({
    repositoryRoot,
    configuration: manualConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const scheduledConfiguration = structuredClone(manualConfiguration);
  scheduledConfiguration.maintenance.mode = "scheduled";
  const scheduledResult = await installRepair({
    repositoryRoot,
    configuration: scheduledConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(
    scheduledResult.files.filter(({ status }) => status === "update").length,
    4,
  );
  const disabledResult = await installRepair({
    repositoryRoot,
    configuration: {
      ...structuredClone(manualConfiguration),
      maintenance: { mode: "disabled" },
    },
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(
    disabledResult.files.filter(({ status }) => status === "delete").length,
    5,
  );
});
test("installs a fresh repair with both active agent profiles", async (t) => {
  const repositoryRoot = await repository(t);
  const result = await installRepair({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.files.length, 22);
  assert.ok(result.files.every(({ status }) => status === "create"));
  assert.equal(
    await readFile(path.join(repositoryRoot, FIXER_PATH), "utf8"),
    await readFile(path.join(PACKAGE_ROOT, "assets/agents/fixer.md"), "utf8"),
  );
});
test("upgrades an exact 0.1.2 review installation", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  await writeLegacyInstallation({
    repositoryRoot,
    mode: "review",
    configuration,
  });
  const result = await installReview({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.files.length, 15);
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    8,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    3,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "unchanged").length,
    4,
  );
});
test("upgrades an exact 0.1.2 review installation to repair", async (t) => {
  const repositoryRoot = await repository(t);
  const reviewConfig = structuredClone(DEFAULT_RIVET_CONFIG);
  await writeLegacyInstallation({
    repositoryRoot,
    mode: "review",
    configuration: reviewConfig,
  });
  const repairConfig = structuredClone(reviewConfig);
  repairConfig.repair.authority = "owner";
  const result = await installRepair({
    repositoryRoot,
    configuration: repairConfig,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.files.length, 22);
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    15,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    4,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "unchanged").length,
    3,
  );
});
test("upgrades an exact 0.1.2 repair installation", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.repair.authority = "owner";
  await writeLegacyInstallation({
    repositoryRoot,
    mode: "repair",
    configuration,
  });
  const result = await installRepair({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.files.length, 22);
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    9,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    5,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "unchanged").length,
    8,
  );
});
test("refuses a modified 0.1.2 installation before upgrading", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  await writeLegacyInstallation({
    repositoryRoot,
    mode: "review",
    configuration,
  });
  const reviewPath = path.join(
    repositoryRoot,
    ".github/workflows/rivet-review.md",
  );
  await writeFile(
    reviewPath,
    `${await readFile(reviewPath, "utf8")}modified\n`,
  );
  await assert.rejects(
    installReview({
      repositoryRoot,
      configuration,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    }),
    /refusing to overwrite/,
  );
  await assert.rejects(access(path.join(repositoryRoot, REVIEWER_PATH)), {
    code: "ENOENT",
  });
});
test("adds issue triage to the exact previous profiled installation", async (t) => {
  const repositoryRoot = await repository(t);
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  await removeIssueTriage(repositoryRoot);
  const result = await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    5,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    1,
  );
});
test("adds issue triage while upgrading the previous review to repair", async (t) => {
  const repositoryRoot = await repository(t);
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  await removeIssueTriage(repositoryRoot);
  const result = await installRepair({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.files.length, 22);
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    12,
  );
});
test("refuses a hybrid 0.1.2 installation before upgrading", async (t) => {
  const repositoryRoot = await repository(t);
  const reviewRoot = await repository(t);
  const reviewConfig = structuredClone(DEFAULT_RIVET_CONFIG);
  await writeLegacyInstallation({
    repositoryRoot: reviewRoot,
    mode: "review",
    configuration: reviewConfig,
  });
  const repairConfig = structuredClone(reviewConfig);
  repairConfig.repair.authority = "owner";
  await writeLegacyInstallation({
    repositoryRoot,
    mode: "repair",
    configuration: repairConfig,
  });
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/installation.json"),
    await readFile(
      path.join(reviewRoot, ".github/rivet/installation.json"),
      "utf8",
    ),
  );
  await assert.rejects(
    installRepair({
      repositoryRoot,
      configuration: repairConfig,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    }),
    /refusing to overwrite/,
  );
  await assert.rejects(access(path.join(repositoryRoot, REVIEWER_PATH)), {
    code: "ENOENT",
  });
});
test("refuses a collision before creating any managed file", async (t) => {
  const repositoryRoot = await repository(t);
  const configPath = path.join(repositoryRoot, ".github/rivet.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, '{"owner":"adopter"}\n');
  await assert.rejects(
    installReview({
      repositoryRoot,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    }),
    /refusing to overwrite \.github\/rivet\.json/,
  );
  assert.equal(await readFile(configPath, "utf8"), '{"owner":"adopter"}\n');
  await assert.rejects(
    access(path.join(repositoryRoot, ".github/rivet/installation.json")),
    { code: "ENOENT" },
  );
});
test("compiler failure leaves the repository untouched", async (t) => {
  const repositoryRoot = await repository(t);
  await assert.rejects(
    installReview({
      repositoryRoot,
      validateWorkflow: fixtureValidator,
      compileWorkflow: async () => {
        throw new Error("compiler unavailable");
      },
    }),
    /compiler unavailable/,
  );
  await assert.rejects(access(path.join(repositoryRoot, ".github")), {
    code: "ENOENT",
  });
});
test("refuses a repository path that does not exist", async (t) => {
  const repositoryRoot = await repository(t);
  await assert.rejects(
    installReview({ repositoryRoot: path.join(repositoryRoot, "missing") }),
    /repository root does not exist/,
  );
});
test("upgrades an exact review installation to owner-authorized repair", async (t) => {
  const repositoryRoot = await repository(t);
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const result = await installRepair({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.mode, "repair");
  assert.equal(result.files.length, 22);
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    2,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    7,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "unchanged").length,
    13,
  );
  assert.deepEqual(result.githubApp.permissions, {
    contents: "write",
    metadata: "read",
    pullRequests: "write",
    issues: "write",
  });
  const config = JSON.parse(
    await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
  );
  const installation = JSON.parse(
    await readFile(
      path.join(repositoryRoot, ".github/rivet/installation.json"),
      "utf8",
    ),
  );
  assert.equal(config.repair.authority, "owner");
  assert.equal(installation.mode, "repair");
  assert.equal(installation.managedFiles.length, 22);
  assert.deepEqual(installation.githubApp.permissions, {
    contents: "write",
    metadata: "read",
    pullRequests: "write",
    issues: "write",
  });
});
test("upgrades a triage-disabled review without granting Issues", async (t) => {
  const repositoryRoot = await repository(t);
  const reviewConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  reviewConfiguration.issues.triage = "disabled";
  const reviewResult = await installReview({
    repositoryRoot,
    configuration: reviewConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(reviewResult.files.length, 10);
  assert.ok(
    reviewResult.files.every(
      ({ path: relativePath }) => !ISSUE_TRIAGE_PATHS.includes(relativePath),
    ),
  );
  const repairConfiguration = structuredClone(reviewConfiguration);
  repairConfiguration.repair.authority = "owner";
  const result = await installRepair({
    repositoryRoot,
    configuration: repairConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(result.files.length, 17);
  assert.ok(
    result.files.every(
      ({ path: relativePath }) => !ISSUE_TRIAGE_PATHS.includes(relativePath),
    ),
  );
  assert.deepEqual(result.githubApp.permissions, {
    contents: "write",
    metadata: "read",
    pullRequests: "write",
  });
  const installation = JSON.parse(
    await readFile(
      path.join(repositoryRoot, ".github/rivet/installation.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    installation.githubApp.permissions,
    result.githubApp.permissions,
  );
});
test("refuses a modified review installation before upgrading", async (t) => {
  const repositoryRoot = await repository(t);
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const reviewPath = path.join(
    repositoryRoot,
    ".github/workflows/rivet-review.md",
  );
  await writeFile(reviewPath, "adopter workflow\n");
  await assert.rejects(
    installRepair({
      repositoryRoot,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: fixtureValidator,
    }),
    /refusing to overwrite/,
  );
  await assert.rejects(
    access(path.join(repositoryRoot, ".github/workflows/rivet-repair.md")),
    { code: "ENOENT" },
  );
});
test("refuses files changed after the repair plan is prepared", async (t) => {
  const repositoryRoot = await repository(t);
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const plan = await prepareRepairInstallation({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  await writeFile(path.join(repositoryRoot, ".github/rivet.json"), "changed\n");
  await assert.rejects(applyInstallation(plan), /changed after planning/);
  await assert.rejects(
    access(path.join(repositoryRoot, ".github/workflows/rivet-repair.md")),
    { code: "ENOENT" },
  );
});
test("preserves semantic-only compiler lock drift during upgrade", async (t) => {
  const repositoryRoot = await repository(t);
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const plan = await prepareRepairInstallation({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  const repairLock = plan.files.find(
    ({ path: filePath }) =>
      filePath === ".github/workflows/rivet-repair.lock.yml",
  );
  const existingContent = `# prior compiler formatting\n${repairLock.content}`;
  await writeFile(path.join(repositoryRoot, repairLock.path), existingContent);
  const result = await installRepair({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });
  assert.equal(
    result.files.find(({ path: filePath }) => filePath === repairLock.path)
      .status,
    "unchanged",
  );
  assert.equal(
    await readFile(path.join(repositoryRoot, repairLock.path), "utf8"),
    existingContent,
  );
});
