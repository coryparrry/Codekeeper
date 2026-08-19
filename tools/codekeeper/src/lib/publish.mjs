import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatch, collectWorkingTreeChanges, configureAutomationIdentity, createBranchAndCommit, createPatch, currentHead, ensureClean, gitText, pushBranch } from "./git.mjs";
import { GitHubClient, isAmbiguousGitHubMutationError, isOwnedMarkerComment } from "./github.mjs";
import { readRegularFile, warn } from "./io.mjs";
import { automaticRepairMarker, findingFingerprint, findingMarker, fixRunMarker, repairMarker, repairNotificationMarker, sha256 } from "./markers.mjs";
import { findingLabels, validatePatch } from "./policy.mjs";
import { publishPullRequestRepair } from "./pr-repair.mjs";
import { renderMaintenanceIssue, renderRepairPullRequest, sanitizeMarkdown, sanitizePublicTitle } from "./render.mjs";
import { assertNoPublicSecurityFindings } from "./security-containment.mjs";
import { loadArtifact } from "./publish/artifacts.mjs";
import {
  expectedAutomationIdentity,
  isRecoverableMaintenanceIssue,
  issueLabelNames,
  managedIssueLabels,
  matchesAutomationActor,
  normalizeAutomationIdentity,
  reconcileSecondaryIssue
} from "./publish/common.mjs";
import {
  acquireAutomaticRepairLease,
  publishReview as publishReviewImpl,
  reconcileAutoMerge,
  releaseAutomaticRepairLease,
  replyToReviewFeedback,
  reviewPublicationDisposition,
  upsertDeferredReviewFeedback
} from "./publish/review.mjs";

export {
  acquireAutomaticRepairLease,
  reconcileAutoMerge,
  replyToReviewFeedback,
  reviewPublicationDisposition,
  upsertDeferredReviewFeedback
};
export { publishIssue } from "./publish/issue.mjs";
export { isTrustedMaintenanceIssue } from "./publish/common.mjs";

// Live automatic-repair dispatch stays on this facade so source-scan contracts
// inspect authorization_mode and requested_by on the executed path.
async function dispatchAutomaticReviewRepair({
  github,
  pull,
  context,
  config,
  automationIdentity,
  repairFeedback,
  automaticRepair
}) {
  if (automaticRepair.eligible) {
    const authorizationPull = await github.getPull(pull.number);
    if (issueLabelNames(authorizationPull).includes("codekeeper:auto-repaired")) {
      automaticRepair.eligible = false;
    } else {
      const lease = await acquireAutomaticRepairLease({ github, context, pull, automationIdentity });
      if (!lease.acquired) {
        automaticRepair.eligible = false;
      } else {
        let dispatchAttempted = false;
        let dispatchSucceeded = false;
        try {
          await github.ensureLabels(config.labels, ["codekeeper:auto-repaired"]);
          await github.upsertMarkerComment(
            pull.number,
            automaticRepairMarker(pull.head.sha),
            `Automatic repair dispatch is pending for head ${pull.head.sha}.`,
            automationIdentity
          );
          dispatchAttempted = true;
          await github.createRepositoryDispatch("codekeeper_fix", {
            number: pull.number,
            head_sha: pull.head.sha,
            authorization_mode: "policy",
            requested_by: automationIdentity.login,
            review_thread_ids: [...new Set(repairFeedback.flatMap((feedback) => feedback.threadIds))]
          });
          dispatchSucceeded = true;
          automaticRepair.dispatched = true;
          await github.upsertMarkerComment(
            pull.number,
            automaticRepairMarker(pull.head.sha),
            `Automatic repair was dispatched for head ${pull.head.sha}.`,
            automationIdentity
          );
          await github.addLabels(pull.number, ["codekeeper:auto-repaired"]);
          await releaseAutomaticRepairLease(github, lease, "completed");
        } catch (error) {
          let rollbackError = null;
          const ambiguousDispatch = !dispatchSucceeded && dispatchAttempted && isAmbiguousGitHubMutationError(error);
          if (!dispatchSucceeded) {
            try {
              await github.upsertMarkerComment(
                pull.number,
                automaticRepairMarker(pull.head.sha),
                ambiguousDispatch
                  ? `Automatic repair dispatch is ambiguous for head ${pull.head.sha}.`
                  : `Automatic repair dispatch failed for head ${pull.head.sha}.`,
                automationIdentity
              );
            } catch (cause) {
              warn(`Could not record automatic repair dispatch state for PR #${pull.number}: ${cause.message}`);
            }
          }
          try {
            await releaseAutomaticRepairLease(
              github,
              lease,
              ambiguousDispatch ? "ambiguous" : dispatchSucceeded ? "completed" : "failed"
            );
          } catch (cause) {
            if (ambiguousDispatch) {
              warn(`Could not record ambiguous automatic repair dispatch for PR #${pull.number}: ${cause.message}`);
            } else {
              rollbackError ??= cause;
            }
          }
          if (rollbackError) {
            throw new Error(
              `${error.message}; automatic repair lease rollback failed: ${rollbackError.message}`,
              { cause: error }
            );
          }
          throw error;
        }
      }
    }
  }
}

export async function publishReview(options) {
  return publishReviewImpl({
    ...options,
    dispatchAutomaticReviewRepair
  });
}

function branchSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 240);
}

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

export function repairBranch(config, mode, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Repair fingerprint must be a SHA-256 hex digest");
  const branch = branchSlug(`${config.repository.automationBranchPrefix}${mode}-${fingerprint}`);
  if (!branch.endsWith(`-${fingerprint}`)) throw new Error("Automation branch prefix leaves no room for repair fingerprint");
  return branch;
}

export function isTrustedRepairPull(pull, { fingerprint, config, repository, botLogin, botId, mode }) {
  const identity = normalizeAutomationIdentity({ login: botLogin, id: botId });
  if (!identity) return false;
  const branch = repairBranch(config, mode, fingerprint);
  return Boolean(
    matchesAutomationActor(pull?.user, identity) &&
    typeof pull?.body === "string" &&
    pull.body.endsWith(repairMarker(fingerprint)) &&
    String(pull.head?.ref ?? "") === branch &&
    pull.head?.repo?.full_name === repository &&
    pull.base?.repo?.full_name === repository
  );
}

async function findOpenRepairPull(github, fingerprint, config, mode) {
  const automationIdentity = expectedAutomationIdentity();
  const branch = repairBranch(config, mode, fingerprint);
  const pull = await github.findOpenPullByHead(branch);
  return pull && isTrustedRepairPull(pull, {
    fingerprint,
    config,
    repository: github.repository,
    botLogin: automationIdentity.login,
    botId: automationIdentity.id,
    mode
  }) ? pull : null;
}

async function verifyExistingRepairPull({
  github,
  pull,
  branch,
  expectedTreeSha,
  context,
  config,
  fingerprint,
  automationIdentity
}) {
  const remote = await github.getBranchTip(branch);
  if (!remote) throw new Error(`Existing repair PR #${pull.number} has no live automation branch`);
  if (
    remote.treeSha !== expectedTreeSha ||
    remote.parentShas.length !== 1 ||
    remote.parentShas[0] !== context.baseSha
  ) {
    throw new Error(`Existing repair PR #${pull.number} no longer matches the sealed repair tree`);
  }
  const live = await github.getPull(pull.number, { expectedHeadSha: remote.headSha });
  if (!isTrustedRepairPull(live, {
    fingerprint,
    config,
    repository: github.repository,
    botLogin: automationIdentity.login,
    botId: automationIdentity.id,
    mode: context.mode
  })) {
    throw new Error(`Existing repair PR #${pull.number} is no longer trusted`);
  }
  const expectedBaseRef = context.defaultBranch ?? config.repository.defaultBranch;
  if (
    live.state !== "open" ||
    live.head?.ref !== branch ||
    live.head?.sha !== remote.headSha ||
    live.base?.ref !== expectedBaseRef ||
    live.base?.sha !== context.baseSha
  ) {
    throw new Error(`Existing repair PR #${pull.number} no longer matches the sealed repair target`);
  }
  return live;
}

async function publishPatchPullRequest({
  github,
  artifactDirectory,
  manifest,
  context,
  config,
  title,
  summary,
  body,
  risk,
  readyForReview,
  fingerprint,
  issueNumber = null,
  finding = null,
  dryRun = false
}) {
  if (!manifest.patch?.valid || !manifest.patch.fileName) {
    return { created: false, reason: manifest.patch?.reasons?.join("; ") || "No validated patch" };
  }

  const labels = new Set(["codekeeper:maintenance", `codekeeper:risk-${risk}`, "codekeeper:manual-review"]);
  if (finding) findingLabels(finding).forEach((label) => labels.add(label));
  if (currentHead() !== context.baseSha) {
    return { created: false, reason: `Default branch moved from ${context.baseSha} to ${currentHead()}` };
  }
  ensureClean();
  const patchPath = path.join(artifactDirectory, manifest.patch.fileName);
  const patchBytes = await readRegularFile(patchPath);
  if (sha256(patchBytes) !== manifest.patch.sha256) throw new Error("Patch artifact SHA-256 does not match manifest");
  if (patchBytes.length > config.audit.repair.maximumPatchBytes) {
    throw new Error(`Patch artifact is ${patchBytes.length} bytes; maximum is ${config.audit.repair.maximumPatchBytes}`);
  }
  applyPatch(patchPath);
  const liveChanges = { ...(await collectWorkingTreeChanges()), patchBytes: patchBytes.length };
  const livePolicy = validatePatch(liveChanges, config);
  if (!livePolicy.valid) throw new Error(`Fresh-checkout patch validation failed: ${livePolicy.reasons.join("; ")}`);
  const expectedFiles = [...manifest.patch.files].sort();
  const actualFiles = [...livePolicy.files].sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(`Fresh-checkout patch files differ from validated artifact: expected ${expectedFiles.join(", ")}, got ${actualFiles.join(", ")}`);
  }
  // Do not execute repository code in this token-bearing job. Configurable test
  // commands ran in the analysis job, which had no GitHub write token. Here we
  // only prove that the fresh checkout produces the exact validated patch.
  const freshPatchDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-publish-patch-"));
  const freshPatchPath = path.join(freshPatchDirectory, "fresh.diff");
  try {
    await createPatch(freshPatchPath);
    const freshPatchBytes = await readFile(freshPatchPath);
    if (sha256(freshPatchBytes) !== manifest.patch.sha256) {
      throw new Error("Fresh-checkout patch differs from the validated artifact");
    }
  } finally {
    await rm(freshPatchDirectory, { recursive: true, force: true });
  }

  const branch = repairBranch(config, context.mode, fingerprint);
  const normalizedTitle = sanitizePublicTitle(title, 200) || "chore: apply bounded maintenance repair";
  const draft = !readyForReview || risk !== "low";
  const validationReceipt = manifest.validation?.receipt;
  const validationCommands = validationReceipt?.commands ?? [];
  const validationSummary = [
    ...(validationCommands.length > 0
      ? validationCommands.map(
          (item) =>
            `- \`${item.command}\`: ${item.exitCode === 0 ? "passed" : "failed"} in ${item.durationMs} ms; stdout SHA-256 \`${item.stdoutDigest}\``,
        )
      : ["- No repository-specific validation commands were configured."]),
    `- Candidate SHA-256: \`${manifest.candidateSha256}\``,
    `- Base commit: \`${validationReceipt?.baseSha ?? context.baseSha}\``,
  ].join("\n");
  const prBody = renderRepairPullRequest({
    titleSummary: summary,
    body,
    finding,
    issueNumber,
    fingerprint,
    validationSummary,
    files: livePolicy.files
  });

  if (dryRun) {
    return { created: false, dryRun: true, branch, title: normalizedTitle, draft, files: livePolicy.files, prBody };
  }

  const automationIdentity = expectedAutomationIdentity();
  configureAutomationIdentity(automationIdentity);
  createBranchAndCommit({ branch, message: "chore: apply automated maintenance repair" });
  const expectedTreeSha = gitText(["rev-parse", "HEAD^{tree}"]);
  const existing = await findOpenRepairPull(github, fingerprint, config, context.mode);
  let pull = existing;
  let created = false;
  const remote = await github.getBranchTip(branch);
  if (!pull && remote && (
    remote.treeSha !== expectedTreeSha ||
    remote.parentShas.length !== 1 ||
    remote.parentShas[0] !== context.baseSha
  )) {
    throw new Error(`Automation branch ${branch} already exists with unexpected content`);
  }
  let pushedByThisRun = false;
  if (pull) {
    pull = await verifyExistingRepairPull({
      github, pull, branch, expectedTreeSha, context, config, fingerprint, automationIdentity
    });
  } else {
    if (!remote) {
      await github.mutateIfCurrent(() => pushBranch(branch, github.token));
      pushedByThisRun = true;
    }
    try {
      pull = await github.createPull({
        title: normalizedTitle,
        body: prBody,
        head: branch,
        base: context.defaultBranch ?? config.repository.defaultBranch,
        draft
      });
      created = true;
    } catch (error) {
      if (pushedByThisRun) {
        try {
          const existingPull = await github.findOpenPullByHead(branch);
          if (!existingPull) await github.deleteBranch(branch);
        } catch (cleanupError) {
          warn(`Could not remove orphaned automation branch ${branch}: ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }
  if (!dryRun) {
    if (!created) {
      pull = await verifyExistingRepairPull({
        github, pull, branch, expectedTreeSha, context, config, fingerprint, automationIdentity
      });
    }
    await github.ensureLabels(config.labels, [...labels]);
    if (!created) {
      pull = await verifyExistingRepairPull({
        github, pull, branch, expectedTreeSha, context, config, fingerprint, automationIdentity
      });
    }
    await github.replaceManagedLabels(pull.number, [...labels], managedIssueLabels(config));
  }
  return created
    ? {
      created: true,
      pullRequest: pull.number,
      url: pull.html_url,
      branch,
      draft,
      awaitingReview: true,
      reason: "Auto-merge is evaluated only after the current-head Codekeeper review publishes"
    }
    : { created: false, reason: "Existing repair PR", pullRequest: pull.number, url: pull.html_url };
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

export async function publishFix({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource = agentProfilePath ? "repository" : "package", agentProfileSourceSha, token, dryRun = false, prRepairGit }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "fix", config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource, agentProfileSourceSha);
  const github = new GitHubClient({ token, repository: context.repository });
  if (context.target?.kind === "pull_request") {
    return publishPullRequestRepair({
      github,
      artifactDirectory,
      manifest,
      context,
      result,
      config,
      automationIdentity: expectedAutomationIdentity(),
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
  const issue = await github.beginIssueMutation({
    issue: context.issue,
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
