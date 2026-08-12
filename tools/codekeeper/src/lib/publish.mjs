import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_PROFILE_BUNDLE_FILE, loadTrustedAgentProfile } from "./agent-profiles.mjs";
import { applyPatch, collectWorkingTreeChanges, configureAutomationIdentity, createBranchAndCommit, createPatch, currentHead, ensureClean, gitText, pushBranch } from "./git.mjs";
import { GitHubClient } from "./github.mjs";
import { readRegularFile, log, warn } from "./io.mjs";
import { ISSUE_TRIAGE_MARKER, REVIEW_MARKER, deferredReviewFingerprint, deferredReviewMarker, findingFingerprint, findingMarker, fixRunMarker, repairMarker, repairNotificationMarker, reviewFeedbackReplyMarker, sha256 } from "./markers.mjs";
import { evaluateAutoMerge, findingLabels, issueTypeLabel, reviewLabels, validatePatch } from "./policy.mjs";
import { completeReviewFeedback } from "./prepare.mjs";
import { publishPullRequestRepair } from "./pr-repair.mjs";
import { renderDeferredIssue, renderIssueTriage, renderMaintenanceIssue, renderRepairPullRequest, renderReviewComment, sanitizeMarkdown } from "./render.mjs";
import { validateAuditResult, validateFixResult, validateIssueResult, validateReviewResult } from "./schemas.mjs";

const DEFERRED_RECONCILED_MARKER = "<!-- codekeeper:deferred-reconciled -->";

function singleLine(value, maximum = 256) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maximum);
}

function parseArtifactJson(bytes, name) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in sealed artifact ${name}: ${error.message}`);
  }
}

function validateArtifactResult(mode, result, context, config) {
  if (mode === "review") return validateReviewResult(result, config);
  if (mode === "audit") return validateAuditResult(result, config);
  if (mode === "issue") return validateIssueResult(result, config);
  if (mode === "fix") return validateFixResult(result, context.target);
  throw new Error(`Unsupported artifact mode: ${mode}`);
}

async function loadArtifact(artifactDirectory, expectedMode, config, configSha256, expectedManifestSha256, agentProfilePath) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedManifestSha256 ?? ""))) {
    throw new Error("Publisher requires the trusted sealed manifest SHA-256");
  }
  const manifestBytes = await readRegularFile(path.join(artifactDirectory, "manifest.json"));
  if (sha256(manifestBytes) !== expectedManifestSha256) {
    throw new Error("Sealed artifact manifest changed after sealing");
  }
  const manifest = parseArtifactJson(manifestBytes, "manifest.json");
  if (manifest.version !== 3) throw new Error("Unsupported artifact manifest version");
  if (manifest.sealed !== true) throw new Error("Only sealed artifacts may be published");
  if (!/^[a-f0-9]{64}$/i.test(String(configSha256 ?? ""))) {
    throw new Error("Publisher requires the SHA-256 of its frozen configuration");
  }

  const [contextBytes, resultBytes, configBytes, validationBytes, agentProfileBytes, runtimeMetadataBytes] = await Promise.all([
    readRegularFile(path.join(artifactDirectory, "context.json")),
    readRegularFile(path.join(artifactDirectory, "result.json")),
    readRegularFile(path.join(artifactDirectory, "config.json")),
    readRegularFile(path.join(artifactDirectory, "validation.json")),
    readRegularFile(path.join(artifactDirectory, AGENT_PROFILE_BUNDLE_FILE)),
    readRegularFile(path.join(artifactDirectory, "runtime-metadata.json"))
  ]);
  if (
    sha256(contextBytes) !== manifest.contextSha256 ||
    sha256(resultBytes) !== manifest.resultSha256 ||
    sha256(configBytes) !== manifest.configFileSha256 ||
    sha256(validationBytes) !== manifest.validationSha256 ||
    sha256(agentProfileBytes) !== manifest.agentProfileSha256 ||
    sha256(runtimeMetadataBytes) !== manifest.runtimeMetadataSha256
  ) {
    throw new Error("Sealed artifact component changed after sealing");
  }

  const context = parseArtifactJson(contextBytes, "context.json");
  const result = parseArtifactJson(resultBytes, "result.json");
  const artifactConfig = parseArtifactJson(configBytes, "config.json");
  const validation = parseArtifactJson(validationBytes, "validation.json");
  if (manifest.configSha256 !== configSha256 || context.configSha256 !== configSha256) {
    throw new Error("Artifact configuration does not match the publisher's frozen configuration");
  }
  if (JSON.stringify(artifactConfig) !== JSON.stringify(config)) {
    throw new Error("Sealed artifact configuration differs from the trusted publisher configuration");
  }
  if (manifest.mode !== expectedMode || context.mode !== expectedMode || result.mode !== expectedMode) {
    throw new Error(`Artifact mode mismatch; expected ${expectedMode}`);
  }
  if (manifest.repository !== context.repository) throw new Error("Artifact repository fields do not match");
  if (JSON.stringify(manifest.context) !== JSON.stringify(context)) {
    throw new Error("Artifact context does not match its trusted manifest");
  }
  if (JSON.stringify(manifest.validation) !== JSON.stringify(validation)) {
    throw new Error("Artifact validation does not match its trusted manifest");
  }
  if (sha256(agentProfileBytes) !== context.agentProfile?.sha256) {
    throw new Error("Sealed artifact agent profile does not match its frozen context");
  }
  const liveProfile = await loadTrustedAgentProfile({
    mode: expectedMode,
    sourcePath: agentProfilePath,
    sourceSha: context.agentProfile?.sourceSha
  });
  if (liveProfile.metadata.path !== context.agentProfile?.path || liveProfile.metadata.sha256 !== context.agentProfile?.sha256) {
    throw new Error("Agent profile changed after preparation; stale action will not publish");
  }
  if (manifest.patch?.valid) {
    const patchBytes = await readRegularFile(path.join(artifactDirectory, "patch.diff"));
    if (sha256(patchBytes) !== manifest.patchSha256 || sha256(patchBytes) !== manifest.patch.sha256) {
      throw new Error("Sealed artifact patch changed after sealing");
    }
  } else if (manifest.patchSha256 !== null) {
    throw new Error("Sealed artifact contains an unexpected patch hash");
  }
  validateArtifactResult(expectedMode, result, context, config);
  if (process.env.GITHUB_REPOSITORY && context.repository !== process.env.GITHUB_REPOSITORY) {
    throw new Error(`Artifact targets ${context.repository}; workflow repository is ${process.env.GITHUB_REPOSITORY}`);
  }
  return { manifest, context, result };
}

function managedIssueLabels(config) {
  return config.issues.managedLabels;
}

async function currentOpenIssue(github, frozenIssue, staleAction, { rejectPaused = false } = {}) {
  const issue = await github.getIssue(frozenIssue.number);
  if (issue.pull_request) throw new Error(`Issue #${issue.number} is no longer eligible`);
  if (issue.state !== "open") throw new Error(`Issue #${issue.number} is not open`);
  if (rejectPaused && issueLabelNames(issue).includes("codekeeper:paused")) {
    throw new Error(`Issue #${issue.number} is paused; automatic publication stopped`);
  }
  if (frozenIssue.updatedAt && issue.updated_at !== frozenIssue.updatedAt) {
    throw new Error(`Issue #${issue.number} changed after ${staleAction}; stale action will not publish`);
  }
  return issue;
}

function issueLabelNames(issue) {
  if (!Array.isArray(issue?.labels)) throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid label metadata`);
  const names = issue.labels.map((label) => typeof label === "string" ? label : label?.name);
  if (names.some((label) => typeof label !== "string" || label.length === 0) || new Set(names).size !== names.length) {
    throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid or duplicate label metadata`);
  }
  return names;
}

function issuePublicationSubject(issue) {
  return {
    number: issue?.number,
    title: issue?.title ?? null,
    body: issue?.body ?? null,
    state: issue?.state ?? null,
    stateReason: issue?.state_reason ?? null,
    locked: issue?.locked ?? null,
    activeLockReason: issue?.active_lock_reason ?? null,
    htmlUrl: issue?.html_url ?? null,
    author: {
      id: issue?.user?.id ?? null,
      login: issue?.user?.login ?? null,
      type: issue?.user?.type ?? null
    },
    assignees: (issue?.assignees ?? [])
      .map((assignee) => ({ id: assignee?.id ?? null, login: assignee?.login ?? null, type: assignee?.type ?? null }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    milestone: issue?.milestone?.number ?? null
  };
}

function assertExpectedManagedLabelMutation(before, after, desired, managed) {
  if (after?.pull_request || after?.state !== "open") throw new Error(`Issue #${before.number} is no longer eligible`);
  if (JSON.stringify(issuePublicationSubject(after)) !== JSON.stringify(issuePublicationSubject(before))) {
    throw new Error(`Issue #${before.number} changed while Codekeeper reconciled labels`);
  }
  const managedSet = new Set(managed);
  const expectedLabels = new Set([
    ...issueLabelNames(before).filter((label) => !managedSet.has(label)),
    ...desired
  ]);
  const actualLabels = new Set(issueLabelNames(after));
  const exactLabels = actualLabels.size === expectedLabels.size && [...expectedLabels].every((label) => actualLabels.has(label));
  if (!exactLabels) throw new Error(`Issue #${before.number} labels changed while Codekeeper reconciled labels`);
  if (typeof after.updated_at !== "string" || !Number.isFinite(Date.parse(after.updated_at))) {
    throw new Error(`Issue #${before.number} has no updated timestamp after label reconciliation`);
  }
  return after;
}

function branchSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 240);
}

export async function reconcileAutoMerge(github, pullRequest, config, decision) {
  if (decision.eligible) {
    if (pullRequest.auto_merge) {
      return { enabled: true, disabled: false, reason: "already enabled" };
    }
    try {
      await github.enableAutoMerge(pullRequest.node_id, config.merge.method);
      return { enabled: true, disabled: false, reason: "enabled" };
    } catch (error) {
      warn(`Could not enable auto-merge for PR #${pullRequest.number}: ${error.message}`);
      let refreshedPull;
      try {
        refreshedPull = await github.getPull(pullRequest.number);
      } catch (refetchError) {
        throw new Error(`Could not determine auto-merge state for PR #${pullRequest.number} after failed enablement: ${refetchError.message}`, { cause: refetchError });
      }
      if (refreshedPull?.number !== pullRequest.number || !Object.hasOwn(refreshedPull, "auto_merge")) {
        throw new Error(`Could not determine auto-merge state for PR #${pullRequest.number} after failed enablement`);
      }
      if (refreshedPull.auto_merge) {
        return { enabled: true, disabled: false, reason: "confirmed enabled after failed enable request" };
      }
      if (refreshedPull.auto_merge === null) {
        return { enabled: false, disabled: false, reason: error.message };
      }
      throw new Error(`Could not determine auto-merge state for PR #${pullRequest.number} after failed enablement`);
    }
  }

  if (pullRequest.auto_merge) {
    try {
      await github.disableAutoMerge(pullRequest.node_id);
      return { enabled: false, disabled: true, reason: decision.reasons.join("; ") || "policy no longer permits auto-merge" };
    } catch (error) {
      throw new Error(`Could not disable stale auto-merge for PR #${pullRequest.number}: ${error.message}`, { cause: error });
    }
  }

  return { enabled: false, disabled: false, reason: decision.reasons.join("; ") };
}

async function suspendAutoMerge(github, pullRequest, refreshPull) {
  if (!pullRequest.auto_merge) return { pullRequest, disabled: false };
  let disableError = null;
  try {
    await github.disableAutoMerge(pullRequest.node_id);
  } catch (error) {
    disableError = error;
    warn(`Could not confirm auto-merge disablement for PR #${pullRequest.number}: ${error.message}`);
  }

  let refreshedPull;
  try {
    refreshedPull = await refreshPull();
  } catch (error) {
    throw new Error(`Could not verify auto-merge was suspended for PR #${pullRequest.number}: ${error.message}`, { cause: error });
  }
  if (!Object.hasOwn(refreshedPull, "auto_merge") || refreshedPull.auto_merge) {
    const detail = disableError ? ` after GitHub reported: ${disableError.message}` : "";
    throw new Error(`Could not suspend auto-merge for PR #${pullRequest.number}${detail}`);
  }
  return { pullRequest: refreshedPull, disabled: true };
}

async function currentReviewPull(github, context, config) {
  const pull = await github.getPull(context.pullRequest.number);
  if (pull.state !== "open") throw new Error(`PR #${pull.number} is not open`);
  if (pull.head.sha !== context.pullRequest.headSha) {
    throw new Error(`PR #${pull.number} moved from ${context.pullRequest.headSha} to ${pull.head.sha}; stale review will not publish`);
  }
  if (pull.base.sha !== context.pullRequest.baseSha) {
    throw new Error(`PR #${pull.number} base moved from ${context.pullRequest.baseSha} to ${pull.base.sha}; stale review will not publish`);
  }
  if (pull.base.ref !== config.repository.defaultBranch) {
    throw new Error(`PR #${pull.number} base branch changed from ${config.repository.defaultBranch} to ${pull.base.ref}; stale review will not publish`);
  }
  if (pull.head.repo?.full_name !== context.repository || pull.base.repo?.full_name !== context.repository) {
    throw new Error(`PR #${pull.number} repository changed; stale review will not publish`);
  }
  return pull;
}

async function assertCurrentReviewFeedback(github, context) {
  const frozen = context.pullRequest.reviewFeedback ?? [];
  if (context.pullRequest.reviewFeedbackFrozen !== true && frozen.length === 0) return;
  const current = await completeReviewFeedback(github, context.pullRequest.number);
  if (JSON.stringify(current) !== JSON.stringify(frozen)) {
    throw new Error(`PR #${context.pullRequest.number} review feedback changed after preparation; stale feedback disposition will not publish`);
  }
}

async function disableFailedAutoMergePostcondition(github, pullRequest, cause) {
  let disableError = null;
  try {
    await github.disableAutoMerge(pullRequest.node_id);
  } catch (error) {
    disableError = error;
  }
  let refreshedPull;
  try {
    refreshedPull = await github.getPull(pullRequest.number);
  } catch (error) {
    throw new Error(`Auto-merge postcondition failed for PR #${pullRequest.number} and disablement could not be verified: ${error.message}`, { cause });
  }
  if (disableError || refreshedPull?.number !== pullRequest.number || refreshedPull.auto_merge !== null) {
    const detail = disableError ? `: ${disableError.message}` : "";
    throw new Error(`Auto-merge postcondition failed for PR #${pullRequest.number} and auto-merge could not be disabled${detail}`, { cause });
  }
  throw new Error(`Auto-merge postcondition failed for PR #${pullRequest.number}: ${cause.message}`, { cause });
}

async function verifyAutoMergePostcondition({
  github,
  activationPull,
  context,
  config,
  files,
  reviewResult,
  reviewContextComplete,
  automationBotLogin
}) {
  let verifiedPull;
  try {
    verifiedPull = await currentReviewPull(github, context, config);
  } catch (error) {
    return disableFailedAutoMergePostcondition(github, activationPull, error);
  }
  const verifiedDecision = evaluateAutoMerge({
    config,
    pullRequest: verifiedPull,
    files,
    reviewResult,
    reviewContextComplete,
    automationBotLogin
  });
  if (!verifiedPull.auto_merge || !verifiedDecision.eligible) {
    const reason = !verifiedPull.auto_merge
      ? "GitHub did not report auto-merge as active"
      : verifiedDecision.reasons.join("; ") || "the pull request is no longer eligible";
    return disableFailedAutoMergePostcondition(
      github,
      verifiedPull.auto_merge ? verifiedPull : activationPull,
      new Error(reason)
    );
  }
  return verifiedDecision;
}

export async function publishReview({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, token, dryRun = false }) {
  const { context, result } = await loadArtifact(artifactDirectory, "review", config, configSha256, expectedManifestSha256, agentProfilePath);
  const github = new GitHubClient({ token, repository: context.repository });
  const pull = await currentReviewPull(github, context, config);
  const files = await github.listPullFiles(pull.number, config.merge.maximumFiles + 1);
  await assertCurrentReviewFeedback(github, context);
  const runUrl = trustedPublicationRunUrl(context);
  const automationBotLogin = String(process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN ?? "").trim().toLowerCase();
  const reviewContextComplete = context.pullRequest?.diff?.truncated === false && context.pullRequest.diff.disabled !== true;
  const critical = [...result.blockingFindings, ...result.nonBlockingFindings].some((finding) => finding.severity === "critical");
  const blocking = result.blockingFindings.length > 0 || critical ||
    result.reviewFeedback.some((feedback) => feedback.disposition === "fix_now") ||
    result.mergeRecommendation === "block";
  const existingLabels = new Set((pull.labels ?? []).map((label) => typeof label === "string" ? label : label.name));
  const repairFeedback = result.reviewFeedback.filter((feedback) =>
    feedback.disposition === "fix_now" || feedback.disposition === "fix_if_cheap"
  );
  const automaticRepair = {
    eligible: (blocking || repairFeedback.length > 0) && config.review.autoRepair && !existingLabels.has("codekeeper:paused") && !existingLabels.has("codekeeper:auto-repaired"),
    dispatched: false
  };
  const suspendAutoMergeForRepair = (decision) => automaticRepair.eligible
    ? { ...decision, eligible: false, reasons: [...decision.reasons, "Automatic repair is pending"] }
    : decision;
  const publicationState = (autoMerge) => {
    const desiredSet = new Set(reviewLabels(result));
    desiredSet.delete("codekeeper:auto-merge");
    desiredSet.delete("codekeeper:manual-review");
    if (blocking) {
      desiredSet.add("codekeeper:blocked");
    } else if (autoMerge.eligible) {
      desiredSet.add("codekeeper:auto-merge");
    } else {
      desiredSet.add("codekeeper:manual-review");
    }
    return {
      desiredLabels: [...desiredSet],
      comment: renderReviewComment(result, autoMerge, runUrl)
    };
  };

  const autoMerge = suspendAutoMergeForRepair(evaluateAutoMerge({ config, pullRequest: pull, files, reviewResult: result, reviewContextComplete, automationBotLogin }));
  const initialState = publicationState(autoMerge);

  if (dryRun) {
    log(`DRY RUN review PR #${pull.number}`, { ...initialState, autoMerge, blocking });
    return { pullRequest: pull.number, ...initialState, autoMerge, blocking, dryRun: true };
  }

  const automationIdentity = expectedAutomationIdentity();
  let reconciledPull = await currentReviewPull(github, context, config);
  const suspension = await suspendAutoMerge(
    github,
    reconciledPull,
    () => currentReviewPull(github, context, config)
  );
  reconciledPull = suspension.pullRequest;
  let publishedAutoMerge = suspendAutoMergeForRepair(evaluateAutoMerge({ config, pullRequest: reconciledPull, files, reviewResult: result, reviewContextComplete, automationBotLogin: automationIdentity.login }));
  const eligibleState = publicationState(publishedAutoMerge);
  const manualFallbackState = publicationState({ ...publishedAutoMerge, eligible: false });
  const provisionedLabels = [...new Set([...eligibleState.desiredLabels, ...manualFallbackState.desiredLabels])];
  await github.ensureLabels(config.labels, provisionedLabels);

  const writePublicationState = async (decision) => {
    const state = publicationState(decision);
    await currentReviewPull(github, context, config);
    await github.replaceManagedLabels(pull.number, state.desiredLabels, config.review.managedLabels);
    await currentReviewPull(github, context, config);
    await github.upsertMarkerComment(
      pull.number,
      REVIEW_MARKER,
      state.comment,
      automationIdentity
    );
    return state;
  };

  let { desiredLabels } = await writePublicationState(publishedAutoMerge);
  const deferredIssues = await upsertDeferredReviewFeedback({
    github,
    context,
    result,
    config,
    automationIdentity,
    dryRun
  });
  const feedbackReplies = await replyToReviewFeedback({ github, context, result, automationIdentity, dryRun });
  let autoMergeResult = {
    enabled: false,
    disabled: suspension.disabled,
    reason: suspension.disabled ? "suspended before publication" : publishedAutoMerge.reasons.join("; ")
  };

  if (publishedAutoMerge.eligible) {
    const activationPull = await currentReviewPull(github, context, config);
    const activationDecision = evaluateAutoMerge({ config, pullRequest: activationPull, files, reviewResult: result, reviewContextComplete, automationBotLogin: automationIdentity.login });
    if (!activationDecision.eligible) {
      publishedAutoMerge = activationDecision;
      ({ desiredLabels } = await writePublicationState(publishedAutoMerge));
      autoMergeResult = { enabled: false, disabled: suspension.disabled, reason: activationDecision.reasons.join("; ") };
    } else {
      autoMergeResult = await reconcileAutoMerge(github, activationPull, config, activationDecision);
      publishedAutoMerge = activationDecision;
      if (autoMergeResult.enabled) {
        publishedAutoMerge = await verifyAutoMergePostcondition({
          github,
          activationPull,
          context,
          config,
          files,
          reviewResult: result,
          reviewContextComplete,
          automationBotLogin: automationIdentity.login
        });
      }
      if (!autoMergeResult.enabled) {
        publishedAutoMerge = {
          ...activationDecision,
          eligible: false,
          reasons: [...activationDecision.reasons, `Auto-merge is not active: ${autoMergeResult.reason || "enablement failed"}`]
        };
        ({ desiredLabels } = await writePublicationState(publishedAutoMerge));
      }
    }
  }

  if (automaticRepair.eligible) {
    await currentReviewPull(github, context, config);
    await github.ensureLabels(config.labels, ["codekeeper:auto-repaired"]);
    await github.addLabels(pull.number, ["codekeeper:auto-repaired"]);
    await currentReviewPull(github, context, config);
    await github.createRepositoryDispatch("codekeeper_fix", {
      number: pull.number,
      head_sha: pull.head.sha,
      authorization_mode: "policy",
      requested_by: automationIdentity.login,
      review_thread_ids: [...new Set(repairFeedback.flatMap((feedback) => feedback.threadIds))]
    });
    automaticRepair.dispatched = true;
  }

  return { pullRequest: pull.number, desiredLabels, autoMerge: publishedAutoMerge, autoMergeResult, automaticRepair, deferredIssues, feedbackReplies, blocking };
}

function rootReviewCommentIds(sources) {
  return [...new Set(sources
    .filter((source) => source.sourceKey.startsWith("review_comment:"))
    .map((source) => source.rootCommentId ?? Number(source.sourceKey.slice("review_comment:".length)))
    .filter((commentId) => Number.isSafeInteger(commentId) && commentId > 0))];
}

export async function replyToReviewFeedback({ github, context, result, automationIdentity, dryRun = false }) {
  const sourcesByKey = new Map((context.pullRequest.reviewFeedback ?? []).map((source) => [source.sourceKey, source]));
  const replies = [];
  for (const feedback of result.reviewFeedback.filter((item) => item.disposition !== "defer")) {
    const commentIds = rootReviewCommentIds(feedback.sourceKeys.map((key) => sourcesByKey.get(key)).filter(Boolean));
    const fingerprint = deferredReviewFingerprint(context.repository, context.pullRequest.number, feedback.sourceKeys);
    const label = feedback.disposition === "fix_now" ? "Fix now"
      : feedback.disposition === "fix_if_cheap" ? "Fix if cheap"
        : "No action";
    const body = `${label}: ${sanitizeMarkdown(feedback.explanation)}\n\nValidation: ${sanitizeMarkdown(feedback.validation)}`;
    for (const commentId of commentIds) {
      if (!dryRun) {
        await github.upsertReviewReply(context.pullRequest.number, commentId, reviewFeedbackReplyMarker(fingerprint), body, automationIdentity);
      }
      replies.push({ problemKey: feedback.problemKey, commentId, disposition: feedback.disposition, dryRun });
    }
  }
  return replies;
}

export async function upsertDeferredReviewFeedback({ github, context, result, config, automationIdentity, dryRun = false, ownerRequested = false }) {
  const deferred = result.reviewFeedback?.filter((item) => item.disposition === "defer") ?? [];
  if (!ownerRequested && !config.review.createDeferredIssues) return [];
  const existing = await github.listMaintenanceIssues("codekeeper:deferred");
  const sourcesByKey = new Map((context.pullRequest.reviewFeedback ?? []).map((source) => [source.sourceKey, source]));
  const published = [];
  const activeFingerprints = new Set(deferred.map((feedback) =>
    deferredReviewFingerprint(context.repository, context.pullRequest.number, feedback.sourceKeys)
  ));
  const origin = `- Pull request: [#${context.pullRequest.number}](${context.pullRequest.url})`;
  for (const issue of ownerRequested ? [] : existing) {
    const markerMatch = typeof issue.body === "string"
      ? issue.body.match(/<!-- codekeeper:deferred=([a-f0-9]{64}) -->$/)
      : null;
    if (
      issue.state !== "open" ||
      !markerMatch ||
      !issue.body.includes(origin) ||
      activeFingerprints.has(markerMatch[1]) ||
      !isTrustedMaintenanceIssue(issue, {
        marker: markerMatch[0],
        botLogin: automationIdentity.login,
        botId: automationIdentity.id
      })
    ) continue;
    if (dryRun) {
      published.push({ fingerprint: markerMatch[1], state: "would-close", issueNumber: issue.number });
      continue;
    }
    await github.updateIssue(issue.number, {
      body: issue.body.replace(markerMatch[0], `${DEFERRED_RECONCILED_MARKER}\n${markerMatch[0]}`),
      state: "closed",
      state_reason: "completed"
    });
    published.push({ fingerprint: markerMatch[1], state: "closed", issueNumber: issue.number });
  }
  for (const feedback of deferred) {
    const fingerprint = deferredReviewFingerprint(context.repository, context.pullRequest.number, feedback.sourceKeys);
    const marker = deferredReviewMarker(fingerprint);
    const match = existing.find((issue) => isTrustedMaintenanceIssue(issue, {
      marker,
      botLogin: automationIdentity.login,
      botId: automationIdentity.id
    }));
    const sources = feedback.sourceKeys.map((key) => sourcesByKey.get(key)).filter(Boolean);
    const labels = ["codekeeper:deferred", issueTypeLabel(feedback.type)];
    const title = singleLine(`[Deferred from PR #${context.pullRequest.number}] ${feedback.explanation}`, 256);
    const body = renderDeferredIssue({
      feedback,
      pullRequest: context.pullRequest,
      sources,
      marker,
      runUrl: context.runUrl
    });
    const automaticallyReconciled = match?.state === "closed" && match.body.includes(DEFERRED_RECONCILED_MARKER);
    if (match?.state === "closed" && !automaticallyReconciled) {
      published.push({ fingerprint, state: "acknowledged", issueNumber: match.number });
      continue;
    }
    if (dryRun) {
      published.push({
        fingerprint,
        state: automaticallyReconciled ? "would-reopen" : match ? "would-update" : "would-create",
        issueNumber: match?.number ?? null
      });
      continue;
    }
    await github.ensureLabels(config.labels, labels);
    let issue;
    if (match) {
      issue = await github.updateIssue(match.number, {
        title,
        body,
        ...(automaticallyReconciled ? { state: "open", state_reason: null } : {})
      });
      await github.replaceManagedLabels(match.number, labels, managedIssueLabels(config));
    } else {
      issue = await github.createIssue({ title, body, labels });
      existing.push(issue);
    }
    const issueUrl = issue.html_url ?? `https://github.com/${context.repository}/issues/${issue.number}`;
    const reply = `Deferred verified review feedback to [issue #${issue.number}](${issueUrl}). This review thread remains open for human disposition.`;
    const rootCommentIds = rootReviewCommentIds(sources);
    if (rootCommentIds.length > 0) {
      for (const commentId of rootCommentIds) {
        await github.upsertReviewReply(context.pullRequest.number, commentId, reviewFeedbackReplyMarker(fingerprint), reply, automationIdentity);
      }
    } else {
      await github.upsertMarkerComment(context.pullRequest.number, reviewFeedbackReplyMarker(fingerprint), reply, automationIdentity);
    }
    published.push({
      fingerprint,
      state: automaticallyReconciled ? "reopened" : match ? "updated" : "created",
      issueNumber: issue.number
    });
  }
  return published;
}

export async function publishIssue({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, token, dryRun = false }) {
  const { context, result } = await loadArtifact(artifactDirectory, "issue", config, configSha256, expectedManifestSha256, agentProfilePath);
  const github = new GitHubClient({ token, repository: context.repository });
  let expectedUpdatedAt = context.issue.updatedAt;
  const currentIssue = () => currentOpenIssue(github, { ...context.issue, updatedAt: expectedUpdatedAt }, "analysis");
  const issue = await currentIssue();
  const runUrl = trustedPublicationRunUrl(context);

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
  if (config.issues.allowAiImplementation && result.implementationRecommendation === "ai-ready") {
    desired.add("codekeeper:ready");
  }
  if (result.duplicateOf && result.duplicateConfidence === "high") desired.add("codekeeper:duplicate-candidate");
  const desiredLabels = [...desired];
  const comment = renderIssueTriage(result, runUrl);

  if (dryRun) {
    log(`DRY RUN issue triage #${issue.number}`, { desiredLabels, comment });
    return { issue: issue.number, desiredLabels, dryRun: true };
  }

  // GitHub does not expose an atomic compare-and-mutate for issue updates. These
  // checks fail closed on observed drift immediately before each mutation boundary.
  await currentIssue();
  await github.ensureLabels(config.labels, desiredLabels);
  const beforeLabelMutation = await currentIssue();
  await github.replaceManagedLabels(issue.number, desiredLabels, managedIssueLabels(config));
  const afterLabelMutation = assertExpectedManagedLabelMutation(
    beforeLabelMutation,
    await github.getIssue(issue.number),
    desiredLabels,
    managedIssueLabels(config)
  );
  expectedUpdatedAt = afterLabelMutation.updated_at;
  assertExpectedManagedLabelMutation(
    afterLabelMutation,
    await currentIssue(),
    desiredLabels,
    managedIssueLabels(config)
  );
  await github.upsertMarkerComment(
    issue.number,
    ISSUE_TRIAGE_MARKER,
    comment,
    automationIdentity
  );

  if (result.duplicateOf === issue.number) {
    throw new Error(`Issue #${issue.number} cannot be its own duplicate`);
  }
  if (config.issues.closeExactDuplicates && result.duplicateOf && result.duplicateConfidence === "high") {
    const duplicateContext = { number: result.duplicateOf };
    await currentIssue();
    const duplicate = await currentOpenIssue(github, duplicateContext, "duplicate assessment");
    await github.createComment(issue.number, `Closing as a duplicate of #${duplicate.number}.`);
    await currentIssue();
    await currentOpenIssue(github, duplicateContext, "duplicate assessment");
    await github.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
  }
  return { issue: issue.number, desiredLabels };
}

function matchesAutomationActor(actor, identity) {
  return Boolean(
    actor?.type === "Bot" &&
    String(actor.login ?? "").trim().toLowerCase() === identity.login &&
    String(actor.id ?? "") === identity.id
  );
}

export function isTrustedMaintenanceIssue(issue, { marker, botLogin, botId }) {
  const identity = normalizeAutomationIdentity({ login: botLogin, id: botId });
  return Boolean(
    identity &&
    matchesAutomationActor(issue?.user, identity) &&
    typeof issue?.body === "string" &&
    issue.body.endsWith(marker)
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
      if (isTrustedMaintenanceIssue(issue, {
        marker,
        botLogin: automationIdentity.login,
        botId: automationIdentity.id
      })) {
        match = issue;
        break;
      }
    }
    const labels = [...new Set([...findingLabels(finding), `codekeeper:priority-${finding.priority}`])];
    const title = singleLine(`[AI maintenance] ${finding.title}`) || "[AI maintenance] Repository finding";
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
      await github.updateIssue(match.number, { title, body });
      await github.replaceManagedLabels(match.number, labels, managedIssueLabels(config));
      published.push({ fingerprint, state: "updated", issueNumber: match.number });
    } else {
      const created = await github.createIssue({ title, body, labels });
      published.push({ fingerprint, state: "created", issueNumber: created.number });
      existing.push(created);
    }
  }
  return published;
}

function normalizeAutomationIdentity({ login, id }) {
  const normalizedLogin = String(login ?? "").trim().toLowerCase();
  const normalizedId = String(id ?? "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\[bot\]$/.test(normalizedLogin) || !/^[1-9]\d*$/.test(normalizedId)) {
    return null;
  }
  return { login: normalizedLogin, id: normalizedId };
}

function expectedAutomationIdentity() {
  const login = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const id = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const identity = normalizeAutomationIdentity({ login, id });
  if (!identity) {
    throw new Error("CODEKEEPER_AUTOMATION_BOT_LOGIN and CODEKEEPER_AUTOMATION_BOT_ID must identify the configured GitHub App bot");
  }
  return identity;
}

function trustedPublicationRunUrl(context) {
  const repository = String(context?.repository ?? "");
  const runId = String(context?.runId ?? "");
  const raw = String(context?.runUrl ?? "");
  if (!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || !/^[1-9]\d{0,19}$/.test(runId) || raw.length > 2048) {
    throw new Error("Publication context has no valid workflow run URL");
  }
  let run;
  let server;
  try {
    run = new URL(raw);
    server = new URL(process.env.GITHUB_SERVER_URL ?? "https://github.com");
  } catch {
    throw new Error("Publication context has no valid workflow run URL");
  }
  if (run.protocol !== "https:" || run.origin !== server.origin || run.username || run.password || run.search || run.hash || run.pathname !== `/${repository}/actions/runs/${runId}`) {
    throw new Error("Publication context has no valid workflow run URL");
  }
  return run.toString();
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
  revalidateBeforeMutation = null,
  dryRun = false
}) {
  if (!manifest.patch?.valid || !manifest.patch.fileName) {
    return { created: false, reason: manifest.patch?.reasons?.join("; ") || "No validated patch" };
  }

  const labels = new Set(["codekeeper:maintenance", `codekeeper:risk-${risk}`, "codekeeper:manual-review"]);
  if (finding) findingLabels(finding).forEach((label) => labels.add(label));
  const existing = await findOpenRepairPull(github, fingerprint, config, context.mode);
  let pull = existing;
  let created = false;
  let branch;
  let draft;
  if (!pull) {
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

    branch = repairBranch(config, context.mode, fingerprint);
    const normalizedTitle = singleLine(title, 200) || "chore: apply bounded maintenance repair";
    draft = !readyForReview || risk !== "low";
    const validationSummary = [
      ...(manifest.validation?.commands ?? []).map((item) => `- \`${item.command}\`: ${item.success ? "passed" : "failed"}`),
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
    if (revalidateBeforeMutation) await revalidateBeforeMutation();
    const remote = await github.getBranchTip(branch);
    let pushedByThisRun = false;
    if (remote) {
      if (
        remote.treeSha !== gitText(["rev-parse", "HEAD^{tree}"]) ||
        remote.parentShas.length !== 1 ||
        remote.parentShas[0] !== context.baseSha
      ) {
        throw new Error(`Automation branch ${branch} already exists with unexpected content`);
      }
    } else {
      pushBranch(branch, github.token);
      pushedByThisRun = true;
    }
    try {
      if (revalidateBeforeMutation) await revalidateBeforeMutation();
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
    if (revalidateBeforeMutation) await revalidateBeforeMutation();
    await github.ensureLabels(config.labels, [...labels]);
    if (revalidateBeforeMutation) await revalidateBeforeMutation();
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

export async function publishAudit({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, token, dryRun = false }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "audit", config, configSha256, expectedManifestSha256, agentProfilePath);
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

export async function publishFix({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, token, dryRun = false, prRepairGit }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "fix", config, configSha256, expectedManifestSha256, agentProfilePath);
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
  const currentIssue = () => currentOpenIssue(github, context.issue, "implementation started", {
    rejectPaused: context.authorizationMode === "policy"
  });
  const issue = await currentIssue();

  if (!manifest.patch?.valid) {
    const reason = result.noChangeReason || manifest.patch?.reasons?.join("; ") || "No valid patch was produced";
    if (!dryRun) {
      await currentIssue();
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
    revalidateBeforeMutation: currentIssue,
    dryRun
  });
  if (!dryRun && repair.url) {
    await currentIssue();
    await github.upsertMarkerComment(
      issue.number,
      repairNotificationMarker(fingerprint),
      `Codekeeper opened a repair pull request: ${repair.url}`,
      expectedAutomationIdentity()
    );
  }
  return repair;
}
