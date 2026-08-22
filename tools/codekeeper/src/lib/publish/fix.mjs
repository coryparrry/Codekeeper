import { GitHubClient } from "../github.mjs";
import { fixRunMarker, repairNotificationMarker, sha256 } from "../markers.mjs";
import { publishPullRequestRepair } from "../pr-repair.mjs";
import { sanitizeMarkdown } from "../render.mjs";
import { loadArtifact } from "./artifacts.mjs";
import { expectedAutomationIdentity } from "./common.mjs";
import { publishPatchPullRequest } from "./repair-pr.mjs";
import {
  isDirectOwnerFix,
  resumeDirectOwnerFix,
} from "./owner-command.mjs";

export async function publishFix({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource = agentProfilePath ? "repository" : "package", agentProfileSourceSha, token, dryRun = false, prRepairGit }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "fix", config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource, agentProfileSourceSha);
  const github = new GitHubClient({ token, repository: context.repository });
  const directOwnerFix = isDirectOwnerFix(context);
  if (context.target?.kind === "pull_request") {
    return publishPullRequestRepair({
      github,
      artifactDirectory,
      manifest,
      context,
      result,
      config,
      automationIdentity: expectedAutomationIdentity(),
      resumePaused: directOwnerFix,
      dryRun,
      ...(prRepairGit ? { gitOperations: prRepairGit } : {})
    });
  }
  if (context.target?.kind !== "issue" || !Number.isSafeInteger(context.target.number) || context.target.number <= 0) {
    throw new Error("Frozen fix context has no valid issue or pull request target");
  }
  if (context.issue?.number !== context.target.number) {
    throw new Error("Frozen issue fix context does not match its target");
  }
  const resumedTarget = await resumeDirectOwnerFix(github, context);
  const issue = await github.beginIssueMutation({
    issue: resumedTarget
      ? { ...context.issue, updatedAt: resumedTarget.updated_at }
      : context.issue,
    rejectPaused: context.authorizationMode === "policy"
  });

  if (!manifest.patch?.valid) {
    const reason = result.noChangeReason || manifest.patch?.reasons?.join("; ") || "No valid patch was produced";
    if (!dryRun) {
      await github.upsertMarkerComment(
        issue.number,
        fixRunMarker(context.runId),
        `Codekeeper did not open a PR. ${sanitizeMarkdown(reason)}`,
        expectedAutomationIdentity()
      );
    }
    return { created: false, reason, dryRun };
  }

  const fingerprint = sha256(`issue|${context.repository}|${issue.number}`);
  const repair = await publishPatchPullRequest({
    github,
    artifactDirectory,
    manifest,
    context,
    config,
    title: `fix: ${issue.title}`,
    summary: result.summary,
    body: result.changedSummary,
    risk: result.risk,
    readyForReview: result.readyForReview,
    fingerprint,
    issueNumber: issue.number,
    finding: null,
    dryRun
  });
  if (!dryRun && repair.url) {
    await github.upsertMarkerComment(
      issue.number,
      repairNotificationMarker(fingerprint),
      `Codekeeper opened a repair pull request: ${repair.url}`,
      expectedAutomationIdentity()
    );
  }
  return repair;
}
