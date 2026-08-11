import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixSchema, validateAuditResult, validateFixResult, validateReviewResult } from "../src/lib/schemas.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
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
              classification: "current",
              validation: "The current head still contains the failing unwrap.",
              preventionTest: "Exercise the nil input path.",
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

test("review validator cannot promote a stale finding to the fixer", () => {
  assert.throws(() => validateReviewResult({
    mode: "review",
    summary: "The comment is stale.",
    risk: "low",
    labels: [],
    blockingFindings: [{
      title: "Old failure",
      explanation: "The reported path was changed later.",
      severity: "medium",
      confidence: "high",
      classification: "stale",
      validation: "The current head no longer reproduces the failure.",
      preventionTest: "Keep the current regression test.",
      file: "src/example.mjs",
      line: 1
    }],
    nonBlockingFindings: [],
    tests: { adequate: true, notes: "The current behavior is covered." },
    diagram: null,
    mergeRecommendation: "block",
    noActionReason: null
  }, config), /current validated finding/);
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

test("fix schema and validator bind output to the frozen issue or pull request target", () => {
  const target = { kind: "pull_request", number: 42 };
  const schema = fixSchema(target);
  assert.deepEqual(schema.properties.targetKind, { const: "pull_request" });
  assert.deepEqual(schema.properties.targetNumber, { const: 42 });
  const result = {
    mode: "fix",
    summary: "Updated the existing pull request.",
    risk: "low",
    targetKind: "pull_request",
    targetNumber: 42,
    changedSummary: "Added a regression test.",
    testsRun: [{ command: "npm test", result: "passed" }],
    readyForReview: true,
    noChangeReason: null
  };
  assert.equal(validateFixResult(result, target), result);
  assert.throws(
    () => validateFixResult({ ...result, targetNumber: 43 }, target),
    /targetNumber does not match requested target/
  );
  assert.throws(
    () => validateFixResult({ ...result, targetKind: "issue" }, target),
    /targetKind does not match requested target/
  );
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
          classification: "current",
          validation: "The current head still contains the data-loss path.",
          preventionTest: "Exercise the data-preservation path.",
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
