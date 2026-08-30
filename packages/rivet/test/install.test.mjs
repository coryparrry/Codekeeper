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
import {
  applyInstallation,
  installRepair,
  installReview,
  prepareRepairInstallation,
} from "../src/install.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const source = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/review/.github/workflows/rivet-review.lock.yml",
    ),
    "utf8",
  );
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    source,
  );
}

async function fixtureValidator() {}

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
  assert.equal(result.files.length, 7);
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
  assert.equal(result.files.length, 7);
  await assert.rejects(access(path.join(repositoryRoot, ".github")), {
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
  assert.equal(result.files.length, 13);
  assert.equal(
    result.files.filter(({ status }) => status === "update").length,
    2,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "create").length,
    6,
  );
  assert.equal(
    result.files.filter(({ status }) => status === "unchanged").length,
    5,
  );
  assert.deepEqual(result.githubApp.permissions, {
    contents: "write",
    metadata: "read",
    pullRequests: "write",
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
  assert.equal(installation.managedFiles.length, 13);
  assert.equal(installation.githubApp.permissions.contents, "write");
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
    /refusing to overwrite \.github\/workflows\/rivet-review\.md/,
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
