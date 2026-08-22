import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GENERIC_RUNTIME_WORKFLOW,
  MODE_IDS,
  MODES,
  RELEASE_PACKAGE_ASSETS,
} from "../../../packages/codekeeper/src/constants.mjs";
import { activeRepositoryArtifacts } from "../../../packages/codekeeper/src/repository-artifacts.mjs";
import {
  loadVerifiedAssets,
  TEST_PACKAGE_RELEASE,
} from "../../../packages/codekeeper/test/helpers.mjs";

const repositoryRoot = new URL("../../../", import.meta.url);
const wrapperPaths = Object.freeze(
  Object.fromEntries(
    MODE_IDS.map((mode) => [
      mode,
      new URL(`.github/workflows/codekeeper-${mode}.yml`, repositoryRoot),
    ]),
  ),
);

const wrappers = Object.fromEntries(
  await Promise.all(
    MODE_IDS.map(async (mode) => [
      mode,
      await readFile(wrapperPaths[mode], "utf8"),
    ]),
  ),
);
const generic = await readFile(
  new URL(".github/workflows/codekeeper-runtime.yml", repositoryRoot),
  "utf8",
);

function jobNames(source) {
  const jobs = source.slice(source.indexOf("\njobs:\n"));
  return [...jobs.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm)].map(
    (match) => match[1],
  );
}

function runtimeJob(source) {
  const start = source.indexOf("\n  runtime:\n");
  assert.notEqual(start, -1, "compatibility wrapper declares runtime job");
  return source.slice(start);
}

test("mode compatibility wrappers allocate no runner and call only the generic runtime", () => {
  for (const mode of MODE_IDS) {
    const source = wrappers[mode];
    const job = runtimeJob(source);
    assert.deepEqual(
      jobNames(source),
      ["runtime"],
      `${mode} has one wrapper job`,
    );
    assert.match(job, /uses: \.\/\.github\/workflows\/codekeeper-runtime\.yml/);
    assert.match(job, new RegExp(`^      mode: ${mode}$`, "m"));
    assert.doesNotMatch(job, /runs-on:|steps:|uses: actions\//);
  }
});

test("wrappers preserve public compatibility inputs without forwarding permission authority", () => {
  const modeInputs = {
    review: ["auto_review", "feedback_triage", "owner_command"],
    issues: ["auto_triage"],
    maintain: ["dry_run"],
    fix: ["issue_number", "dry_run"],
  };
  for (const mode of MODE_IDS) {
    const source = wrappers[mode];
    const job = runtimeJob(source);
    for (const input of [
      "package_version",
      "package_integrity",
      "enabled",
      "app_client_id",
      "app_contents_permission",
      "app_issues_permission",
      "app_pull_requests_permission",
      ...modeInputs[mode],
    ]) {
      assert.match(source, new RegExp(`^      ${input}:$`, "m"));
    }
    for (const permission of [
      "app_contents_permission",
      "app_issues_permission",
      "app_pull_requests_permission",
    ]) {
      assert.doesNotMatch(
        job,
        new RegExp(`inputs\\.${permission}`),
        `${mode} cannot forward caller-supplied App permission authority`,
      );
    }
  }
});

test("wrappers pass an explicit closed secret set and preserve the workspace fallback", () => {
  for (const mode of MODE_IDS) {
    const job = runtimeJob(wrappers[mode]);
    assert.doesNotMatch(job, /secrets:\s+inherit/);
    assert.match(job, /model_api_key: \$\{\{ secrets\.model_api_key \}\}/);
    assert.match(
      job,
      /workspace_api_key: \$\{\{ secrets\.workspace_api_key \|\| secrets\.openai_api_key \}\}/,
    );
    assert.match(job, /trace_api_key: \$\{\{ secrets\.trace_api_key \}\}/);
    assert.match(job, /app_private_key: \$\{\{ secrets\.app_private_key \}\}/);
  }
});

test("wrapper routing retains mode-specific eligibility and review command suppression", () => {
  assert.match(wrappers.review, /!inputs\.owner_command/);
  assert.match(wrappers.review, /inputs\.auto_review/);
  assert.match(wrappers.review, /inputs\.feedback_triage/);
  assert.match(wrappers.review, /codekeeper_review/);
  assert.match(
    wrappers.review,
    /startsWith\(github\.event\.comment\.body, '@'\)/,
  );
  assert.match(wrappers.issues, /inputs\.auto_triage/);
  assert.match(wrappers.issues, /codekeeper:needs-information/);
  assert.match(wrappers.issues, /codekeeper_issue/);
  assert.match(wrappers.fix, /codekeeper:ready/);
  assert.match(wrappers.fix, /codekeeper_fix/);
  assert.match(wrappers.maintain, /^    if: inputs\.enabled$/m);
});

test("the generic workflow is a packaged always-installed release artifact", async () => {
  assert.ok(RELEASE_PACKAGE_ASSETS.includes(GENERIC_RUNTIME_WORKFLOW));
  assert.deepEqual(GENERIC_RUNTIME_WORKFLOW, {
    id: "runtime",
    label: "Generic staged runtime",
    target: ".github/workflows/codekeeper-runtime.yml",
    asset: "runtime-workflows/runtime.yml",
    sourcePath: ".github/workflows/codekeeper-runtime.yml",
    packagePath: "release/workflows/codekeeper-runtime.yml",
    description:
      "Runs every Codekeeper mode through the shared compute, validate, and publish stages.",
  });
  const artifact = activeRepositoryArtifacts({ modes: ["review"] }).find(
    (candidate) => candidate.target === GENERIC_RUNTIME_WORKFLOW.target,
  );
  assert.equal(artifact?.activation.kind, "always");

  const bundle = await loadVerifiedAssets({
    packageRelease: TEST_PACKAGE_RELEASE,
  });
  assert.equal(bundle.contents[GENERIC_RUNTIME_WORKFLOW.asset], generic);
  const record = bundle.metadata.assets[GENERIC_RUNTIME_WORKFLOW.asset];
  assert.equal(record.bytes, Buffer.byteLength(generic));
  assert.equal(
    record.sha256,
    createHash("sha256").update(generic).digest("hex"),
  );
});

test("the shared runtime retains staged execution plus its credential proof and protected review gate name", () => {
  assert.deepEqual(jobNames(generic), [
    "compute",
    "validate",
    "publish",
    "credential-probe",
  ]);
  assert.match(
    generic,
    /name: \$\{\{ \(inputs\.mode == 'review' \|\| needs\.compute\.outputs\.required_gate == 'true'\) && 'Codekeeper review gate' \|\| 'Codekeeper trusted publication' \}\}/,
  );
  for (const mode of MODE_IDS) {
    assert.equal(
      MODES[mode].runtime.sourcePath,
      wrapperPaths[mode].pathname.replace(repositoryRoot.pathname, ""),
    );
  }
});
