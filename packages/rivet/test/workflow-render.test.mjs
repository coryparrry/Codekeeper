import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { runPrepareReviewContextAction } from "../assets/review/.github/rivet/actions/prepare-review-context/index.mjs";
import {
  renderRivetReviewWorkflow,
  renderRivetReviewWorkflowV0113,
  renderRivetReviewWorkflowV012,
  RIVET_REVIEW_NATIVE_IMPORTS,
  RIVET_REVIEW_TAG_PUBLISH_SCRIPT,
  RIVET_REVIEW_WORKFLOW_ID,
} from "../src/workflows/review.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LEGACY_NATIVE_IMPORTS = [".github/rivet/aw/review-extension.md"];

test("renders the checked-in Rivet review workflow source", async () => {
  const fixture = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test",
      "fixtures",
      "review",
      ".github",
      "workflows",
      `${RIVET_REVIEW_WORKFLOW_ID}.md`,
    ),
    "utf8",
  );
  assert.equal(renderRivetReviewWorkflow(), fixture);
  assert.doesNotMatch(fixture, /Codekeeper/i);
  assert.match(fixture, /pull_request_target:/);
  assert.match(fixture, /bots: \[\"\$\{\{ vars\.RIVET_APP_BOT_LOGIN \}\}\"\]/);
  assert.match(fixture, /needs: \[review_context\]/);
  assert.match(fixture, /checkout: false/);
  assert.match(fixture, /inlined-imports: true/);
  assert.match(fixture, /engine: codex\nmodel: gpt-5\.6-luna/);
  assert.doesNotMatch(fixture, /\?effort=low|model_reasoning_effort/);
  assert.match(fixture, /max-turns: 3/);
  assert.match(fixture, /needs\.agent\.result == 'success'/);
  assert.match(fixture, /vars\.RIVET_APP_CLIENT_ID/);
  assert.match(fixture, /secrets\.RIVET_APP_PRIVATE_KEY/);
  assert.match(
    fixture,
    /safe-outputs:\n  github-app:\n    client-id: \$\{\{ vars\.RIVET_APP_CLIENT_ID \}\}\n    private-key: \$\{\{ secrets\.RIVET_APP_PRIVATE_KEY \}\}/,
  );
  assert.doesNotMatch(fixture, /^github-app:/m);
  assert.match(fixture, /report-failure-as-issue: false/);
  assert.match(fixture, /report-failed-jobs: false/);
  assert.match(fixture, /report-incomplete:\n    create-issue: false/);
  assert.match(
    fixture,
    /create-issue:\n    title-prefix: "\[rivet\] "\n    max: 1\n    deduplicate-by-title: true/,
  );
  assert.match(fixture, /jobs:\n    publish-review-tags:/);
  assert.match(fixture, /^  review_tags_pending:/m);
  assert.match(
    fixture,
    /review_tags_pending:\n    needs: pre_activation\n    if: needs\.pre_activation\.outputs\.activated == 'true'/,
  );
  assert.match(fixture, /agent:\n    needs: \[review_tags_pending\]/);
  assert.match(fixture, /permission-pull-requests: write/);
  assert.match(fixture, /call `publish_review_tags` once/);
  assert.ok(
    RIVET_REVIEW_TAG_PUBLISH_SCRIPT.split("\n").every((line) =>
      fixture.includes(line),
    ),
  );
  assert.match(
    fixture,
    /imports:\n  - \.github\/rivet\/agents\/pr-reviewer\.md\n  - \.github\/rivet\/aw\/review-extension\.md/,
  );
  assert.match(fixture, /Publish no more than 8 inline findings/);
  assert.match(fixture, /submit_pull_request_review/);
  assert.match(
    fixture,
    /recommendation is evidence only and does not select the GitHub review event/,
  );
  assert.match(fixture, /Use only `COMMENT`; `REQUEST_CHANGES` is forbidden/);
  assert.match(fixture, /Triage each supported finding before publication/);
  assert.match(fixture, /it does not authorize a repair or implementation/);
  assert.match(fixture, /For every complete comparison/);
  assert.match(fixture, /# Rivet review/);
  assert.match(fixture, /## What this changes/);
  assert.match(fixture, /## Merge readiness/);
  assert.match(fixture, /## Verification/);
  assert.match(fixture, /- \*\*Findings:\*\*/);
  assert.match(fixture, /- \*\*Tests:\*\*/);
  assert.match(fixture, /- \*\*Risk:\*\*/);
  assert.match(fixture, /Do not use a Markdown table/);
  assert.doesNotMatch(fixture, /Check \| Result \| Evidence/);
  assert.match(fixture, /## How this fits together/);
  assert.match(fixture, /flowchart LR/);
  assert.match(fixture, /## Before merge/);
  assert.match(fixture, /<summary><strong>Review details<\/strong><\/summary>/);
  assert.doesNotMatch(fixture, /call only `noop`/);
  assert.doesNotMatch(fixture, /  add-comment:/);
});

test("resets a stale ready label even when the new comparison exceeds its budget", async () => {
  const compiled = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/review/.github/workflows/rivet-review.lock.yml",
    ),
    "utf8",
  );
  const { jobs } = parse(compiled);
  const ancestors = (job) => {
    const direct = [jobs[job].needs ?? []].flat();
    return [...new Set(direct.flatMap((need) => [need, ...ancestors(need)]))];
  };
  assert.equal(
    jobs.review_context.steps.find((step) => step.id === "snapshot")[
      "continue-on-error"
    ],
    true,
  );
  assert.match(jobs.agent.if, /needs\.review_context\.outputs\.snapshot != ''/);
  assert.match(
    compiled,
    /GH_AW_NEEDS_REVIEW_CONTEXT_OUTPUTS_SNAPSHOT: \$\{\{ needs\.review_context\.outputs\.snapshot \}\}/,
  );
  assert.match(
    compiled,
    /GH_AW_NEEDS_REVIEW_CONTEXT_OUTPUTS_SNAPSHOT: process\.env\.GH_AW_NEEDS_REVIEW_CONTEXT_OUTPUTS_SNAPSHOT/,
  );
  assert.ok(ancestors("review_tags_pending").includes("pre_activation"));
  assert.equal(
    jobs.review_tags_pending.if,
    "needs.pre_activation.outputs.activated == 'true'",
  );
  assert.ok(ancestors("agent").includes("review_context"));
  assert.ok(ancestors("agent").includes("review_tags_pending"));
  assert.match(jobs.agent.if, /needs\.activation/);
  assert.match(
    jobs.publish_review_tags.if,
    /needs\.agent\.result != 'skipped'/,
  );
  const pendingJob = compiled.slice(
    compiled.indexOf("\n  review_tags_pending:"),
    compiled.indexOf("\n  safe_outputs:"),
  );
  assert.doesNotMatch(
    pendingJob,
    /contains\(needs\.agent\.outputs\.output_types/,
  );
  const reset = new (Object.getPrototypeOf(async function () {}).constructor)(
    "context",
    "github",
    jobs.review_tags_pending.steps.find((step) => step.with?.script)?.with
      .script,
  );
  const pull = {
    id: 101,
    number: 12,
    state: "open",
    changed_files: 51,
    base: { sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
    labels: [
      { name: "merge ready" },
      { name: "needs tests" },
      { name: "human-owned" },
    ],
  };
  const context = {
    eventName: "pull_request_target",
    payload: {
      action: "synchronize",
      repository: { full_name: "owner/repository" },
      pull_request: structuredClone(pull),
    },
    repo: { owner: "owner", repo: "repository" },
  };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pull }) },
      issues: {
        getLabel: async () => ({}),
        addLabels: async ({ labels }) =>
          pull.labels.push(...labels.map((name) => ({ name }))),
        removeLabel: async ({ name }) => {
          pull.labels = pull.labels.filter((label) => label.name !== name);
        },
      },
    },
  };
  await assert.rejects(
    runPrepareReviewContextAction({
      env: {
        GITHUB_EVENT_PATH: "/event.json",
        GITHUB_OUTPUT: "/output",
        GITHUB_REPOSITORY: "owner/repository",
        GITHUB_TOKEN: "test-token",
      },
      statImpl: async () => ({ isFile: () => true, size: 100 }),
      readFileImpl: async () => JSON.stringify(context.payload),
      appendFileImpl: async () =>
        assert.fail("incomplete context cannot publish"),
      fetchImpl: async () =>
        assert.fail("oversized comparison needs no API call"),
    }),
    /comparison exceeds the 50-file review budget/,
  );
  await reset(context, github);
  assert.deepEqual(pull.labels.map(({ name }) => name).sort(), [
    "human-owned",
    "review needed",
  ]);
});

test("projects domain review controls into gh-aw frontmatter", () => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.review.inlineFindings = false;
  configuration.review.requestChanges = true;
  const source = renderRivetReviewWorkflow({ configuration });
  assert.doesNotMatch(source, /create-pull-request-review-comment/);
  assert.match(source, /inline findings are disabled/);
  assert.match(source, /allowed-events: \[COMMENT, REQUEST_CHANGES\]/);
  assert.match(
    source,
    /Use `REQUEST_CHANGES` only when the recommendation is `block`/,
  );
  assert.match(source, /use `COMMENT` for `manual` and `auto`/);
  assert.doesNotMatch(source, /`REQUEST_CHANGES` is forbidden/);

  configuration.issues.triage = "disabled";
  const issueTriageDisabled = renderRivetReviewWorkflow({ configuration });
  assert.doesNotMatch(issueTriageDisabled, /^  create-issue:/m);
  assert.match(issueTriageDisabled, /issue triage is disabled/);
  const legacyIssueTriageDisabled = renderRivetReviewWorkflowV012({
    configuration,
  });
  assert.match(legacyIssueTriageDisabled, /model: gpt-5\.6-luna\n/);
  assert.doesNotMatch(legacyIssueTriageDisabled, /model_reasoning_effort/);
  assert.doesNotMatch(legacyIssueTriageDisabled, /max-turns:/);
  assert.doesNotMatch(legacyIssueTriageDisabled, /needs: \[review_context\]/);
  assert.doesNotMatch(legacyIssueTriageDisabled, /^jobs:/m);
  assert.doesNotMatch(legacyIssueTriageDisabled, /^  create-issue:/m);
  assert.doesNotMatch(legacyIssueTriageDisabled, /issue triage is disabled/);
});

test("accepts only managed local native imports", () => {
  assert.deepEqual(RIVET_REVIEW_NATIVE_IMPORTS, [
    ".github/rivet/agents/pr-reviewer.md",
    ".github/rivet/aw/review-extension.md",
  ]);
  assert.doesNotMatch(
    renderRivetReviewWorkflow({ nativeImports: [] }),
    /^imports:/m,
  );
  assert.match(
    renderRivetReviewWorkflow({ nativeImports: LEGACY_NATIVE_IMPORTS }),
    /imports:\n  - \.github\/rivet\/aw\/review-extension\.md/,
  );
  for (const nativeImport of [
    "../other.md",
    ".github/other.md",
    "owner/repository/shared.md@main",
    ".github/rivet/aw//other.md",
    ".github/rivet/aw/group/.md",
  ]) {
    assert.throws(
      () => renderRivetReviewWorkflow({ nativeImports: [nativeImport] }),
      /must be a managed local Markdown path/,
    );
  }
  assert.throws(
    () => renderRivetReviewWorkflow({ nativeImports: null }),
    /must be an ordered array/,
  );
});

test("freezes the 0.1.2 review source used for upgrades", async () => {
  assert.equal(
    renderRivetReviewWorkflowV012(),
    await readFile(
      path.join(PACKAGE_ROOT, "test/fixtures/v0.1.2/rivet-review.md"),
      "utf8",
    ),
  );
});

test("freezes the 0.1.13 review source used for upgrades", async () => {
  const source = renderRivetReviewWorkflowV0113();
  assert.equal(
    source,
    await readFile(
      path.join(PACKAGE_ROOT, "assets/upgrades/v0.1.13/rivet-review.md"),
      "utf8",
    ),
  );
  assert.doesNotMatch(source, /add-labels:/);
  assert.doesNotMatch(source, /publish-review-tags/);
});

test("reconciles only managed tags on the triggering pull request", async () => {
  const publish = new (Object.getPrototypeOf(async function () {}).constructor)(
    "require",
    "process",
    "context",
    "github",
    RIVET_REVIEW_TAG_PUBLISH_SCRIPT,
  );
  const calls = { created: [], added: [], removed: [] };
  const pull = {
    id: 101,
    number: 12,
    state: "open",
    base: { sha: "a".repeat(40) },
    head: { sha: "b".repeat(40) },
    labels: [{ name: "review needed" }, { name: "human-owned" }],
  };
  const context = {
    eventName: "pull_request_target",
    payload: { action: "synchronize", pull_request: structuredClone(pull) },
    repo: { owner: "owner", repo: "repository" },
  };
  const output =
    (recommendation = "auto") =>
    () => ({
      readFileSync: () =>
        JSON.stringify({
          items: [
            {
              type: "submit_pull_request_review",
              body: "## Merge readiness\n\n✅ **Ready to merge**",
            },
            {
              type: "publish_review_tags",
              recommendation,
              missing_test: "true",
            },
          ],
          errors: [],
        }),
    });
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pull }) },
      issues: {
        getLabel: async ({ name }) => {
          if (name === "merge ready")
            throw Object.assign(new Error(), { status: 404 });
          return {};
        },
        createLabel: async (label) => calls.created.push(label),
        addLabels: async ({ labels }) => {
          calls.added.push(...labels);
          pull.labels.push(...labels.map((name) => ({ name })));
        },
        removeLabel: async ({ name }) => {
          calls.removed.push(name);
          pull.labels = pull.labels.filter((label) => label.name !== name);
        },
      },
    },
  };
  await publish(
    output(),
    {
      env: {
        GH_AW_AGENT_OUTPUT: "/agent-output.json",
        RIVET_SAFE_OUTPUTS_RESULT: "success",
      },
    },
    context,
    github,
  );
  assert.deepEqual(calls.added, ["merge ready", "needs tests"]);
  assert.deepEqual(calls.removed, ["review needed"]);
  assert.deepEqual(
    calls.created.map(({ name }) => name),
    ["merge ready"],
  );
  assert.ok(pull.labels.some(({ name }) => name === "human-owned"));
  await assert.rejects(
    publish(
      output("block"),
      {
        env: {
          GH_AW_AGENT_OUTPUT: "/agent-output.json",
          RIVET_SAFE_OUTPUTS_RESULT: "success",
        },
      },
      context,
      github,
    ),
    /invalid bound tag output/,
  );

  pull.labels = [
    { name: "merge ready" },
    { name: "needs tests" },
    { name: "human-owned" },
  ];
  await publish(
    output(),
    {
      env: {
        GH_AW_AGENT_OUTPUT: "/agent-output.json",
        RIVET_SAFE_OUTPUTS_RESULT: "failure",
      },
    },
    context,
    github,
  );
  assert.deepEqual(pull.labels.map(({ name }) => name).sort(), [
    "human-owned",
    "review needed",
  ]);

  pull.labels = [{ name: "changes required" }, { name: "human-owned" }];
  pull.head.sha = context.payload.pull_request.head.sha;
  calls.added.length = 0;
  const removeLabel = github.rest.issues.removeLabel;
  github.rest.issues.removeLabel = async (values) => {
    await removeLabel(values);
    pull.head.sha = "c".repeat(40);
  };
  await assert.rejects(
    publish(
      output(),
      {
        env: {
          GH_AW_AGENT_OUTPUT: "/agent-output.json",
          RIVET_SAFE_OUTPUTS_RESULT: "success",
        },
      },
      context,
      github,
    ),
    /invalid bound tag output/,
  );
  assert.deepEqual(calls.added, []);
});
