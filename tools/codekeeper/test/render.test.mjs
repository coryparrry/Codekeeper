import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeReleaseOwnedPinReview,
  renderIssueTriage,
  renderRepairPullRequest,
  renderReviewComment,
  sanitizeMarkdown,
} from "../src/lib/render.mjs";

test("repair pull requests render sealed validation evidence without generic CI claims", () => {
  const candidateSha256 = "a".repeat(64);
  const baseSha = "b".repeat(40);
  const rendered = renderRepairPullRequest({
    titleSummary: "Apply the bounded repair.",
    body: "Updates the affected path.",
    finding: null,
    issueNumber: 7,
    fingerprint: "f".repeat(64),
    validationSummary: [
      "- `npm test`: passed in 42 ms; stdout SHA-256 `" + "c".repeat(64) + "`",
      `- Candidate SHA-256: \`${candidateSha256}\``,
      `- Base commit: \`${baseSha}\``,
    ].join("\n"),
    files: ["src/example.mjs"],
  });

  assert.match(rendered, /`npm test`: passed/);
  assert.match(rendered, new RegExp(candidateSha256));
  assert.match(rendered, new RegExp(baseSha));
  assert.doesNotMatch(rendered, /Xcode Cloud|delegated validation/i);

  const withoutCommands = renderRepairPullRequest({
    titleSummary: "Apply the bounded repair.",
    body: "Updates the affected path.",
    finding: null,
    issueNumber: null,
    fingerprint: "e".repeat(64),
    validationSummary: "",
    files: [],
  });
  assert.match(withoutCommands, /No repository-specific validation commands were configured/);
  assert.doesNotMatch(withoutCommands, /Xcode Cloud|delegated validation/i);
});

test("review comment contains deterministic policy decision", () => {
  const markdown = renderReviewComment(
    {
      summary: "The change is narrow.",
      risk: "low",
      tests: { adequate: true, notes: "Covered.", missingTest: null },
      diagram: null,
      mergeRecommendation: "auto",
      blockingFindings: [],
      nonBlockingFindings: [],
      reviewFeedback: [
        {
          problemKey: "fix-current-timeout",
          disposition: "fix_now",
          explanation: "The timeout regression is current.",
          validation: "A focused test fails on this head.",
        },
        {
          problemKey: "defer-cache-cleanup",
          disposition: "defer",
          explanation: "The cleanup is valid follow-up work.",
          validation: "The duplicated cache path remains.",
        },
        {
          problemKey: "ignore-stale-comment",
          disposition: "ignore",
          explanation: "The comment targets code removed by a later push.",
          validation: "The cited path is absent on the current head.",
        },
      ],
    },
    { eligible: false, reasons: ["Swift files require manual review"] },
    "https://github.com/owner/repository/actions/runs/7001",
  );
  assert.match(markdown, /^# Codekeeper review$/m);
  assert.match(markdown, /^## What this changes$/m);
  assert.match(markdown, /^## Merge readiness$/m);
  assert.match(markdown, /Ready for maintainer review/);
  assert.match(markdown, /^## Verification$/m);
  assert.match(markdown, /^## Before merge$/m);
  assert.match(
    markdown,
    /<summary><strong>Agent review details<\/strong><\/summary>/,
  );
  assert.match(markdown, /Swift files require manual review/);
  assert.doesNotMatch(markdown, /```mermaid/);
  assert.match(markdown, /Fix now/);
  assert.match(markdown, /Defer/);
  assert.match(markdown, /Ignore/);
  assert.doesNotMatch(markdown, /Fix if cheap/);
  assert.match(
    markdown,
    /<sub>Codekeeper workflow run: https:\/\/github\.com\/owner\/repository\/actions\/runs\/7001<\/sub>/,
  );
});

test("ordinary reviews are friendly, compact, and name missing test coverage", () => {
  const markdown = renderReviewComment(
    {
      summary: "No current defects found.",
      risk: "medium",
      tests: {
        adequate: false,
        notes:
          "No deterministic test covers PR and repository-dispatch run-name evaluation.",
        missingTest:
          "Add a caller test that triggers both PR and repository-dispatch events and expects the durable run name.",
      },
      diagram: null,
      mergeRecommendation: "manual",
      blockingFindings: [],
      nonBlockingFindings: [],
      reviewFeedback: [],
    },
    { eligible: false, reasons: ["Tests are incomplete"] },
  );
  assert.match(
    markdown,
    /⚠️ \*\*Ready for maintainer review — test coverage remains\*\*/,
  );
  assert.match(
    markdown,
    /\| Tests \| ⚠️ Needs coverage \| No deterministic test covers PR and repository-dispatch run-name evaluation\. \|/,
  );
  assert.match(
    markdown,
    /- \[ \] \*\*Add the missing test coverage\*\* — Add a caller test that triggers both PR and repository-dispatch events and expects the durable run name\./,
  );
  assert.doesNotMatch(
    markdown,
    /\| Signal|```mermaid|### Blocking findings|### Non-blocking findings/,
  );
  assert.doesNotMatch(
    markdown,
    /Review feedback triage|Fix now|Fix if cheap|#### Defer|#### Ignore/,
  );
});

test("unknown test evidence does not invent missing coverage", () => {
  const markdown = renderReviewComment(
    {
      summary: "The workflows advance an external source pin.",
      risk: "medium",
      tests: {
        adequate: false,
        notes: "The external source is unavailable in this checkout.",
        missingTest: null,
      },
      diagram: null,
      mergeRecommendation: "manual",
      blockingFindings: [],
      nonBlockingFindings: [],
      reviewFeedback: [],
    },
    { eligible: false, reasons: ["External provenance needs manual review"] },
  );

  assert.match(markdown, /✅ \*\*Ready for maintainer review\*\*/);
  assert.match(
    markdown,
    /\| Tests \| ⚠️ Not established \| The external source is unavailable in this checkout\. \|/,
  );
  assert.match(markdown, /## Before merge\n\nNone\./);
  assert.doesNotMatch(
    markdown,
    /Needs coverage|missing test coverage|needs tests/i,
  );
});

test("package receipt updates are not mistaken for legacy source-pin-only changes", () => {
  const files = ["assistant", "fix", "issues", "maintain", "review"].map(
    (mode) => ({
      filename: `.github/workflows/codekeeper-${mode}.yml`,
      additions: 2,
      deletions: 2,
      patch: [
        '-      package_version: "0.1.0"',
        '+      package_version: "0.2.0"',
        '-      package_integrity: "sha512-AAAA"',
        '+      package_integrity: "sha512-BBBB"',
      ].join("\n"),
    }),
  );
  const modelResult = {
    summary: "Manual validation is still required.",
    tests: {
      adequate: false,
      notes: "Run the workflows manually.",
      missingTest: null,
    },
  };
  assert.equal(normalizeReleaseOwnedPinReview(modelResult, files), modelResult);
});

test("a model-selected flow diagram renders only when supplied", () => {
  const markdown = renderReviewComment(
    {
      summary: "The request now moves through a new approval state.",
      risk: "medium",
      tests: {
        adequate: true,
        notes: "The state transition is covered.",
        missingTest: null,
      },
      diagram: "flowchart LR\n  Request --> Review --> Approved",
      mergeRecommendation: "manual",
      blockingFindings: [],
      nonBlockingFindings: [],
      reviewFeedback: [],
    },
    { eligible: false, reasons: ["A person must approve the state change"] },
  );
  assert.match(
    markdown,
    /## How this fits together\n\n```mermaid\nflowchart LR/,
  );
});

test("blocking findings become the before-merge checklist", () => {
  const markdown = renderReviewComment(
    {
      summary: "Discounted totals can now be calculated.",
      risk: "high",
      tests: {
        adequate: true,
        notes: "The existing total tests pass.",
        missingTest: null,
      },
      diagram: null,
      mergeRecommendation: "block",
      blockingFindings: [
        {
          title: "Reject a zero divisor",
          explanation: "The calculation can divide by zero.",
          file: "src/discount.mjs",
          line: 18,
          severity: "high",
          confidence: "high",
        },
      ],
      nonBlockingFindings: [],
      reviewFeedback: [],
    },
    { eligible: false, reasons: ["A blocking finding remains"] },
  );
  assert.match(markdown, /⛔ \*\*Changes needed before merge\*\*/);
  assert.match(markdown, /\*\*Risk:\*\* High/);
  assert.match(
    markdown,
    /- \[ \] \*\*Reject a zero divisor\*\* — The calculation can divide by zero\. \(`src\/discount\.mjs:18`\)/,
  );
  assert.doesNotMatch(markdown, /```mermaid/);
});

test("issue triage keeps trusted workflow-run evidence separate from model text", () => {
  const markdown = renderIssueTriage(
    {
      comment: "Triage completed.",
      type: "bug",
      priority: "p2",
      actionable: true,
      implementationRecommendation: "manual",
      duplicateOf: null,
      duplicateConfidence: "none",
      missingInformation: [],
    },
    "https://github.com/owner/repository/actions/runs/7002",
  );
  assert.match(
    markdown,
    /<sub>Codekeeper workflow run: https:\/\/github\.com\/owner\/repository\/actions\/runs\/7002<\/sub>/,
  );
});

test("generated Markdown cannot inject maintainer markers or accidental close directives", () => {
  const rendered = sanitizeMarkdown(
    "<!-- codekeeper:repair=evil --> closes #42 and resolves: #43; fixes owner/repository#44; closes https://github.com/owner/repository/issues/45",
  );
  assert.doesNotMatch(rendered, /<!--\s*codekeeper:/i);
  assert.doesNotMatch(rendered, /closes\s+#42/i);
  assert.doesNotMatch(rendered, /resolves:\s+#43/i);
  assert.match(rendered, /`#42`/);
  assert.match(rendered, /`#43`/);
  assert.match(rendered, /`owner\/repository#44`/);
  assert.match(
    rendered,
    /`https:\/\/github\.com\/owner\/repository\/issues\/45`/,
  );
});
