import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixSchema, issueSchema, reviewSchema, validateAuditResult, validateFixResult, validateIssueResult, validateReviewResult } from "../src/lib/schemas.mjs";
import { LABELS } from "../src/lib/label-ownership.mjs";
import { normalizeLivePolicy } from "../src/lib/policy-normalization.mjs";

const config = normalizeLivePolicy(JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
));

test("issue schema and validator use the issue-only model allowlist", () => {
  assert.deepEqual(issueSchema(config).properties.labels.items.enum, config.issues.allowedLabels);
  assert.throws(
    () => validateIssueResult({
      mode: "issue",
      summary: "The issue is clear.",
      type: "bug",
      priority: "p2",
      labels: [LABELS.NEEDS_TESTS],
      actionable: true,
      missingInformation: [],
      duplicateOf: null,
      duplicateConfidence: "none",
      implementationRecommendation: "no",
      decision: {
        required: false,
        question: "",
        rationale: "",
        options: []
      },
      comment: "The issue is ready for triage."
    }, config),
    /labels contains unsupported value needs tests/
  );
});

test("review validator keeps Mermaid optional for ordinary changes", () => {
  const result = validateReviewResult({
    mode: "review",
    summary: "No current defect was found.",
    risk: "low",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    tests: { adequate: true, notes: "Current behavior is covered.", missingTest: null },
    mergeRecommendation: "manual",
    noActionReason: null
  }, config);
  assert.equal(result.diagram, null);
});

test("review finding evidence requires stable root-cause tags and a safe reproduction path", () => {
  const finding = {
    title: "Authorization bypass",
    explanation: "The changed branch skips the authorization guard.",
    severity: "high",
    confidence: "high",
    classification: "current",
    validation: "The focused unauthorized request reaches the protected operation.",
    preventionTest: "Keep the unauthorized request regression test.",
    rootCauseTags: ["missing-authorization-check", "guard-order"],
    reproductionTest: "test/authorization.test.mjs",
    file: "src/auth.mjs",
    line: 12
  };
  const base = {
    mode: "review",
    summary: "A current defect exists.",
    risk: "high",
    labels: [],
    blockingFindings: [finding],
    nonBlockingFindings: [],
    reviewFeedback: [],
    tests: { adequate: false, notes: "The exact regression is available.", missingTest: null },
    diagram: null,
    mergeRecommendation: "block",
    noActionReason: null
  };
  assert.deepEqual(validateReviewResult(structuredClone(base), config).blockingFindings[0].rootCauseTags, finding.rootCauseTags);
  for (const rootCauseTags of [["Missing-authorization-check"], ["duplicate", "duplicate"], Array.from({ length: 9 }, (_item, index) => `tag-${index}`)]) {
    assert.throws(() => validateReviewResult({ ...structuredClone(base), blockingFindings: [{ ...finding, rootCauseTags }] }, config), /rootCauseTags/);
  }
  for (const reproductionTest of ["/tmp/test.mjs", "../test.mjs", "src/../test.mjs", "src\\test.mjs", "https://example.test/repro.mjs"]) {
    assert.throws(() => validateReviewResult({ ...structuredClone(base), blockingFindings: [{ ...finding, reproductionTest }] }, config), /reproductionTest/);
  }
  assert.doesNotThrow(() => validateReviewResult({ ...structuredClone(base), blockingFindings: [{ ...finding, reproductionTest: null }] }, config));
  const findingSchema = reviewSchema(config).properties.blockingFindings.items.properties;
  assert.equal(findingSchema.rootCauseTags.minItems, 1);
  assert.equal(findingSchema.rootCauseTags.maxItems, 8);
  assert.equal(findingSchema.rootCauseTags.uniqueItems, true);
  assert.equal(findingSchema.reproductionTest.anyOf[1].type, "null");
});

test("review validator canonicalizes graph LR and rejects vertical Mermaid diagrams", () => {
  const review = {
    mode: "review",
    summary: "The changed flow is valid.",
    risk: "medium",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    tests: { adequate: true, notes: "The flow is covered.", missingTest: null },
    diagram: "graph LR\nCatalog --> Pricing --> Checkout",
    mergeRecommendation: "manual",
    noActionReason: null
  };
  assert.equal(validateReviewResult(structuredClone(review), config).diagram, "flowchart LR\nCatalog --> Pricing --> Checkout");
  assert.throws(
    () => validateReviewResult({ ...structuredClone(review), diagram: "flowchart TD\nCatalog --> Pricing --> Checkout" }, config),
    /left-to-right Mermaid flowchart/
  );
});

test("review validator keeps missing tests explicit and separate from unknown evidence", () => {
  assert.match(reviewSchema(config).properties.tests.properties.missingTest.description, /repository-local test/);
  assert.match(reviewSchema(config).properties.tests.properties.missingTest.description, /null for unavailable external-source evidence/);
  const base = {
    mode: "review",
    summary: "No current defect was found.",
    risk: "medium",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    tests: { adequate: false, notes: "External evidence is unavailable.", missingTest: null },
    diagram: null,
    mergeRecommendation: "manual",
    noActionReason: "A maintainer must verify the external source provenance."
  };

  assert.equal(validateReviewResult(structuredClone(base), config).tests.missingTest, null);
  assert.equal(
    validateReviewResult({
      ...structuredClone(base),
      tests: {
        adequate: false,
        notes: "The dispatch boundary is uncovered.",
        missingTest: "Add a repository-dispatch test and expect one durable run name."
      }
    }, config).tests.adequate,
    false
  );
  assert.throws(
    () => validateReviewResult({
      ...structuredClone(base),
      tests: { adequate: true, notes: "Covered.", missingTest: "Add another test." }
    }, config),
    /adequate tests cannot name a missing test/
  );
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
              rootCauseTags: ["nil-input", "unchecked-unwrap"],
              reproductionTest: null,
              file: "src/App.swift",
              line: 42
            }
          ],
          nonBlockingFindings: [],
          tests: { adequate: false, notes: "No regression test.", missingTest: "Add a nil-input regression test and expect the call not to crash." },
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
      rootCauseTags: ["stale-evidence"],
      reproductionTest: null,
      file: "src/example.mjs",
      line: 1
    }],
    nonBlockingFindings: [],
    tests: { adequate: true, notes: "The current behavior is covered.", missingTest: null },
    diagram: null,
    mergeRecommendation: "block",
    noActionReason: null
  }, config), /current validated finding/);
});

test("review validator allows a low-severity introduced contract failure to block", () => {
  const result = validateReviewResult({
    mode: "review",
    summary: "The changed expiry boundary violates the documented cache contract.",
    risk: "medium",
    labels: [],
    blockingFindings: [{
      title: "Cache entry expires at its still-valid boundary",
      explanation: "The changed comparison evicts the entry when now equals expiresAt.",
      severity: "low",
      confidence: "high",
      classification: "current",
      validation: "The current-head boundary test fails while the base comparison succeeds.",
      preventionTest: "Keep an equality-boundary test that expects the cached value.",
      rootCauseTags: ["boundary-comparison"],
      reproductionTest: "test/cache-boundary.test.mjs",
      file: "src/cache.mjs",
      line: 1
    }],
    nonBlockingFindings: [],
    tests: {
      adequate: false,
      notes: "The deterministic reproduction demonstrates the regression.",
      missingTest: "Add an equality-boundary test that expects the cached value."
    },
    diagram: null,
    mergeRecommendation: "block",
    noActionReason: null
  }, config);

  assert.equal(result.blockingFindings[0].severity, "low");
  assert.equal(result.mergeRecommendation, "block");
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
          labels: []
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
          tests: { adequate: true, notes: "No changed behavior.", missingTest: null },
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
          rootCauseTags: ["data-loss"],
          reproductionTest: null,
          file: "docs/README.md",
          line: 1
        }],
        tests: { adequate: true, notes: "Regression coverage exists.", missingTest: null },
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
    tests: { adequate: true, notes: "Current behavior is covered.", missingTest: null },
    diagram: null,
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
