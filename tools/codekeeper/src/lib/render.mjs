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

function findingList(findings) {
  return findings
    .map((finding, index) => {
      const location = finding.file
        ? `\n   \`${safeInlineCode(finding.file)}${finding.line ? `:${finding.line}` : ""}\` · ${finding.severity} severity · ${finding.confidence} confidence`
        : "";
      return `${index + 1}. **${safeMarkdown(finding.title)}**${location}\n\n   ${safeMarkdown(finding.explanation)}`;
    })
    .join("\n\n");
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
    ? "This pull request meets the configured automatic-merge policy."
    : `Automatic merge stays off because: ${autoMerge.reasons.join("; ") || "the configured policy did not allow it"}.`;
  const diagram = result.diagram
    ? `\n\n### How the change behaves\n\n\`\`\`mermaid\n${result.diagram.trim()}\n\`\`\``
    : "";
  const triage = feedbackTriage(result.reviewFeedback);
  const triageSection = triage ? `\n\n### Existing review feedback\n\n${triage}` : "";
  const recommendation = result.mergeRecommendation === "block"
    ? "Block this pull request"
    : result.mergeRecommendation === "auto" && autoMerge.eligible
      ? "Ready to merge"
      : "Ready for a person to decide";
  const risk = `${result.risk[0].toUpperCase()}${result.risk.slice(1)} risk`;
  const testStatus = result.tests.adequate ? "Tests covered" : "More tests needed";
  const testAssessment = result.tests.adequate
    ? safeMarkdown(result.tests.notes || "No additional test note.")
    : `**Coverage still needed:** ${safeMarkdown(result.tests.notes || "The review did not identify a specific missing test.")}`;
  const blockingSection = result.blockingFindings.length
    ? `\n\n### Must fix before merge\n\n${findingList(result.blockingFindings)}`
    : "";
  const nonBlockingSection = result.nonBlockingFindings.length
    ? `\n\n### Worth a look\n\n${findingList(result.nonBlockingFindings)}`
    : "";
  return `## Codekeeper review

**${recommendation}** · ${risk} · ${testStatus}

${safeMarkdown(result.summary)}
${blockingSection}${nonBlockingSection}

### Tests

${testAssessment}${triageSection}${diagram}

<details>
<summary>Why Codekeeper chose this result</summary>

${safeMarkdown(decision)}

</details>

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
