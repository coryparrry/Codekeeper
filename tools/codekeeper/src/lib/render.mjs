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

export function renderReviewComment(result, autoMerge) {
  const decision = autoMerge.eligible
    ? "Eligible for policy-controlled auto-merge."
    : `Manual boundary retained: ${autoMerge.reasons.join("; ") || "policy did not allow auto-merge"}.`;
  return `## PR review summary

${safeMarkdown(result.summary)}

| Signal | Result |
|---|---|
| Risk | **${escapeTable(result.risk)}** |
| Tests | ${result.tests.adequate ? "Adequate" : "Needs more coverage"} |
| Merge recommendation | **${escapeTable(result.mergeRecommendation)}** |
| Policy decision | ${escapeTable(decision)} |

### Blocking findings

${findingList(result.blockingFindings)}

### Non-blocking findings

${findingList(result.nonBlockingFindings)}

### Test assessment

${safeMarkdown(result.tests.notes || "No additional test note.")}

<sub>Generated from the exact PR head analysed by the repository maintainer. Blocking findings fail the required Codekeeper review gate; GitHub branch protection remains authoritative.</sub>`;
}

export function renderIssueTriage(result) {
  const missing = result.missingInformation.length
    ? result.missingInformation.map((item) => `- ${safeMarkdown(item)}`).join("\n")
    : "None.";
  const duplicate = result.duplicateOf
    ? `Possible duplicate: #${result.duplicateOf} (${result.duplicateConfidence} confidence).`
    : "No duplicate identified.";
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

${missing}`;
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

<!-- codekeeper:repair=${fingerprint} -->`;
}
