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
import { installRepair, installReview } from "../src/install.mjs";
import {
  renderRivetReviewWorkflow,
  renderRivetReviewWorkflowV0111,
  renderRivetReviewWorkflowV017,
  renderRivetReviewWorkflowV019,
} from "../src/workflows/review.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

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
const REVIEW_CONTEXT_ASSETS = [
  ".github/rivet/actions/prepare-review-context/action.yml",
  ".github/rivet/actions/prepare-review-context/index.mjs",
];
const REPAIR_ASSETS = [
  ".github/rivet/actions/publish-repair/action.yml",
  ".github/rivet/actions/publish-repair/index.mjs",
  ".github/rivet/actions/validate-repair/action.yml",
  ".github/rivet/actions/validate-repair/index.mjs",
];
const V012_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.2");
const V013_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.3");
const V015_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.5");
const V017_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.7");
const V019_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.9");
const V0111_FIXTURES = path.join(PACKAGE_ROOT, "test/fixtures/v0.1.11");
const MAINTENANCE_FIXTURES = path.join(
  PACKAGE_ROOT,
  "test/fixtures/maintenance",
);
const V013_EXTENSION = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.3/review-extension.md",
);
const V015_EXTENSION = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.5/review-extension.md",
);
const V017_EXTENSION = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.7/review-extension.md",
);
const V017_WORKFLOW_SOURCE = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.7/rivet-review.md",
);
const V019_EXTENSION = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.9/review-extension.md",
);
const V019_WORKFLOW_SOURCE = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.9/rivet-review.md",
);
const V0111_EXTENSION = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.11/review-extension.md",
);
const V0111_WORKFLOW_SOURCE = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.11/rivet-review.md",
);
const V0112_PUBLISH_REPAIR = path.join(
  PACKAGE_ROOT,
  "assets/upgrades/v0.1.12/publish-repair-index.mjs",
);
const V017_DISABLED_WORKFLOW_SOURCE = path.join(
  V017_FIXTURES,
  "rivet-review-disabled.md",
);
const V013_REVIEW_PATHS = [
  ".github/rivet/aw/review-extension.md",
  ".github/workflows/rivet-review.lock.yml",
  ".github/workflows/rivet-review.md",
];

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

async function frozenV013ReviewLock() {
  const encoded = await readFile(
    path.join(V013_FIXTURES, "rivet-review-disabled.lock.yml.gz.b64"),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function frozenV015ReviewLock() {
  const encoded = await readFile(
    path.join(V015_FIXTURES, "rivet-review.lock.yml.gz.b64"),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function frozenV017ReviewLock(issueTriage = "automatic") {
  const encoded = await readFile(
    path.join(
      V017_FIXTURES,
      `rivet-review${issueTriage === "automatic" ? "" : "-disabled"}.lock.yml.gz.b64`,
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function frozenV019ReviewLock(issueTriage = "automatic") {
  const encoded = await readFile(
    path.join(
      V019_FIXTURES,
      `rivet-review${issueTriage === "automatic" ? "" : "-disabled"}.lock.yml.gz.b64`,
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function frozenV0111ReviewLock(issueTriage = "automatic") {
  const encoded = await readFile(
    path.join(
      V0111_FIXTURES,
      `rivet-review${issueTriage === "automatic" ? "" : "-disabled"}.lock.yml.gz.b64`,
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function frozenMaintenanceLock(workflow) {
  const mode = workflow.includes("schedule:") ? "scheduled" : "manual";
  const encoded = await readFile(
    path.join(
      MAINTENANCE_FIXTURES,
      `rivet-maintenance-${mode}.lock.yml.gz.b64`,
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function frozenIssueTriageLock() {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}

async function removeReviewContextAssets(repositoryRoot) {
  await Promise.all(
    REVIEW_CONTEXT_ASSETS.map((relativePath) =>
      rm(path.join(repositoryRoot, relativePath)),
    ),
  );
  const receiptPath = path.join(
    repositoryRoot,
    ".github/rivet/installation.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.managedFiles = receipt.managedFiles.filter(
    (relativePath) => !REVIEW_CONTEXT_ASSETS.includes(relativePath),
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const workflow = await readFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.md`),
    "utf8",
  );
  const reviewExtension =
    workflowId === "rivet-review"
      ? await readFile(
          path.join(repositoryRoot, ".github/rivet/aw/review-extension.md"),
          "utf8",
        )
      : "";
  const issueTriage = workflow.includes("\n  create-issue:\n")
    ? "automatic"
    : "disabled";
  const source =
    workflowId === "rivet-maintenance"
      ? await frozenMaintenanceLock(workflow)
      : workflowId === "rivet-issue-triage"
        ? await frozenIssueTriageLock()
        : workflowId === "rivet-review" && workflow.includes(REVIEWER_PATH)
          ? workflow.includes("?effort=low")
            ? await frozenV019ReviewLock(issueTriage)
            : workflow.includes("max-turns: 6")
              ? reviewExtension.includes("method `get_diff`")
                ? await frozenV015ReviewLock()
                : await frozenV017ReviewLock(issueTriage)
              : workflow.includes("max-turns: 3")
                ? reviewExtension.includes("method `get_diff`")
                  ? await frozenV015ReviewLock()
                  : reviewExtension.includes("Trusted bounded comparison")
                    ? workflow.includes(
                        "does not select the GitHub review event",
                      )
                      ? await currentReviewLock(PACKAGE_ROOT, workflow)
                      : await frozenV0111ReviewLock(issueTriage)
                    : await frozenV017ReviewLock(issueTriage)
                : await frozenV013ReviewLock()
          : workflow.includes(FIXER_PATH)
            ? "name: rivet-repair-current\n"
            : await frozenV012Lock(workflowId);
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    source,
  );
}

async function writeProfiledV013Installation(
  repositoryRoot,
  configuration,
  install = installRepair,
) {
  await install({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await removeReviewContextAssets(repositoryRoot);
  await writeFile(
    path.join(repositoryRoot, V013_REVIEW_PATHS[0]),
    await readFile(V013_EXTENSION, "utf8"),
  );
  await writeFile(
    path.join(repositoryRoot, V013_REVIEW_PATHS[1]),
    await frozenV013ReviewLock(),
  );
  await writeFile(
    path.join(repositoryRoot, V013_REVIEW_PATHS[2]),
    renderRivetReviewWorkflow({
      configuration: { ...configuration, repair: { authority: "never" } },
      includeReviewBudget: false,
    }),
  );
}

async function writeProfiledV015Installation(
  repositoryRoot,
  configuration,
  install = installRepair,
) {
  await install({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await removeReviewContextAssets(repositoryRoot);
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/aw/review-extension.md"),
    await readFile(V015_EXTENSION, "utf8"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    renderRivetReviewWorkflowV017({
      configuration: { ...configuration, repair: { authority: "never" } },
    }),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
    await frozenV015ReviewLock(),
  );
}

async function writeProfiledV017Installation(
  repositoryRoot,
  configuration,
  install = installRepair,
) {
  await install({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await removeReviewContextAssets(repositoryRoot);
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/aw/review-extension.md"),
    await readFile(V017_EXTENSION, "utf8"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    renderRivetReviewWorkflowV017({
      configuration: { ...configuration, repair: { authority: "never" } },
    }),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
    await frozenV017ReviewLock(configuration.issues.triage),
  );
}

async function writeProfiledV019Installation(repositoryRoot, configuration) {
  await installRepair({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/aw/review-extension.md"),
    await readFile(V019_EXTENSION, "utf8"),
  );
  const workflow = renderRivetReviewWorkflowV019({
    configuration: { ...configuration, repair: { authority: "never" } },
  });
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    workflow,
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
    await frozenV019ReviewLock(configuration.issues.triage),
  );
}

async function writeProfiledV0111Installation(
  repositoryRoot,
  configuration,
  install = installRepair,
) {
  await install({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/aw/review-extension.md"),
    await readFile(V0111_EXTENSION, "utf8"),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.md"),
    renderRivetReviewWorkflowV0111({
      configuration: { ...configuration, repair: { authority: "never" } },
    }),
  );
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-review.lock.yml"),
    await frozenV0111ReviewLock(configuration.issues.triage),
  );
}

async function writeV0112Installation(repositoryRoot, configuration) {
  await installRepair({
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await writeFile(
    path.join(repositoryRoot, ".github/rivet/actions/publish-repair/index.mjs"),
    await readFile(V0112_PUBLISH_REPAIR, "utf8"),
  );
}

test("freezes the released 0.1.7 review workflow sources", async () => {
  assert.equal(
    renderRivetReviewWorkflowV017(),
    await readFile(V017_WORKFLOW_SOURCE, "utf8"),
  );
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  assert.equal(
    renderRivetReviewWorkflowV017({ configuration }),
    await readFile(V017_DISABLED_WORKFLOW_SOURCE, "utf8"),
  );
});

test("freezes the released 0.1.9 review workflow source", async () => {
  assert.equal(
    renderRivetReviewWorkflowV019(),
    await readFile(V019_WORKFLOW_SOURCE, "utf8"),
  );
  assert.doesNotMatch(
    await frozenV019ReviewLock(),
    /does not select the GitHub review event/,
  );
});

test("freezes the released 0.1.11 review workflow source", async () => {
  assert.equal(
    renderRivetReviewWorkflowV0111(),
    await readFile(V0111_WORKFLOW_SOURCE, "utf8"),
  );
});

test("upgrades the exact released 0.1.12 repair action", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  configuration.repair.authority = "owner";
  const repositoryRoot = await repository(t);
  await writeV0112Installation(repositoryRoot, configuration);
  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [".github/rivet/actions/publish-repair/index.mjs"],
  );
  const modifiedRoot = await repository(t);
  await writeV0112Installation(modifiedRoot, configuration);
  const target = path.join(
    modifiedRoot,
    ".github/rivet/actions/publish-repair/index.mjs",
  );
  const modified = `${await readFile(target, "utf8")}modified\n`;
  await writeFile(target, modified);
  await assert.rejects(
    installRepair({
      repositoryRoot: modifiedRoot,
      configuration,
      dryRun: true,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
    }),
    /refusing to overwrite/,
  );
  assert.equal(await readFile(target, "utf8"), modified);
});

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

test("upgrades only an exact 0.1.3 profiled repair installation", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  configuration.repair.authority = "owner";
  const repositoryRoot = await repository(t);
  await writeProfiledV013Installation(repositoryRoot, configuration);

  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/rivet/aw/review-extension.md",
      ".github/rivet/installation.json",
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "create")
      .map(({ path: relativePath }) => relativePath),
    REVIEW_CONTEXT_ASSETS,
  );

  for (const relativePath of V013_REVIEW_PATHS) {
    await t.test(`rejects modified ${relativePath}`, async () => {
      const modifiedRoot = await repository(t);
      await writeProfiledV013Installation(modifiedRoot, configuration);
      const target = path.join(modifiedRoot, relativePath);
      const modified = `${await readFile(target, "utf8")}modified\n`;
      await writeFile(target, modified);
      await assert.rejects(
        installRepair({
          repositoryRoot: modifiedRoot,
          configuration,
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

test("upgrades an exact 0.1.7 review installation with enabled features", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "automatic";
  configuration.maintenance.mode = "scheduled";
  const repositoryRoot = await repository(t);
  await writeProfiledV017Installation(
    repositoryRoot,
    configuration,
    installReview,
  );

  const result = await installReview({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/rivet/aw/review-extension.md",
      ".github/rivet/installation.json",
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "create")
      .map(({ path: relativePath }) => relativePath),
    REVIEW_CONTEXT_ASSETS,
  );
});

test("upgrades an exact 0.1.3 profiled review installation", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  const repositoryRoot = await repository(t);
  await writeProfiledV013Installation(
    repositoryRoot,
    configuration,
    installReview,
  );

  const result = await installReview({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/rivet/aw/review-extension.md",
      ".github/rivet/installation.json",
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );
});

test("upgrades an exact 0.1.5 profiled repair installation", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  configuration.repair.authority = "owner";
  const repositoryRoot = await repository(t);
  await writeProfiledV015Installation(repositoryRoot, configuration);

  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/rivet/aw/review-extension.md",
      ".github/rivet/installation.json",
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );

  for (const relativePath of [
    ".github/rivet/aw/review-extension.md",
    ".github/workflows/rivet-review.lock.yml",
    ".github/workflows/rivet-review.md",
  ]) {
    await t.test(`rejects modified ${relativePath}`, async () => {
      const modifiedRoot = await repository(t);
      await writeProfiledV015Installation(modifiedRoot, configuration);
      const target = path.join(modifiedRoot, relativePath);
      const modified = `${await readFile(target, "utf8")}modified\n`;
      await writeFile(target, modified);
      await assert.rejects(
        installRepair({
          repositoryRoot: modifiedRoot,
          configuration,
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

test("upgrades an exact 0.1.5 review installation to repair", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  const repositoryRoot = await repository(t);
  await writeProfiledV015Installation(
    repositoryRoot,
    configuration,
    installReview,
  );
  configuration.repair.authority = "owner";

  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/rivet.json",
      ".github/rivet/aw/review-extension.md",
      ".github/rivet/installation.json",
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );
});

test("upgrades an exact 0.1.7 profiled repair installation", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  configuration.repair.authority = "owner";
  configuration.maintenance.mode = "manual";
  const repositoryRoot = await repository(t);
  await writeProfiledV017Installation(repositoryRoot, configuration);

  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/rivet/aw/review-extension.md",
      ".github/rivet/installation.json",
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "create")
      .map(({ path: relativePath }) => relativePath),
    REVIEW_CONTEXT_ASSETS,
  );

  for (const relativePath of [
    ".github/rivet/aw/review-extension.md",
    ".github/workflows/rivet-review.lock.yml",
    ".github/workflows/rivet-review.md",
  ]) {
    await t.test(`rejects modified 0.1.7 ${relativePath}`, async () => {
      const modifiedRoot = await repository(t);
      await writeProfiledV017Installation(modifiedRoot, configuration);
      const target = path.join(modifiedRoot, relativePath);
      const modified = `${await readFile(target, "utf8")}modified\n`;
      await writeFile(target, modified);
      await assert.rejects(
        installRepair({
          repositoryRoot: modifiedRoot,
          configuration,
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

test("upgrades only an exact 0.1.9 profiled repair installation", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  configuration.repair.authority = "owner";
  const repositoryRoot = await repository(t);
  await writeProfiledV019Installation(repositoryRoot, configuration);

  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );

  for (const relativePath of [
    ".github/rivet/aw/review-extension.md",
    ".github/workflows/rivet-review.lock.yml",
    ".github/workflows/rivet-review.md",
  ]) {
    await t.test(`rejects modified 0.1.9 ${relativePath}`, async () => {
      const modifiedRoot = await repository(t);
      await writeProfiledV019Installation(modifiedRoot, configuration);
      const target = path.join(modifiedRoot, relativePath);
      const modified = `${await readFile(target, "utf8")}modified\n`;
      await writeFile(target, modified);
      await assert.rejects(
        installRepair({
          repositoryRoot: modifiedRoot,
          configuration,
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

test("upgrades only exact 0.1.11 profiled installations", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  configuration.repair.authority = "owner";
  const repositoryRoot = await repository(t);
  await writeProfiledV0111Installation(repositoryRoot, configuration);

  const result = await installRepair({
    repositoryRoot,
    configuration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    result.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );

  const reviewConfiguration = structuredClone(DEFAULT_RIVET_CONFIG);
  reviewConfiguration.issues.triage = "disabled";
  const reviewRoot = await repository(t);
  await writeProfiledV0111Installation(
    reviewRoot,
    reviewConfiguration,
    installReview,
  );
  const reviewResult = await installReview({
    repositoryRoot: reviewRoot,
    configuration: reviewConfiguration,
    dryRun: true,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  assert.deepEqual(
    reviewResult.files
      .filter(({ status }) => status === "update")
      .map(({ path: relativePath }) => relativePath),
    [
      ".github/workflows/rivet-review.lock.yml",
      ".github/workflows/rivet-review.md",
    ],
  );

  for (const relativePath of [
    ".github/rivet/aw/review-extension.md",
    ".github/workflows/rivet-review.lock.yml",
    ".github/workflows/rivet-review.md",
  ]) {
    await t.test(`rejects modified 0.1.11 ${relativePath}`, async () => {
      const modifiedRoot = await repository(t);
      await writeProfiledV0111Installation(modifiedRoot, configuration);
      const target = path.join(modifiedRoot, relativePath);
      const modified = `${await readFile(target, "utf8")}modified\n`;
      await writeFile(target, modified);
      await assert.rejects(
        installRepair({
          repositoryRoot: modifiedRoot,
          configuration,
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
