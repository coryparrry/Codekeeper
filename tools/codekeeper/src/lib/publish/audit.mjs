import { currentHead } from "../git.mjs";
import { GitHubClient, isOwnedMarkerComment } from "../github.mjs";
import { findingFingerprint, findingMarker, repairNotificationMarker } from "../markers.mjs";
import { findingLabels } from "../policy.mjs";
import { renderMaintenanceIssue, sanitizePublicTitle } from "../render.mjs";
import { assertNoPublicSecurityFindings } from "../security-containment.mjs";
import { loadArtifact } from "./artifacts.mjs";
import {
  expectedAutomationIdentity,
  isRecoverableMaintenanceIssue,
  managedIssueLabels,
  normalizeAutomationIdentity,
  reconcileSecondaryIssue
} from "./common.mjs";
import { publishPatchPullRequest } from "./repair-pr.mjs";

export function isTrustedMaintenanceFindingIssue(issue, comments, { marker, botLogin, botId }) {
  const identity = normalizeAutomationIdentity({ login: botLogin, id: botId });
  return Boolean(
    isRecoverableMaintenanceIssue(issue, marker, identity) &&
    Array.isArray(comments) &&
    comments.some((comment) => isOwnedMarkerComment(comment, marker, identity))
  );
}

async function upsertMaintenanceFindings({ github, findings, config, runUrl, dryRun }) {
  const automationIdentity = expectedAutomationIdentity();
  const existing = await github.listMaintenanceIssues("codekeeper:maintenance");
  const published = [];
  for (const finding of findings.slice(0, config.audit.maximumIssuesPerRun)) {
    const fingerprint = findingFingerprint(finding);
    const marker = findingMarker(fingerprint);
    let match;
    for (const issue of existing) {
      if (typeof issue?.body !== "string" || !issue.body.endsWith(marker)) continue;
      const comments = await github.listIssueComments(issue.number);
      if (isTrustedMaintenanceFindingIssue(issue, comments, {
        marker,
        botLogin: automationIdentity.login,
        botId: automationIdentity.id
      })) {
        match = issue;
        break;
      }
    }
    const labels = [...new Set([...findingLabels(finding), `codekeeper:priority-${finding.priority}`])];
    const title = sanitizePublicTitle(`[AI maintenance] ${finding.title}`) || "[AI maintenance] Repository finding";
    const body = renderMaintenanceIssue(finding, fingerprint, runUrl);

    if (match?.state === "closed") {
      published.push({ fingerprint, state: "acknowledged", issueNumber: match.number });
      continue;
    }
    if (dryRun) {
      published.push({ fingerprint, state: match ? "would-update" : "would-create", issueNumber: match?.number ?? null });
      continue;
    }
    await github.ensureLabels(config.labels, labels);
    if (match) {
      await reconcileSecondaryIssue(github, match, async () => {
        await github.updateIssue(match.number, { title, body });
        await github.replaceManagedLabels(match.number, labels, managedIssueLabels(config));
      });
      published.push({ fingerprint, state: "updated", issueNumber: match.number });
    } else {
      const created = await github.createIssue({ title, body, labels });
      await github.createComment(created.number, marker);
      published.push({ fingerprint, state: "created", issueNumber: created.number });
      existing.push(created);
    }
  }
  return published;
}

export async function publishAudit({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource = agentProfilePath ? "repository" : "package", agentProfileSourceSha, token, dryRun = false }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "audit", config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource, agentProfileSourceSha);
  assertNoPublicSecurityFindings(result);
  if (typeof context.repairAuthorized !== "boolean") {
    throw new Error("Trusted audit artifact is missing explicit repair authorization");
  }
  if (result.repair.requested && (!config.audit.repair.enabled || !context.repairAuthorized)) {
    throw new Error("Audit repair publication lacks frozen explicit repair authorization");
  }
  const liveHead = currentHead();
  if (liveHead !== context.baseSha) {
    throw new Error(`Default branch moved from ${context.baseSha} to ${liveHead}; stale audit will not publish`);
  }
  const github = new GitHubClient({ token, repository: context.repository });
  await github.beginBranchMutation({ branch: config.repository.defaultBranch, headSha: context.baseSha });
  const findings = await upsertMaintenanceFindings({
    github,
    findings: result.findings,
    config,
    runUrl: context.runUrl,
    dryRun
  });

  let repair = { created: false, reason: "No repair requested" };
  if (result.repair.requested) {
    const finding = result.findings[result.repair.findingIndex];
    const fingerprint = findingFingerprint(finding);
    const publishedFinding = findings.find((item) => item.fingerprint === fingerprint);
    repair = await publishPatchPullRequest({
      github,
      artifactDirectory,
      manifest,
      context,
      config,
      title: result.repair.title,
      summary: result.summary,
      body: result.repair.body,
      risk: result.repair.risk,
      readyForReview: result.repair.risk === "low",
      fingerprint,
      issueNumber: publishedFinding?.issueNumber ?? null,
      finding,
      dryRun
    });
    if (!dryRun && publishedFinding?.issueNumber && repair.url) {
      await github.upsertMarkerComment(
        publishedFinding.issueNumber,
        repairNotificationMarker(fingerprint),
        `A repair pull request was opened: ${repair.url}`,
        expectedAutomationIdentity()
      );
    }
  }
  return { findings, repair, dryRun };
}
