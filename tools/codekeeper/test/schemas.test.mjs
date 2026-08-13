import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixSchema, validateAuditResult, validateFixResult, validateIssueResult, validateReviewResult } from "../src/lib/schemas.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
);

test("review validator supplies a safe Mermaid fallback for legacy results", () => {
  const result = validateReviewResult({
    mode: "review",
    summary: "No current defect was found.",
    risk: "low",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    tests: { adequate: true, notes: "Current behavior is covered." },
    mergeRecommendation: "manual",
    noActionReason: null
  }, config);
  assert.match(result.diagram, /^flowchart LR/);
});

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
          diagram: "flowchart LR\n  Change --> Failure",
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
    diagram: "flowchart LR\n  Change --> Review",
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

test("issue validator rejects AI implementation while a maintainer decision is required", () => {
  assert.throws(
    () => validateIssueResult({
      mode: "issue",
      summary: "The issue is clear but requires a compatibility choice.",
      type: "bug",
      priority: "p2",
      labels: [],
      actionable: true,
      missingInformation: [],
      duplicateOf: null,
      duplicateConfidence: "none",
      implementationRecommendation: "ai-ready",
      decision: {
        required: true,
        question: "Which compatibility behavior should apply?",
        rationale: "The implementation depends on a maintainer-owned policy choice.",
        options: [{ label: "Preserve behavior", description: "Keep compatibility.", recommended: true }]
      },
      comment: "A maintainer decision is required before implementation."
    }, config),
    /required maintainer decision cannot be AI-ready/
  );
});

test("issue validator rejects a missing maintainer decision", () => {
  assert.throws(
    () => validateIssueResult({
      mode: "issue",
      summary: "The issue appears ready.",
      type: "bug",
      priority: "p2",
      labels: [],
      actionable: true,
      missingInformation: [],
      duplicateOf: null,
      duplicateConfidence: "none",
      implementationRecommendation: "ai-ready",
      comment: "This issue can be implemented."
    }, config),
    /missing required field decision/
  );
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
        diagram: "flowchart LR\n  Change --> DataLoss",
        mergeRecommendation: "auto",
        noActionReason: null
      },
      config
    ),
    /cannot contain a critical finding/
  );
});

test("review feedback uses four exhaustive triage buckets and stable unique problem keys", () => {
  const base = {
    mode: "review",
    summary: "Review feedback was checked against the current head.",
    risk: "low",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [
      {
        problemKey: "missing-timeout-regression",
        disposition: "defer",
        type: "testing",
        explanation: "The concern is valid but outside this pull request's bounded outcome.",
        validation: "The current head still lacks the timeout regression case.",
        sourceKeys: ["review_comment:41", "review_comment:42"],
        threadIds: ["PRRT_kwDOExample"]
      },
      {
        problemKey: "stale-null-comment",
        disposition: "ignore",
        type: "bug",
        explanation: "The cited null path no longer exists.",
        validation: "The current head guards the value before use.",
        sourceKeys: ["review:7"],
        threadIds: []
      }
    ],
    tests: { adequate: true, notes: "Current behavior is covered." },
    diagram: "flowchart LR\n  Change --> Review",
    mergeRecommendation: "manual",
    noActionReason: null
  };
  assert.equal(validateReviewResult(structuredClone(base), config).reviewFeedback[0].disposition, "defer");
  assert.throws(
    () => validateReviewResult({
      ...structuredClone(base),
      reviewFeedback: base.reviewFeedback.map((item) => ({ ...item, problemKey: "duplicate" }))
    }, config),
    /duplicate review feedback problemKey/
  );
  assert.throws(
    () => validateReviewResult({
      ...structuredClone(base),
      reviewFeedback: [{ ...base.reviewFeedback[0], disposition: "later" }]
    }, config),
    /disposition must be one of fix_now, fix_if_cheap, defer, ignore/
  );
});
