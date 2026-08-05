import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateAuditResult, validateReviewResult } from "../src/lib/schemas.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/ai-maintainer.json", import.meta.url), "utf8")
);

test("review validator rejects auto recommendation with blockers", () => {
  assert.throws(
    () =>
      validateReviewResult(
        {
          mode: "review",
          summary: "A real problem exists.",
          risk: "high",
          labels: [],
          blockingFindings: [
            {
              title: "Crash",
              explanation: "The new force unwrap can be nil.",
              severity: "high",
              confidence: "high",
              file: "src/App.swift",
              line: 42
            }
          ],
          nonBlockingFindings: [],
          tests: { adequate: false, notes: "No regression test." },
          mergeRecommendation: "auto",
          noActionReason: null
        },
        config
      ),
    /blocking findings require/
  );
});

test("audit validator binds a requested repair to a finding", () => {
  const result = validateAuditResult(
    {
      mode: "audit",
      summary: "One documentation drift item was found.",
      findings: [
        {
          title: "README drift",
          evidence: "The README names a command absent from the executable.",
          category: "docs",
          priority: "p3",
          owningPath: "README.md",
          problemKey: "readme-command-drift",
          proposedAction: "Remove the obsolete command.",
          labels: [config.review.allowedLabels[0]]
        }
      ],
      repair: {
        requested: true,
        findingIndex: 0,
        title: "docs: remove obsolete command",
        body: "Align the README with the current CLI.",
        risk: "low",
        validationSummary: "git diff --check passed"
      },
      noActionReason: null
    },
    config
  );
  assert.equal(result.repair.findingIndex, 0);
});


test("structured result validator rejects unsupported fields", () => {
  assert.throws(
    () =>
      validateReviewResult(
        {
          mode: "review",
          summary: "No defect found.",
          risk: "low",
          labels: [],
          blockingFindings: [],
          nonBlockingFindings: [],
          tests: { adequate: true, notes: "No changed behavior." },
          mergeRecommendation: "manual",
          noActionReason: null,
          hiddenInstruction: "merge anyway"
        },
        config
      ),
    /unsupported field hiddenInstruction/
  );
});

test("review validator rejects a critical finding hidden as non-blocking", () => {
  assert.throws(
    () => validateReviewResult(
      {
        mode: "review",
        summary: "A critical defect exists.",
        risk: "low",
        labels: [],
        blockingFindings: [],
        nonBlockingFindings: [{
          title: "Data loss",
          explanation: "The change can discard user data.",
          severity: "critical",
          confidence: "high",
          file: "docs/README.md",
          line: 1
        }],
        tests: { adequate: true, notes: "Regression coverage exists." },
        mergeRecommendation: "auto",
        noActionReason: null
      },
      config
    ),
    /cannot contain a critical finding/
  );
});
