import { GitHubClient, isAmbiguousGitHubMutationError, isOwnedMarkerComment } from "../github.mjs";
import { log, warn } from "../io.mjs";
import { REVIEW_MARKER, automaticRepairMarker, deferredReviewFingerprint, deferredReviewMarker, reviewFeedbackReplyMarker, sha256 } from "../markers.mjs";
import { evaluateAutoMerge, evaluateReviewEligibility, issueTypeLabel, reviewLabels } from "../policy.mjs";
import { normalizeReleaseOwnedPinReview, renderDeferredIssue, renderReviewComment, sanitizeMarkdown, sanitizePublicTitle } from "../render.mjs";
import { loadArtifact } from "./artifacts.mjs";
import {
  expectedAutomationIdentity,
  isTrustedMaintenanceIssue,
  managedIssueLabels,
  reconcileSecondaryIssue,
  trustedPublicationRunUrl
} from "./common.mjs";

const DEFERRED_RECONCILED_MARKER = "<!-- codekeeper:deferred-reconciled -->";
const AUTOMATIC_REPAIR_LEASE_MAX_AGE_MS = 15 * 60 * 1000;

function automaticRepairLeaseBody(state, scope, marker) {
  return `<!-- codekeeper:repair-lease-${state}=${scope} -->\n${marker}`;
}

function automaticRepairLeaseScope(repository, pullNumber, headSha) {
  return sha256(JSON.stringify({ repository, pullNumber, headSha }));
}

export async function acquireAutomaticRepairLease({ github, context, pull, automationIdentity }) {
  const scope = automaticRepairLeaseScope(context.repository, pull.number, pull.head.sha);
  const fingerprint = sha256(JSON.stringify({ scope, runId: context.runId }));
  const marker = `<!-- codekeeper:repair-lease=${fingerprint} -->`;
  const activeBody = automaticRepairLeaseBody("active", scope, marker);
  const created = await github.createComment(pull.number, activeBody);
  const comments = await github.listIssueComments(pull.number);
  const active = comments.filter((comment) => {
    const match = typeof comment.body === "string"
      ? comment.body.match(/<!-- codekeeper:repair-lease=([a-f0-9]{64}) -->$/)
      : null;
    return match
      && comment.body.startsWith(`<!-- codekeeper:repair-lease-active=${scope} -->\n`)
      && isOwnedMarkerComment(comment, match[0], automationIdentity)
      && /^[1-9][0-9]*$/.test(String(comment.id ?? ""));
  }).sort((left, right) => {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  if (!active.some((comment) => String(comment.id) === String(created.id))) {
    throw new Error("Automatic repair lease was not visible after creation");
  }
  const expiryBoundary = Date.now() - AUTOMATIC_REPAIR_LEASE_MAX_AGE_MS;
  const expired = active.filter((comment) => {
    const createdAt = Date.parse(String(comment.created_at ?? ""));
    return Number.isFinite(createdAt) && createdAt <= expiryBoundary;
  });
  for (const comment of expired) {
    const match = comment.body.match(/<!-- codekeeper:repair-lease=([a-f0-9]{64}) -->$/);
    await github.updateComment(
      comment.id,
      automaticRepairLeaseBody("expired", scope, match[0])
    );
  }
  const eligible = active.filter((comment) => !expired.includes(comment));
  const acquired = String(eligible[0]?.id) === String(created.id);
  const lease = { acquired, commentId: created.id, marker, scope };
  if (!acquired) {
    await github.updateComment(created.id, automaticRepairLeaseBody("released", scope, marker));
  }
  return lease;
}

export async function releaseAutomaticRepairLease(github, lease, state) {
  await github.updateComment(
    lease.commentId,
    automaticRepairLeaseBody(state, lease.scope, lease.marker)
  );
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
      if (isAmbiguousGitHubMutationError(error)) {
        const refreshedPull = await github.getPull(pullRequest.number);
        if (refreshedPull?.number === pullRequest.number && refreshedPull.auto_merge === null) {
          return { enabled: false, disabled: true, reason: "confirmed disabled after ambiguous disable request" };
        }
      }
      throw new Error(`Could not disable stale auto-merge for PR #${pullRequest.number}: ${error.message}`, { cause: error });
    }
  }

  return { enabled: false, disabled: false, reason: decision.reasons.join("; ") };
}

async function suspendAutoMerge(github, pullRequest) {
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
    refreshedPull = await github.getPull(pullRequest.number);
  } catch (error) {
    throw new Error(`Could not verify auto-merge was suspended for PR #${pullRequest.number}: ${error.message}`, { cause: error });
  }
  if (!Object.hasOwn(refreshedPull, "auto_merge") || refreshedPull.auto_merge) {
    const detail = disableError ? ` after GitHub reported: ${disableError.message}` : "";
    throw new Error(`Could not suspend auto-merge for PR #${pullRequest.number}${detail}`);
  }
  return { pullRequest: refreshedPull, disabled: true };
}

function ownedAutomaticRepairState(comments, automationIdentity, repository, pullNumber, currentHead) {
  let consumed = false;
  let pending = false;
  let expiredLease = false;
  const pendingScopes = new Set();
  const activeLeaseScopes = new Set();
  for (const comment of comments) {
    const body = String(comment?.body ?? "");
    const lease = body.match(/^<!-- codekeeper:repair-lease-(active|completed|ambiguous|expired)=([a-f0-9]{64}) -->\n[\s\S]*?(<!-- codekeeper:repair-lease=[a-f0-9]{64} -->)$/);
    if (lease && isOwnedMarkerComment(comment, lease[3], automationIdentity)) {
      if (lease[1] === "active") activeLeaseScopes.add(lease[2]);
      else if (lease[1] === "expired") expiredLease = true;
      else consumed = true;
      continue;
    }
    const match = body.match(/<!-- codekeeper:auto-repair-head=([0-9a-f]{40}) -->$/i);
    if (!match) continue;
    const marker = automaticRepairMarker(match[1]);
    if (!isOwnedMarkerComment(comment, marker, automationIdentity)) continue;
    if (/^(Automatic repair was dispatched|Automatic repair dispatch is ambiguous)/.test(body)) consumed = true;
    const legacyPending = body === `Automatic repair is pending for head ${match[1]}.\n${marker}`;
    if (body.startsWith("Automatic repair dispatch is pending") || legacyPending) {
      pendingScopes.add(automaticRepairLeaseScope(repository, pullNumber, match[1]));
      if (match[1].toLowerCase() === currentHead.toLowerCase()) pending = true;
    }
  }
  const unresolvedActiveLease = [...pendingScopes].some((scope) => activeLeaseScopes.has(scope));
  return { consumed: consumed || unresolvedActiveLease || (expiredLease && pending), pending };
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
    verifiedPull = await github.assertPullMutationCurrent();
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

export function reviewPublicationDisposition(context, pull) {
  const expected = context.pullRequest;
  const repositoryReasons = [];
  if (pull?.head?.repo?.full_name !== context.repository) repositoryReasons.push("Fork pull requests are unsupported");
  if (pull?.base?.repo?.full_name !== context.repository) repositoryReasons.push("Pull request base repository is unsupported");
  if (repositoryReasons.length > 0) return { disposition: "unsupported", reasons: repositoryReasons };
  const staleReasons = [];
  if (pull?.number !== expected.number) staleReasons.push("Pull request number changed");
  if (pull?.state !== "open") staleReasons.push(`Pull request state is ${pull?.state ?? "unavailable"}`);
  if (pull?.head?.sha !== expected.headSha) staleReasons.push("Pull request head SHA changed");
  if (pull?.base?.sha !== expected.baseSha) staleReasons.push("Pull request base SHA changed");
  if (pull?.base?.ref !== expected.baseRef) staleReasons.push("Pull request base branch changed");
  if (staleReasons.length > 0) return { disposition: "stale", reasons: staleReasons };
  if (pull.draft) {
    return { disposition: "manual", reasons: ["The live pull request is a draft; Codekeeper did not mutate GitHub"] };
  }
  return { disposition: "eligible", reasons: [] };
}

function sealedReviewLimitReasons(context) {
  return (context.pullRequest?.eligibility?.readOnlyReview?.reasons ?? []).filter((reason) =>
    String(reason).startsWith("Review changed-file context exceeds configured maximum of ") ||
    String(reason).startsWith("Review diff is ")
  );
}

export async function publishReview({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource = agentProfilePath ? "repository" : "package", agentProfileSourceSha, token, dryRun = false, dispatchAutomaticReviewRepair }) {
  const { context, result } = await loadArtifact(artifactDirectory, "review", config, configSha256, expectedManifestSha256, agentProfilePath, agentProfileSource, agentProfileSourceSha);
  const github = new GitHubClient({ token, repository: context.repository });
  let pull;
  try {
    pull = await github.beginPullMutation({
      repository: context.repository,
      pullRequest: context.pullRequest,
      policy: config,
      reviewPublication: true
    });
  } catch (error) {
    if (!/ is a draft; stale publication will not mutate GitHub$/.test(String(error?.message ?? ""))) throw error;
    const racedDisposition = reviewPublicationDisposition(context, await github.getPull(context.pullRequest.number));
    if (racedDisposition.disposition !== "manual") throw error;
    log(`REVIEW MANUAL PR #${context.pullRequest.number}`, { reasons: racedDisposition.reasons });
    return {
      pullRequest: context.pullRequest.number,
      disposition: "manual",
      published: false,
      reportOnly: true,
      reasons: racedDisposition.reasons,
      blocking: false,
      dryRun
    };
  }
  const eligibility = evaluateReviewEligibility({
    config,
    pullRequest: pull,
    repository: context.repository,
    reviewReasons: sealedReviewLimitReasons(context)
  });
  const files = await github.listPullFiles(pull.number, config.merge.maximumFiles + 1);
  const renderedResult = normalizeReleaseOwnedPinReview(result, files);
  const runUrl = trustedPublicationRunUrl(context);
  const automationBotLogin = String(process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN ?? "").trim().toLowerCase();
  const reviewContextComplete = context.pullRequest?.diff?.truncated === false && context.pullRequest.diff.disabled !== true;
  const critical = [...result.blockingFindings, ...result.nonBlockingFindings].some((finding) => finding.severity === "critical");
  const blocking = result.blockingFindings.length > 0 || critical ||
    result.reviewFeedback.some((feedback) => feedback.disposition === "fix_now") ||
    result.mergeRecommendation === "block";
  const existingLabels = new Set((pull.labels ?? []).map((label) => typeof label === "string" ? label : label.name));
  const defaultBaseTarget = pull.base?.ref === config.repository.defaultBranch;
  const automationMutationEligible = eligibility.automationMutation.eligible === true;
  const reportOnly = !automationMutationEligible;
  const manualEligibilityReasons = [
    ...eligibility.readOnlyReview.reasons,
    ...eligibility.automationMutation.reasons
  ];
  const repairFeedback = result.reviewFeedback.filter((feedback) =>
    feedback.disposition === "fix_now" || feedback.disposition === "fix_if_cheap"
  );
  const repairRequested = automationMutationEligible && defaultBaseTarget && (blocking || repairFeedback.length > 0) && config.review.autoRepair
    && !existingLabels.has("codekeeper:paused") && !existingLabels.has("paused");
  const repairMarked = automationMutationEligible && defaultBaseTarget && existingLabels.has("codekeeper:auto-repaired");
  let repairState = { consumed: false, pending: false };
  if (repairRequested || repairMarked) {
    repairState = ownedAutomaticRepairState(
      await github.listIssueComments(pull.number),
      expectedAutomationIdentity(),
      context.repository,
      pull.number,
      pull.head.sha
    );
  }
  const automaticRepair = {
    eligible: repairRequested && !repairState.consumed,
    consumed: repairState.consumed,
    pending: repairRequested && repairState.pending,
    staleMarker: repairMarked && !repairState.consumed,
    dispatched: false
  };
  const suspendAutoMergeForRepair = (decision) => {
    if (automaticRepair.eligible || automaticRepair.pending) {
      return { ...decision, eligible: false, reasons: [...decision.reasons, "Automatic repair is pending"] };
    }
    if (repairRequested && automaticRepair.consumed) {
      return { ...decision, eligible: false, reasons: [...decision.reasons, "Automatic repair pass is already consumed"] };
    }
    return decision;
  };
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
      comment: renderReviewComment(renderedResult, autoMerge, runUrl)
    };
  };

  let autoMerge = suspendAutoMergeForRepair(evaluateAutoMerge({ config, pullRequest: pull, files, reviewResult: result, reviewContextComplete, automationBotLogin }));
  if (reportOnly) {
    autoMerge = { ...autoMerge, eligible: false, reasons: [...new Set([...autoMerge.reasons, ...manualEligibilityReasons])] };
  }
  const initialState = publicationState(autoMerge);

  if (dryRun) {
    await github.assertMutationCurrent();
    log(`DRY RUN review PR #${pull.number}`, { ...initialState, autoMerge, blocking });
    return { pullRequest: pull.number, disposition: "published", ...initialState, autoMerge, automaticRepair, blocking, dryRun: true };
  }

  const automationIdentity = expectedAutomationIdentity();
  if (reportOnly) {
    await github.upsertMarkerComment(pull.number, REVIEW_MARKER, initialState.comment, automationIdentity);
    await github.assertMutationCurrent();
    return {
      pullRequest: pull.number,
      disposition: "published",
      published: true,
      reportOnly: true,
      desiredLabels: [],
      autoMerge,
      automaticRepair,
      blocking
    };
  }
  let reconciledPull = pull;
  if (automaticRepair.staleMarker) {
    await github.removeLabel(pull.number, "codekeeper:auto-repaired");
    reconciledPull = await github.getPull(pull.number);
  }
  const suspension = defaultBaseTarget
    ? await suspendAutoMerge(github, reconciledPull)
    : { pullRequest: reconciledPull, disabled: false };
  reconciledPull = suspension.pullRequest;
  let publishedAutoMerge = suspendAutoMergeForRepair(evaluateAutoMerge({ config, pullRequest: reconciledPull, files, reviewResult: result, reviewContextComplete, automationBotLogin: automationIdentity.login }));
  const eligibleState = publicationState(publishedAutoMerge);
  const manualFallbackState = publicationState({ ...publishedAutoMerge, eligible: false });
  const provisionedLabels = [...new Set([...eligibleState.desiredLabels, ...manualFallbackState.desiredLabels])];
  await github.ensureLabels(config.labels, provisionedLabels);

  const writePublicationState = async (decision) => {
    const state = publicationState(decision);
    await github.replaceManagedLabels(pull.number, state.desiredLabels, config.review.managedLabels);
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
  const feedbackReplies = await replyToReviewFeedback({
    github,
    context,
    result,
    automationIdentity,
    dryRun,
    retiredFingerprints: deferredIssues
      .filter((item) => item.state === "closed" || item.state === "would-close")
      .map((item) => item.fingerprint)
  });
  let autoMergeResult = {
    enabled: false,
    disabled: suspension.disabled,
    reason: suspension.disabled ? "suspended before publication" : publishedAutoMerge.reasons.join("; ")
  };

  if (publishedAutoMerge.eligible) {
    const activationPull = await github.getPull(pull.number);
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

  await dispatchAutomaticReviewRepair({
    github,
    pull,
    context,
    config,
    automationIdentity,
    repairFeedback,
    automaticRepair
  });

  await github.assertMutationCurrent();
  return { pullRequest: pull.number, disposition: "published", published: true, desiredLabels, autoMerge: publishedAutoMerge, autoMergeResult, automaticRepair, deferredIssues, feedbackReplies, blocking };
}

function rootReviewCommentIds(sources) {
  return [...new Set(sources
    .filter((source) => source.sourceKey.startsWith("review_comment:"))
    .map((source) => source.rootCommentId ?? Number(source.sourceKey.slice("review_comment:".length)))
    .filter((commentId) => Number.isSafeInteger(commentId) && commentId > 0))];
}

export async function replyToReviewFeedback({ github, context, result, automationIdentity, dryRun = false, retiredFingerprints = [] }) {
  const sourcesByKey = new Map((context.pullRequest.reviewFeedback ?? []).map((source) => [source.sourceKey, source]));
  const activeFingerprints = new Set((result.reviewFeedback ?? [])
    .flatMap((feedback) => [...new Set(feedback.sourceKeys)])
    .map((sourceKey) => deferredReviewFingerprint(context.repository, context.pullRequest.number, sourceKey)));
  const replies = [];
  for (const feedback of result.reviewFeedback.filter((item) => item.disposition !== "defer")) {
    const label = feedback.disposition === "fix_now" ? "Fix now"
      : feedback.disposition === "fix_if_cheap" ? "Fix if cheap"
        : "No action";
    const body = `${label}: ${sanitizeMarkdown(feedback.explanation)}\n\nValidation: ${sanitizeMarkdown(feedback.validation)}`;
    for (const sourceKey of [...new Set(feedback.sourceKeys)]) {
      const source = sourcesByKey.get(sourceKey);
      const commentIds = rootReviewCommentIds(source ? [source] : []);
      const fingerprint = deferredReviewFingerprint(context.repository, context.pullRequest.number, sourceKey);
      if (commentIds.length === 0) {
        if (!dryRun) {
          await github.upsertMarkerComment(context.pullRequest.number, reviewFeedbackReplyMarker(fingerprint), body, automationIdentity);
        }
        replies.push({ problemKey: feedback.problemKey, commentId: null, disposition: feedback.disposition, dryRun });
        continue;
      }
      for (const commentId of commentIds) {
        if (!dryRun) {
          await github.upsertReviewReply(context.pullRequest.number, commentId, reviewFeedbackReplyMarker(fingerprint), body, automationIdentity);
        }
        replies.push({ problemKey: feedback.problemKey, commentId, disposition: feedback.disposition, dryRun });
      }
    }
  }
  const retiredBody = "No longer current: this prior review-feedback disposition was replaced by the complete current review publication.";
  for (const fingerprint of [...new Set(retiredFingerprints)].filter((item) => !activeFingerprints.has(item))) {
    if (!dryRun) {
      await github.retireReviewFeedbackReply(
        context.pullRequest.number,
        reviewFeedbackReplyMarker(fingerprint),
        retiredBody,
        automationIdentity
      );
    }
    replies.push({ problemKey: null, commentId: null, disposition: "retired", dryRun });
  }
  return replies;
}

export async function upsertDeferredReviewFeedback({ github, context, result, config, automationIdentity, dryRun = false, ownerRequested = false }) {
  const deferred = result.reviewFeedback?.filter((item) => item.disposition === "defer") ?? [];
  if (!ownerRequested && !config.review.createDeferredIssues) return [];
  const existing = await github.listMaintenanceIssues("codekeeper:deferred");
  const sourcesByKey = new Map((context.pullRequest.reviewFeedback ?? []).map((source) => [source.sourceKey, source]));
  const published = [];
  const deferredSources = deferred.flatMap((feedback) =>
    [...new Set(feedback.sourceKeys)].map((sourceKey) => ({ feedback, sourceKey }))
  );
  const activeFingerprints = new Set(deferredSources.map(({ sourceKey }) =>
    deferredReviewFingerprint(context.repository, context.pullRequest.number, sourceKey)
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
    await reconcileSecondaryIssue(github, issue, () => github.updateIssue(issue.number, {
      body: issue.body.replace(markerMatch[0], `${DEFERRED_RECONCILED_MARKER}\n${markerMatch[0]}`),
      state: "closed",
      state_reason: "completed"
    }));
    published.push({ fingerprint: markerMatch[1], state: "closed", issueNumber: issue.number });
  }
  for (const { feedback, sourceKey } of deferredSources) {
    const scopedFeedback = { ...feedback, sourceKeys: [sourceKey] };
    const fingerprint = deferredReviewFingerprint(context.repository, context.pullRequest.number, sourceKey);
    const marker = deferredReviewMarker(fingerprint);
    const match = existing.find((issue) => isTrustedMaintenanceIssue(issue, {
      marker,
      botLogin: automationIdentity.login,
      botId: automationIdentity.id
    }));
    const sources = [sourcesByKey.get(sourceKey)].filter(Boolean);
    const labels = ["codekeeper:deferred", issueTypeLabel(feedback.type)];
    const title = sanitizePublicTitle(
      `[Deferred from PR #${context.pullRequest.number}] ${feedback.explanation}`,
      256
    );
    const body = renderDeferredIssue({
      feedback: scopedFeedback,
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
      issue = await reconcileSecondaryIssue(github, match, async () => {
        const updated = await github.updateIssue(match.number, {
          title,
          body,
          ...(automaticallyReconciled ? { state: "open", state_reason: null } : {})
        });
        await github.replaceManagedLabels(match.number, labels, managedIssueLabels(config));
        return updated;
      });
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
