import { repairMarker } from "./markers.mjs";

function safeMarkdown(value) {
  return String(value ?? "")
    .replace(/<!--\s*codekeeper:/gi, "&lt;!-- codekeeper:")
    .replace(
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+)/gi,
      "$1 `$2`"
    );
}

export const sanitizeMarkdown = safeMarkdown;

function safeInlineCode(value) {
  return safeMarkdown(value)
    .replace(/[\r\n\t]/g, " ")
    .replaceAll("`", "\\`");
}

function escapeTable(value) {
  return safeMarkdown(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function findingList(findings) {
  if (findings.length === 0) return "None.";
  return findings
    .map((finding, index) => {
      const location = finding.file
        ? ` — \`${safeInlineCode(finding.file)}${finding.line ? `:${finding.line}` : ""}\``
        : "";
      return `${index + 1}. **${safeMarkdown(finding.title)}** (${finding.severity}, ${finding.confidence} confidence)${location}\n   ${safeMarkdown(finding.explanation)}`;
    })
    .join("\n");
}

const FEEDBACK_LABELS = Object.freeze({
  fix_now: "Fix now",
  fix_if_cheap: "Fix if cheap",
  defer: "Defer",
  ignore: "Ignore"
});

function feedbackTriage(feedback = []) {
  return Object.entries(FEEDBACK_LABELS).flatMap(([disposition, label]) => {
    const items = feedback.filter((item) => item.disposition === disposition);
    if (items.length === 0) return [];
    const rendered = items.map((item) => `- **${safeMarkdown(item.problemKey)}** — ${safeMarkdown(item.explanation)}\n  _Validation:_ ${safeMarkdown(item.validation)}`).join("\n");
    return [`#### ${label}\n\n${rendered}`];
  }).join("\n\n");
}

function workflowRunEvidence(runUrl = "") {
  return runUrl ? `\n\n<sub>Codekeeper workflow run: ${runUrl}</sub>` : "";
}

export function renderReviewComment(result, autoMerge, runUrl = "") {
  const decision = autoMerge.eligible
    ? "Eligible for policy-controlled auto-merge."
    : `Manual boundary retained: ${autoMerge.reasons.join("; ") || "policy did not allow auto-merge"}.`;
  const diagram = result.diagram
    ? `\n\n### Change flow\n\n\`\`\`mermaid\n${result.diagram.trim()}\n\`\`\``
    : "";
  const triage = feedbackTriage(result.reviewFeedback);
  const triageSection = triage ? `\n\n### Review feedback triage\n\n${triage}` : "";
  const testStatus = result.tests.adequate ? "Adequate" : "**Needs more coverage** — see Test assessment below";
  const testAssessment = result.tests.adequate
    ? safeMarkdown(result.tests.notes || "No additional test note.")
    : `**Missing coverage:** ${safeMarkdown(result.tests.notes || "The review did not identify a specific missing test.")}`;
  return `## PR review summary

${safeMarkdown(result.summary)}

| Signal | Result |
|---|---|
| Risk | **${escapeTable(result.risk)}** |
| Tests | ${testStatus} |
| Merge recommendation | **${escapeTable(result.mergeRecommendation)}** |
| Policy decision | ${escapeTable(decision)} |

### Blocking findings

${findingList(result.blockingFindings)}

### Non-blocking findings

${findingList(result.nonBlockingFindings)}

### Test assessment

${testAssessment}${triageSection}${diagram}

<sub>Generated from the exact PR head analysed by the repository maintainer. Blocking findings fail the required Codekeeper review gate; GitHub branch protection remains authoritative.</sub>${workflowRunEvidence(runUrl)}`;
}

export function renderIssueTriage(result, runUrl = "") {
  const missing = result.missingInformation.length
    ? result.missingInformation.map((item) => `- ${safeMarkdown(item)}`).join("\n")
    : "None.";
  const duplicate = result.duplicateOf
    ? `Possible duplicate: #${result.duplicateOf} (${result.duplicateConfidence} confidence).`
    : "No duplicate identified.";
  const decision = result.decision?.required
    ? `\n\n### Maintainer decision\n\n**Question:** ${safeMarkdown(result.decision.question)}\n\n${safeMarkdown(result.decision.rationale)}\n\n${result.decision.options.map((option) => `- ${option.recommended ? "**Recommended:** " : ""}**${safeMarkdown(option.label)}** — ${safeMarkdown(option.description)}`).join("\n")}`
    : "";
  return `## Codekeeper triage

${safeMarkdown(result.comment)}

| Signal | Result |
|---|---|
| Type | **${result.type}** |
| Priority | **${result.priority}** |
| Actionable | ${result.actionable ? "Yes" : "No"} |
| Implementation | **${result.implementationRecommendation}** |
| Duplicate | ${duplicate} |

### Missing information

${missing}${decision}${workflowRunEvidence(runUrl)}`;
}

export function renderMaintenanceIssue(finding, fingerprint, runUrl = "") {
  const source = runUrl ? `\n\n**Audit run:** ${runUrl}` : "";
  return `## Evidence

${safeMarkdown(finding.evidence)}

## Proposed outcome

${safeMarkdown(finding.proposedAction)}

## Ownership

- Path: \`${safeInlineCode(finding.owningPath)}\`
- Category: \`${finding.category}\`
- Priority: \`${finding.priority}\`
- Stable key: \`${safeInlineCode(finding.problemKey)}\`${source}

<!-- codekeeper:fingerprint=${fingerprint} -->`;
}

export function renderDeferredIssue({ feedback, pullRequest, sources, marker, runUrl = "" }) {
  const sourceLinks = sources.length
    ? sources.map((source) => `- [${safeMarkdown(source.sourceKey)}](${source.url}) — ${safeMarkdown(source.author || "unknown")}`).join("\n")
    : "- The original review source is no longer linkable.";
  const run = runUrl ? `\n- Review run: ${runUrl}` : "";
  return `## Deferred outcome

${safeMarkdown(feedback.explanation)}

## Verification

${safeMarkdown(feedback.validation)}

## Origin

- Pull request: [#${pullRequest.number}](${pullRequest.url})
- Initial type: \`${feedback.type}\`${run}

### Review sources

${sourceLinks}

${marker}`;
}

export function renderRepairPullRequest({ titleSummary, body, finding, issueNumber, fingerprint, validationSummary, files }) {
  const links = [
    issueNumber ? `Closes #${issueNumber}` : "",
    finding ? `Addresses maintenance finding: **${safeMarkdown(finding.title)}**` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
  const changed = files.length
    ? files.map((file) => `- \`${safeInlineCode(file)}\``).join("\n")
    : "- No file list available";
  return `## Summary

${safeMarkdown(titleSummary)}

${safeMarkdown(body)}

## Changed files

${changed}

## Validation

${validationSummary || "Validation is delegated to repository CI and Xcode Cloud where applicable."}

${links}

${repairMarker(fingerprint)}`;
}
