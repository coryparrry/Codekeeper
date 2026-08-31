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
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { installRepair } from "../src/install.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const FIXER_PATH = ".github/rivet/agents/fixer.md";
const REVIEWER_PATH = ".github/rivet/agents/pr-reviewer.md";
const ISSUE_TRIAGE_PATHS = [
  ".github/rivet/agents/issue-triager.md",
  ".github/workflows/rivet-issue-triage.md",
  ".github/workflows/rivet-issue-triage.lock.yml",
];
const REVIEW_ASSETS = [
  ".github/rivet/actions/authority-receipt/action.yml",
  ".github/rivet/actions/authority-receipt/index.mjs",
  ".github/rivet/aw/review-extension.md",
];
const REPAIR_ASSETS = [
  ".github/rivet/actions/publish-repair/action.yml",
  ".github/rivet/actions/publish-repair/index.mjs",
  ".github/rivet/actions/validate-repair/action.yml",
  ".github/rivet/actions/validate-repair/index.mjs",
];
const V012_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.2");

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-pre-triage-test-"));
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
  const source =
    workflowId === "rivet-review" && workflow.includes(REVIEWER_PATH)
      ? await readFile(
          path.join(
            PACKAGE_ROOT,
            "test/fixtures/review/.github/workflows/rivet-review.lock.yml",
          ),
          "utf8",
        )
      : workflow.includes(FIXER_PATH)
        ? "name: rivet-repair-current\n"
        : await frozenV012Lock(workflowId);
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    source,
  );
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

async function writeLegacyInstallation(repositoryRoot, configuration) {
  for (const relativePath of REVIEW_ASSETS) {
    await writeAsset(repositoryRoot, "review", relativePath);
  }
  for (const relativePath of REPAIR_ASSETS) {
    await writeAsset(repositoryRoot, "repair", relativePath);
  }
  await mkdir(path.join(repositoryRoot, ".github/workflows"), {
    recursive: true,
  });
  let reviewWorkflow = await readFile(
    path.join(V012_FIXTURES, "rivet-review.md"),
    "utf8",
  );
  reviewWorkflow = reviewWorkflow.replace(
    /\n  create-issue:\n    title-prefix: "\[rivet\] "\n    max: 1\n    deduplicate-by-title: true\n/,
    "\n",
  );
  reviewWorkflow = reviewWorkflow.replace(
    /\nTriage each supported finding before publication\.[\s\S]*?implementation\.\n/,
    "",
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    reviewWorkflow,
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
    await frozenV012Lock("rivet-review"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-repair.md"),
    await readFile(path.join(V012_FIXTURES, "rivet-repair.md"), "utf8"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-repair.lock.yml"),
    await frozenV012Lock("rivet-repair"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/rivet.json"),
    `${JSON.stringify(configuration, null, 2)}\n`,
  );
  const installation = JSON.parse(
    await readFile(
      path.join(V012_FIXTURES, "repair-installation.json"),
      "utf8",
    ),
  );
  installation.productAuthority = installation.productAuthority.map(
    (authority) =>
      authority === "Issue triage is automatic."
        ? "Issue triage is disabled."
        : authority,
  );
  delete installation.githubApp.permissions.issues;
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/installation.json"),
    `${JSON.stringify(installation, null, 2)}\n`,
  );
}

test("dry-runs explicit pre-triage repair upgrade and rejects mutation", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  configuration.repair.authority = "owner";
  await writeLegacyInstallation(repositoryRoot, configuration);

  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.files.length, 15);
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

  const reviewPath = path.join(
    repositoryRoot,
    ".github/workflows/rivet-review.md",
  );
  const modifiedReview = `${await readFile(reviewPath, "utf8")}modified\n`;
  await writeFile(reviewPath, modifiedReview);
  await assert.rejects(
    installRepair({
      repositoryRoot,
      configuration,
      dryRun: true,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
    }),
    /refusing to overwrite/,
  );
  assert.equal(await readFile(reviewPath, "utf8"), modifiedReview);
  await assert.rejects(access(path.join(repositoryRoot, FIXER_PATH)), {
    code: "ENOENT",
  });
});
