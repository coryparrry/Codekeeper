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
  assert.match(fixture, /checkout: false/);
});
