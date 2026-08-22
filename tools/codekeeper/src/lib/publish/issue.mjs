import { GitHubClient } from "../github.mjs";
import { log } from "../io.mjs";
import { ISSUE_TRIAGE_MARKER, issueTriageStateMarker } from "../markers.mjs";
import { issueTypeLabel } from "../policy.mjs";
import { renderIssueTriage } from "../render.mjs";
import { loadArtifact } from "./artifacts.mjs";
import {
  expectedAutomationIdentity,
  isTrustedMaintenanceIssue,
  issueLabelNames,
  managedIssueLabels,
  trustedPublicationRunUrl
} from "./common.mjs";

const ISSUE_RESOLUTION_MARKER = "<!-- codekeeper:issue-resolution -->";
const ISSUE_DUPLICATE_CLOSURE_MARKER = "<!-- codekeeper:issue-duplicate-closure -->";

export async function publishIssue({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource = agentProfilePath ? "repository" : "package", agentProfileSourceSha, token, dryRun = false }) {
  const { context, result } = await loadArtifact(artifactDirectory, "issue", config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource, agentProfileSourceSha);
  const github = new GitHubClient({ token, repository: context.repository });
  if (result.duplicateOf === context.issue.number) {
    throw new Error(`Issue #${context.issue.number} cannot be its own duplicate`);
  }
  const closingDuplicate = Boolean(
    config.issues.closeExactDuplicates && result.duplicateOf && result.duplicateConfidence === "high"
  );
  const closingResolved = Boolean(config.issues.closeResolvedIssues && context.resolvedByPullRequest);
  const issue = await github.beginIssueMutation({
    issue: context.issue,
    trackSubject: true,
    trackComments: closingDuplicate || closingResolved,
    allowClosed: closingResolved,
  });
  const duplicate = closingDuplicate
    ? await github.requireOpenIssueMutationPrerequisite(result.duplicateOf)
    : null;
  const runUrl = trustedPublicationRunUrl(context);
  const resolvedByPullRequest = closingResolved
    ? (await github.listMergedPullRequestsClosingIssue(issue.number))
      .find((pull) => pull.number === context.resolvedByPullRequest.number
        && pull.url === context.resolvedByPullRequest.url
        && pull.mergedAt === context.resolvedByPullRequest.mergedAt
        && pull.repository === context.resolvedByPullRequest.repository)
    : null;
  if (closingResolved && !resolvedByPullRequest) {
    throw new Error(`Issue #${issue.number} is no longer resolved by the frozen merged pull request`);
  }

  const desired = new Set([issueTypeLabel(result.type), `codekeeper:priority-${result.priority}`, ...result.labels]);
  const automationIdentity = expectedAutomationIdentity();
  const deferredMarker = typeof issue.body === "string"
    ? issue.body.match(/<!-- codekeeper:deferred=[a-f0-9]{64} -->$/)?.[0]
    : null;
  if (
    issueLabelNames(issue).includes("codekeeper:deferred") &&
    deferredMarker &&
    isTrustedMaintenanceIssue(issue, {
      marker: deferredMarker,
      botLogin: automationIdentity.login,
      botId: automationIdentity.id
    })
  ) {
    desired.add("codekeeper:deferred");
  }
  if (!closingResolved && config.issues.allowAiImplementation && result.implementationRecommendation === "ai-ready") {
    desired.add("codekeeper:ready");
  }
  if (!closingResolved && result.duplicateOf && result.duplicateConfidence === "high") {
    desired.add("codekeeper:duplicate-candidate");
  }
  if (!closingResolved && !closingDuplicate && result.missingInformation.length > 0) {
    desired.add("codekeeper:needs-information");
  }
  if (closingResolved) {
    desired.delete("codekeeper:ready");
    desired.delete("codekeeper:duplicate-candidate");
  }
  const desiredLabels = [...desired];
  const comment = `${renderIssueTriage(result, runUrl)}\n${issueTriageStateMarker(result)}`;

  if (dryRun) {
    log(`DRY RUN issue triage #${issue.number}`, { desiredLabels, comment });
    return { issue: issue.number, desiredLabels, dryRun: true };
  }

  await github.ensureLabels(config.labels, desiredLabels);
  await github.replaceManagedIssueLabels(issue.number, desiredLabels, managedIssueLabels(config));
  await github.verifyIssueMutation();
  if (closingDuplicate || closingResolved) {
    await github.upsertOwnedIssueMarker(
      issue.number,
      ISSUE_TRIAGE_MARKER,
      comment,
      automationIdentity
    );
    await github.verifyIssueMutation();
  } else {
    await github.upsertMarkerComment(
      issue.number,
      ISSUE_TRIAGE_MARKER,
      comment,
      automationIdentity
    );
  }
  if (closingResolved) {
    const pullReference = resolvedByPullRequest.repository === context.repository
      ? `#${resolvedByPullRequest.number}`
      : `${resolvedByPullRequest.repository}#${resolvedByPullRequest.number}`;
    const resolvedBody = `Closing as completed because merged pull request [${pullReference}](${resolvedByPullRequest.url}) resolves this issue.`;
    await github.createOwnedIssueComment(
      issue.number,
      resolvedBody,
      automationIdentity,
      ISSUE_RESOLUTION_MARKER
    );
    await github.verifyIssueMutation();
    await github.updateIssue(issue.number, { state: "closed", state_reason: "completed" });
  } else if (closingDuplicate) {
    const duplicateBody = `Closing as a duplicate of #${duplicate.number}.`;
    await github.createOwnedIssueComment(
      issue.number,
      duplicateBody,
      automationIdentity,
      ISSUE_DUPLICATE_CLOSURE_MARKER
    );
    await github.verifyIssueMutation();
    await github.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
  }
  return { issue: issue.number, desiredLabels };
}
