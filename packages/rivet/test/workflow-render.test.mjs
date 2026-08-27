import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderRivetReviewWorkflow,
  RIVET_REVIEW_WORKFLOW_ID,
} from "../src/workflows/review.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const NATIVE_IMPORT = ".github/rivet/aw/review-extension.md";

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
  assert.equal(
    renderRivetReviewWorkflow({ nativeImport: NATIVE_IMPORT }),
    fixture,
  );
  assert.doesNotMatch(fixture, /Codekeeper/i);
  assert.match(fixture, /pull_request_target:/);
  assert.match(fixture, /bots: \[\"\$\{\{ vars\.RIVET_APP_BOT_LOGIN \}\}\"\]/);
  assert.match(
    fixture,
    /checkout:\n  sparse-checkout: \|\n    \.github\/rivet\/actions\/authority-receipt/,
  );
  assert.match(fixture, /inlined-imports: true/);
  assert.match(fixture, /model: gpt-5\.6-luna/);
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
  assert.match(fixture, new RegExp(NATIVE_IMPORT.replaceAll(".", "\\.")));
  assert.match(fixture, /Publish no more than 8 inline findings/);
  assert.match(fixture, /submit_pull_request_review/);
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
});

test("accepts only managed local native imports", () => {
  assert.doesNotMatch(renderRivetReviewWorkflow(), /^imports:/m);
  for (const nativeImport of [
    "../other.md",
    ".github/other.md",
    "owner/repository/shared.md@main",
    ".github/rivet/aw//other.md",
    ".github/rivet/aw/group/.md",
  ]) {
    assert.throws(
      () => renderRivetReviewWorkflow({ nativeImport }),
      /must be a managed local Markdown path/,
    );
  }
});
