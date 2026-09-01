import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderRivetReviewWorkflow,
  renderRivetReviewWorkflowV012,
  RIVET_REVIEW_NATIVE_IMPORTS,
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
  assert.match(
    fixture,
    /engine: codex\nmodel: gpt-5\.6-luna/,
  );
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
  assert.match(fixture, /call only `noop`/);
  assert.doesNotMatch(fixture, /  add-comment:/);
});

test("projects domain review controls into gh-aw frontmatter", () => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.review.inlineFindings = false;
  configuration.review.requestChanges = true;
  const source = renderRivetReviewWorkflow({ configuration });
  assert.doesNotMatch(source, /create-pull-request-review-comment/);
  assert.match(source, /inline findings are disabled/);
  assert.match(source, /allowed-events: \[COMMENT, REQUEST_CHANGES\]/);
  assert.match(source, /event `REQUEST_CHANGES`/);
  assert.match(source, /Use the configured `REQUEST_CHANGES` event/);
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
