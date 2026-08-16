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

const GENERATED_WORKFLOW_PATHS = new Set([
  ".github/workflows/codekeeper-assistant.yml",
  ".github/workflows/codekeeper-fix.yml",
  ".github/workflows/codekeeper-issues.yml",
  ".github/workflows/codekeeper-maintain.yml",
  ".github/workflows/codekeeper-review.yml",
]);

export function normalizeReleaseOwnedPinReview(result, files) {
  if (!Array.isArray(files) || files.length !== GENERATED_WORKFLOW_PATHS.size || new Set(files.map((file) => file.filename)).size !== GENERATED_WORKFLOW_PATHS.size) return result;
  let previousSha;
  let nextSha;
  for (const file of files) {
    if (!GENERATED_WORKFLOW_PATHS.has(file.filename) || file.additions !== 3 || file.deletions !== 3 || typeof file.patch !== "string") return result;
    const changed = file.patch.split("\n").filter((line) => /^[+-](?![+-])/.test(line));
    const removed = changed.filter((line) => line.startsWith("-"));
    const added = changed.filter((line) => line.startsWith("+"));
    if (removed.length !== 3 || added.length !== 3 || !removed.every((line) => line.includes("coryparrry/Codekeeper"))) return result;
    const removedShas = new Set(removed.flatMap((line) => line.match(/\b[a-f0-9]{40}\b/g) ?? []));
    const addedShas = new Set(added.flatMap((line) => line.match(/\b[a-f0-9]{40}\b/g) ?? []));
    if (removedShas.size !== 1 || addedShas.size !== 1) return result;
    const [oldSha] = removedShas;
    const [newSha] = addedShas;
    if (oldSha === newSha || (previousSha && previousSha !== oldSha) || (nextSha && nextSha !== newSha)) return result;
    if (!removed.every((line, index) => line.slice(1).replaceAll(oldSha, "<sha>") === added[index].slice(1).replaceAll(newSha, "<sha>"))) return result;
    previousSha = oldSha;
    nextSha = newSha;
  }
  return {
    ...result,
    summary: "This installer-generated update advances the same reviewed Codekeeper source pin across all five workflows. No blocking issue is evidenced by the configuration change.",
    tests: {
      ...result.tests,
      notes: "The generated workflows advance one source pin consistently. Live and provenance validation is owned by the Codekeeper release process; no adopter test is required.",
    },
  };
}

function safeInlineCode(value) {
  return safeMarkdown(value)
    .replace(/[\r\n\t]/g, " ")
    .replaceAll("`", "\\`");
}

function safeTableCell(value) {
  return safeMarkdown(value)
    .replace(/[\r\n\t]+/g, " ")
    .replaceAll("|", "\\|");
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

function beforeMergeChecklist(result) {
  const items = result.blockingFindings.map((finding) => {
    const location = finding.file
      ? ` (\`${safeInlineCode(finding.file)}${finding.line ? `:${finding.line}` : ""}\`)`
      : "";
    return `- [ ] **${safeMarkdown(finding.title)}** — ${safeMarkdown(finding.explanation)}${location}`;
  });
  if (result.tests.missingTest) {
    items.push(`- [ ] **Add the missing test coverage** — ${safeMarkdown(result.tests.missingTest)}`);
  }
  return items.length ? items.join("\n") : "None.";
}

export function renderReviewComment(result, autoMerge, runUrl = "") {
  const decision = autoMerge.eligible
    ? "This pull request meets the configured automatic-merge policy."
    : `Automatic merge stays off because: ${autoMerge.reasons.join("; ") || "the configured policy did not allow it"}.`;
  const diagram = result.diagram
    ? `\n\n## How this fits together\n\n\`\`\`mermaid\n${result.diagram.trim()}\n\`\`\``
    : "";
  const triage = feedbackTriage(result.reviewFeedback);
  const triageSection = triage ? `\n\n### Existing review feedback\n\n${triage}` : "";
  const recommendation = result.mergeRecommendation === "block" || result.blockingFindings.length > 0
    ? "⛔ **Changes needed before merge**"
    : result.mergeRecommendation === "auto" && autoMerge.eligible
      ? "✅ **Ready to merge**"
      : result.tests.missingTest
        ? "⚠️ **Ready for maintainer review — test coverage remains**"
        : "✅ **Ready for maintainer review**";
  const readiness = result.blockingFindings.length > 0
    ? `Codekeeper found ${result.blockingFindings.length} ${result.blockingFindings.length === 1 ? "item" : "items"} that should be resolved before this is merged.`
    : result.tests.missingTest
      ? "No blocking code issue was found, but the missing test coverage below still needs attention."
      : "No blocking issues were found. The final merge decision remains with the maintainer.";
  const findingResult = result.blockingFindings.length > 0
    ? `⛔ ${result.blockingFindings.length} blocking`
    : result.nonBlockingFindings.length > 0
      ? `⚠️ ${result.nonBlockingFindings.length} non-blocking`
      : "✅ None";
  const testResult = result.tests.adequate
    ? "✅ Covered"
    : result.tests.missingTest
      ? "⚠️ Needs coverage"
      : "⚠️ Not established";
  const risk = `${result.risk[0].toUpperCase()}${result.risk.slice(1)}`;
  const nonBlockingSection = result.nonBlockingFindings.length
    ? `\n\n### Worth a look\n\n${findingList(result.nonBlockingFindings)}`
    : "";
  const details = `${nonBlockingSection}${triageSection}`;
  return `# Codekeeper review

## What this changes

${safeMarkdown(result.summary)}

## Merge readiness

${recommendation}

${readiness}

**Risk:** ${risk}

## Verification

| Check | Result | Evidence |
|---|---|---|
| Findings | ${findingResult} | ${result.blockingFindings.length} blocking; ${result.nonBlockingFindings.length} non-blocking |
| Tests | ${testResult} | ${safeTableCell(result.tests.notes || "No test evidence was supplied.")} |
${diagram}

## Before merge

${beforeMergeChecklist(result)}

<details>
<summary><strong>Agent review details</strong></summary>

${safeMarkdown(decision)}
${details || "\nNo additional review details."}

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
