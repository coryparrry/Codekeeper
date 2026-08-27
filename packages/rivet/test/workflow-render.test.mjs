import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  renderRivetReviewWorkflow,
  RIVET_REVIEW_WORKFLOW_ID,
} from "../src/workflows/review.mjs";

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
  assert.match(fixture, /checkout: false/);
  assert.match(fixture, /inlined-imports: true/);
  assert.match(fixture, new RegExp(NATIVE_IMPORT.replaceAll(".", "\\.")));
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
