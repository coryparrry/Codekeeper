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
import {
  renderRivetIssueTriageWorkflowV013,
  renderRivetIssueTriageWorkflowV013Array,
} from "../src/workflows/issue-triage.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const V013_ISSUE_LOCK = path.join(
  PACKAGE_ROOT,
  "test/fixtures/v0.1.13/rivet-issue-triage.lock.yml.gz.b64",
);
const V013_ARRAY_ISSUE_LOCK = path.join(
  PACKAGE_ROOT,
  "test/fixtures/v0.1.13/rivet-issue-triage-array.lock.yml.gz.b64",
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
          : workflow.includes("opened event with no useful response")
            ? "test/fixtures/v0.1.13/rivet-issue-triage-array.lock.yml.gz.b64"
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

async function writePreviousArrayIssueGuard(repositoryRoot, configuration) {
  await writeFile(
    path.join(repositoryRoot, ".github/workflows/rivet-issue-triage.md"),
    renderRivetIssueTriageWorkflowV013Array({ configuration }),
  );
  const encoded = await readFile(V013_ARRAY_ISSUE_LOCK, "utf8");
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

test("upgrades the exact array guard before missing-information comments", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "rivet-array-guard-upgrade-test-"),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await installReview({
    repositoryRoot,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  });
  await writePreviousArrayIssueGuard(repositoryRoot, DEFAULT_RIVET_CONFIG);

  const result = await installReview({
    repositoryRoot,
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
  for (const [relativePath, sha256] of [
    [
      ".github/rivet/actions/prepare-review-context/index.mjs",
      "375aa15b58e9cb04db91a56977ef3646a8aabda7493511b45b9dcbaeb13e666e",
    ],
    [
      ".github/rivet/actions/prepare-review-context/index.mjs",
      "b90a18b6fc411e9f874b9f3a04324359da8eb9021e733b2ca9aa337a8fcd7766",
    ],
    [
      ".github/rivet/actions/prepare-review-context/index.mjs",
      "0e310aacc5426f3ce4de0f21e0c3a704cd2f7c63485f4a4994f007e67b1366ec",
    ],
    [
      ".github/rivet/aw/review-extension.md",
      "3629111bc1b10c64929714554a75a50e928dda3c916b60acb985c8f7b3ebe143",
    ],
    [
      ".github/rivet/aw/review-extension.md",
      "25e12a512ffaefb949aeb7ebc7923af6fb209c05d64b75192e7286869543b7d1",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "b906670fbab37182a4d2af0ba59061a3d428479bd2f35636f42edc9fe7b965f1",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "ef6334e8b5052b31c97ae73e29bb36454d5604c9f297fd7ca4b042772a20ee9a",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "e63cc7d069968d1fab8c898a53b678b2dd0706419d77280c3e53c7259cb5d8f0",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "e84aa2b95ba285a8061732e5c2dd02d6f597e25b07b17c38cbdaf7979ae931f6",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "50f232fc428504c79d7467cf1ccf492610870100622cb7f56a2a93c4dc1986c2",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "b923c73eeea1f2f8cafc6b31e73a36748aa65fe4f18938607834679b62caa25c",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "ff8a5f19bb6d046ea29b0e1c4d546a0c7ffadf2868f98bade178a3177080bad7",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "a2d77a423d8abe5002594d17e464f683ab15db122416f04a79cabf7cc45bca82",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "945d02b11e579ab6bef681dd5ce81e9100ac45512c9624be8f20200bd89465b9",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "3f6595c8f87cf96e595e26f47f13724201c72bac17cbfb0b95102e23023d61ab",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "14ff59291b091d3d949c147e7aa39030a4a8fb0f4682c37ebf52c78f4c5a59bb",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "f976e07ccaf551848a9e426608da54bb18367fbcda647f453b39d5e745ea8672",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "5af81b919c363900ba23936e154fbb1b7d4e57551c6a939c80545bcfad35fe85",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "8a35e89f841f6ad58d054ad8bcab1389dfc3f1150e61a5f5bb6f37d96130eec9",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "d5cd19bf40c56761cc20190b04add02d131c4abe3ca8481ae3ccc176a9aff7c4",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "6856015d99a66ac241e9f5600a8bf5f8c67ae53f18d424f48f89c61a8c8dffdc",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "df90ebc17e309862552507de83deb26cb1f56b40cab05d4b1831dbf25a21bc8e",
    ],
    [
      ".github/workflows/rivet-review.lock.yml",
      "f21719f73a77e48f8ee8fff5bbc55281c5486786868048319e0051045d3acfd0",
    ],
  ]) {
    assert.equal(matchesHistoricalManagedFile(relativePath, sha256), true);
  }
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
