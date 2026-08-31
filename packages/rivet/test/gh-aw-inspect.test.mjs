import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("inspects the pinned Rivet review fixture authority", async () => {
  const source = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test",
      "fixtures",
      "review",
      ".github",
      "workflows",
      "rivet-review.lock.yml",
    ),
    "utf8",
  );
  const authority = inspectCompiledWorkflow(source);
  assert.deepEqual(authority.triggers, ["pull_request_target"]);
  assert.equal(authority.metadata.compiler_version, "v0.86.2");
  assert.equal(authority.metadata.agent_model, "gpt-5.6-luna");
  assert.equal(authority.metadata.strict, true);
  assert.equal(authority.manifest.has_pull_request_target, true);
  assert.equal(authority.inlinedImports, true);
  assert.deepEqual(authority.resolvedImports, [
    ".github/rivet/agents/pr-reviewer.md",
    ".github/rivet/aw/review-extension.md",
  ]);
  assert.deepEqual(authority.unpinnedActions, []);
  assert.equal(authority.containers.length, 6);
  assert.deepEqual(authority.unpinnedContainers, []);
  assert.deepEqual(authority.localActions, [
    "./.github/rivet/actions/authority-receipt",
  ]);
  assert.deepEqual(authority.additionalRepositories, []);
  assert.ok(authority.actionRepositories.includes("github/gh-aw-actions"));
  assert.ok(
    authority.actionRepositories.includes("actions/create-github-app-token"),
  );
  assert.ok(authority.secrets.includes("CODEX_API_KEY"));
  assert.ok(authority.secrets.includes("RIVET_APP_PRIVATE_KEY"));
  assert.ok(authority.variables.includes("GH_AW_DEFAULT_MAX_TURNS"));
  assert.ok(authority.variables.includes("RIVET_APP_CLIENT_ID"));
  assert.ok(authority.safeOutputJobs.includes("safe_outputs"));
  assert.deepEqual(authority.runtimeImports, []);
  assert.doesNotMatch(
    source,
    /model_reasoning_effort|detection_result\.json-c/,
  );
  assert.ok(
    authority.writeCapableJobs.some(({ job }) => job === "safe_outputs"),
  );
  assert.ok(authority.checkouts.every(({ repository }) => repository === null));
  assert.ok(
    authority.checkouts.every(
      ({ persistCredentials }) => persistCredentials === false,
    ),
  );
});

test("reports unpinned actions and additional checkout authority", () => {
  const source = `# gh-aw-metadata: {"strict":true}
# gh-aw-manifest: {"version":1,"containers":[{"image":"owner/image:latest","digest":"","pinned_image":"owner/image:latest"}]}
name: fixture
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  inspect:
    permissions:
      issues: write
    steps:
      - uses: actions/checkout@v4
        with:
          repository: owner/other
          ref: main
      - uses: owner/action@${"a".repeat(40)}
      - run: echo "\${{ secrets.MODEL_KEY }} \${{ vars.RIVET_ENABLED }}"
`;
  const authority = inspectCompiledWorkflow(source);
  assert.deepEqual(authority.triggers, ["workflow_dispatch"]);
  assert.deepEqual(
    authority.unpinnedActions.map(({ uses }) => uses),
    ["actions/checkout@v4"],
  );
  assert.deepEqual(authority.unpinnedContainers, [
    {
      image: "owner/image:latest",
      digest: "",
      pinned_image: "owner/image:latest",
    },
  ]);
  assert.deepEqual(authority.additionalRepositories, ["owner/other"]);
  assert.deepEqual(authority.secrets, ["MODEL_KEY"]);
  assert.deepEqual(authority.variables, ["RIVET_ENABLED"]);
  assert.deepEqual(authority.writeCapableJobs, [
    { job: "inspect", permissions: { issues: "write" } },
  ]);
});

test("rejects malformed YAML and missing compiler metadata", () => {
  assert.throws(
    () =>
      inspectCompiledWorkflow(
        "# gh-aw-metadata: {}\n# gh-aw-manifest: {}\njobs: [",
      ),
    /invalid YAML/,
  );
  assert.throws(
    () => inspectCompiledWorkflow("name: workflow\njobs: {}\n"),
    /missing gh-aw-metadata/,
  );
});
