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
} from "../src/install.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";
const REVIEWER_PATH = ".github/rivet/agents/pr-reviewer.md";
const FIXER_PATH = ".github/rivet/agents/fixer.md";
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
  if (workflowId === "rivet-review" && workflow.includes(REVIEWER_PATH)) {
    source = await readFile(
      path.join(
        PACKAGE_ROOT,
        "test/fixtures/review/.github/workflows/rivet-review.lock.yml",
      ),
      "utf8",
    );
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

async function fixtureValidator() {}

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
  assert.equal(result.files.length, 8);
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
  assert.equal(result.files.length, 8);
  await assert.rejects(access(path.join(repositoryRoot, ".github")), {
    code: "ENOENT",
  });
});

test("installs a fresh repair with both active agent profiles", async (t) => {
  const repositoryRoot = await repository(t);
  const result = await installRepair({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });

  assert.equal(result.files.length, 15);
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

  assert.equal(result.files.length, 8);
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    1,
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

  assert.equal(result.files.length, 15);
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    8,
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

  assert.equal(result.files.length, 15);
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    2,
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
    { code: "ENOENT" },
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
  assert.equal(result.files.length, 15);
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
    6,
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
  assert.equal(installation.managedFiles.length, 15);
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
  await installReview({
    repositoryRoot,
    configuration: reviewConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });

  const repairConfiguration = structuredClone(reviewConfiguration);
  repairConfiguration.repair.authority = "owner";

  const result = await installRepair({
    repositoryRoot,
    configuration: repairConfiguration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });

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

test("normalizes semantic-only compiler lock drift during upgrade", async (t) => {
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
  await writeFile(
    path.join(repositoryRoot, repairLock.path),
    `# prior compiler formatting\n${repairLock.content}`,
  );

  const result = await installRepair({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: fixtureValidator,
  });

  assert.equal(
    result.files.find(({ path: filePath }) => filePath === repairLock.path)
      .status,
    "update",
  );
  assert.equal(
    await readFile(path.join(repositoryRoot, repairLock.path), "utf8"),
    repairLock.content,
  );
});
