import test from "node:test";
import assert from "node:assert/strict";
import { renderIssueTriage, renderReviewComment, sanitizeMarkdown } from "../src/lib/render.mjs";

test("review comment contains deterministic policy decision", () => {
  const markdown = renderReviewComment(
    {
      summary: "The change is narrow.",
      risk: "low",
      tests: { adequate: true, notes: "Covered." },
      diagram: "flowchart LR\n  Change --> Test",
      mergeRecommendation: "auto",
      blockingFindings: [],
      nonBlockingFindings: [],
      reviewFeedback: [
        {
          problemKey: "fix-current-timeout",
          disposition: "fix_now",
          explanation: "The timeout regression is current.",
          validation: "A focused test fails on this head."
        },
        {
          problemKey: "defer-cache-cleanup",
          disposition: "defer",
          explanation: "The cleanup is valid follow-up work.",
          validation: "The duplicated cache path remains."
        },
        {
          problemKey: "ignore-stale-comment",
          disposition: "ignore",
          explanation: "The comment targets code removed by a later push.",
          validation: "The cited path is absent on the current head."
        }
      ]
    },
    { eligible: false, reasons: ["Swift files require manual review"] },
    "https://github.com/owner/repository/actions/runs/7001"
  );
  assert.match(markdown, /^## PR review summary$/m);
  assert.match(markdown, /Manual boundary retained/);
  assert.match(markdown, /Swift files require manual review/);
  assert.match(markdown, /```mermaid\nflowchart LR/);
  assert.match(markdown, /Fix now/);
  assert.match(markdown, /Defer/);
  assert.match(markdown, /Ignore/);
  assert.doesNotMatch(markdown, /Fix if cheap/);
  assert.match(markdown, /<sub>Codekeeper workflow run: https:\/\/github\.com\/owner\/repository\/actions\/runs\/7001<\/sub>/);
});

test("normal reviews keep the original compact shape and name missing test coverage", () => {
  const markdown = renderReviewComment(
    {
      summary: "No current defects found.",
      risk: "medium",
      tests: {
        adequate: false,
        notes: "No deterministic test covers PR and repository-dispatch run-name evaluation."
      },
      diagram: "flowchart LR\n  Change --> Review",
      mergeRecommendation: "manual",
      blockingFindings: [],
      nonBlockingFindings: [],
      reviewFeedback: []
    },
    { eligible: false, reasons: ["Tests are incomplete"] }
  );
  assert.match(markdown, /\| Tests \| \*\*Needs more coverage\*\* — see Test assessment below \|/);
  assert.match(markdown, /### Test assessment\n\n\*\*Missing coverage:\*\* No deterministic test covers PR and repository-dispatch run-name evaluation\./);
  assert.match(markdown, /### Change flow\n\n```mermaid\nflowchart LR/);
  assert.doesNotMatch(markdown, /Review feedback triage|Fix now|Fix if cheap|#### Defer|#### Ignore/);
});

test("issue triage keeps trusted workflow-run evidence separate from model text", () => {
  const markdown = renderIssueTriage({
    comment: "Triage completed.", type: "bug", priority: "p2", actionable: true,
    implementationRecommendation: "manual", duplicateOf: null, duplicateConfidence: "none", missingInformation: []
  }, "https://github.com/owner/repository/actions/runs/7002");
  assert.match(markdown, /<sub>Codekeeper workflow run: https:\/\/github\.com\/owner\/repository\/actions\/runs\/7002<\/sub>/);
});


test("generated Markdown cannot inject maintainer markers or accidental close directives", () => {
  const rendered = sanitizeMarkdown("<!-- codekeeper:repair=evil --> closes #42 and resolves: #43; fixes owner/repository#44; closes https://github.com/owner/repository/issues/45");
  assert.doesNotMatch(rendered, /<!--\s*codekeeper:/i);
  assert.doesNotMatch(rendered, /closes\s+#42/i);
  assert.doesNotMatch(rendered, /resolves:\s+#43/i);
  assert.match(rendered, /`#42`/);
  assert.match(rendered, /`#43`/);
  assert.match(rendered, /`owner\/repository#44`/);
  assert.match(rendered, /`https:\/\/github\.com\/owner\/repository\/issues\/45`/);
});
