import { issueDispatchReceipt } from "./commands.mjs";
import { reviewReasoningEscalation } from "./config.mjs";
import { boundedChangedFileStatsBetween, boundedDiffBetween, currentHead } from "./git.mjs";
import { GitHubClient, isOwnedMarkerComment } from "./github.mjs";
import { readJson } from "./io.mjs";
import { ISSUE_TRIAGE_MARKER, parseIssueTriageStateMarker, sha256 } from "./markers.mjs";
import { authorizedAutomaticRepairPlan } from "./repair-objectives.mjs";
import { parseOwnerCommand } from "./owner-commands.mjs";
import { evaluateReviewEligibility } from "./policy.mjs";
import { normalizeOwnerCommandContext, ownerContextMetadata, verifyOwnerCommandContext } from "./owner-command-prepare.mjs";
import { frozenPullRepairReviewThreads, frozenPullRepairSubject } from "./pr-repair.mjs";
import { completeReviewFeedback } from "./review-feedback.mjs";
import { auditSchema, fixSchema, issueSchema, reviewSchema } from "./schemas.mjs";
import { buildAuditPrompt, buildCoordinatorPrompt, buildFixPrompt, buildIssuePrompt, buildReviewPrompt } from "./prompts.mjs";
import { runUrl } from "./workspace.mjs";
import { boundedLabels, boundedOwnerComments, boundedText, isConfiguredOwner, runMetadata, trustedAgentProfile, writeBundle } from "./prepare-support.mjs";

function repositoryFromEvent(event) {
  return event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
}

function changedFileLimitReason(error) {
  const message = String(error?.message ?? "");
  return message.startsWith("Review changed-file context exceeds configured maximum of ") ? message : null;
}

function normalizedWords(value) {
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) ?? [],
  );
}

function overlapScore(a, right) {
  const b = normalizedWords(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function relatedCandidates(issue, candidates, kind, maximum = 5) {
  const needle = `${issue.title ?? ""}\n${issue.body ?? ""}`;
  const needleWords = normalizedWords(needle);
  return candidates
    .filter((candidate) => kind !== "issue" || candidate.number !== issue.number)
    .map((candidate) => ({
      kind,
      number: candidate.number,
      title: boundedText(candidate.title, 512, "…"),
      body: boundedText(candidate.body, 2000),
      labels: boundedLabels(candidate.labels),
      url: boundedText(candidate.html_url, 2048, "…"),
      score: overlapScore(needleWords, `${candidate.title ?? ""}\n${candidate.body ?? ""}`),
    }))
    .sort((a, b) => b.score - a.score || a.number - b.number)
    .slice(0, maximum)
    .map(({ score: _score, ...candidate }) => candidate);
}

function duplicateCandidates(issue, issues, maximum = 5) {
  return relatedCandidates(issue, issues, "issue", maximum);
}

function relatedPullRequests(issue, pulls, maximum = 5) {
  return relatedCandidates(issue, pulls, "pull_request", maximum);
}

const TRUSTED_ISSUE_COMMENT_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ISSUE_CONVERSATION_MAXIMUM_COMMENTS = 40;
const ISSUE_CONVERSATION_MAXIMUM_WINDOW_COMMENTS = ISSUE_CONVERSATION_MAXIMUM_COMMENTS + 1;
const ISSUE_CONVERSATION_MAXIMUM_COMMENT_BODY = 4_000;

function normalizedLogin(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function labelNames(labels) {
  return (labels ?? []).map((label) =>
    typeof label === "string" ? label : label?.name,
  );
}

function pullRequestFromEvent(event, repository) {
  const pull = event.pull_request;
  if (!pull) throw new Error("Pull request payload is missing");
  if (
    pull.head?.repo?.full_name !== repository ||
    (pull.base?.repo?.full_name && pull.base.repo.full_name !== repository)
  ) {
    throw new Error("Fork pull requests are unsupported; manual review is required");
  }
  return pull;
}

function numericCommentId(value) {
  const id = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(id) ? id : null;
}

function validTimestamp(value) {
  const text = String(value ?? "").trim();
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function commentTimestamp(comment) {
  return validTimestamp(comment?.updated_at) ?? validTimestamp(comment?.created_at);
}

function compareCommentsByTime(left, right) {
  const leftTime = Date.parse(commentTimestamp(left));
  const rightTime = Date.parse(commentTimestamp(right));
  if (leftTime !== rightTime) return leftTime - rightTime;
  return BigInt(numericCommentId(left.id)) < BigInt(numericCommentId(right.id)) ? -1 : 1;
}

function requireCommentShape(comment, name) {
  const id = numericCommentId(comment?.id);
  const author = normalizedLogin(comment?.user?.login);
  const createdAt = validTimestamp(comment?.created_at);
  if (!id || !author || !createdAt || typeof comment?.body !== "string") {
    throw new Error(`${name} is malformed`);
  }
  return { id, author, createdAt };
}

function issueConversation(comments, totalComments, { truncatedBefore = false } = {}) {
  const frozen = comments
    .map((comment) => {
      const { id, author, createdAt } = requireCommentShape(comment, `Issue comment ${comment?.id ?? "unknown"}`);
      const body = boundedText(comment.body, ISSUE_CONVERSATION_MAXIMUM_COMMENT_BODY);
      return {
        id,
        author,
        authorAssociation: boundedText(comment.author_association, 64, "…"),
        createdAt,
        updatedAt: validTimestamp(comment.updated_at) ?? createdAt,
        body,
        bodyTruncated: body.length !== comment.body.length,
      };
    })
    .sort((left, right) =>
      compareCommentsByTime(
        { id: left.id, created_at: left.createdAt, updated_at: left.updatedAt },
        {
          id: right.id,
          created_at: right.createdAt,
          updated_at: right.updatedAt,
        },
      ),
    );
  return {
    comments: frozen,
    includedComments: frozen.length,
    totalComments,
    truncatedBefore,
    truncated: truncatedBefore || totalComments > frozen.length || frozen.some((comment) => comment.bodyTruncated),
  };
}

async function configuredIssueTriageIdentity(github) {
  const login = normalizedLogin(process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN);
  const clientId = String(process.env.CODEKEEPER_APP_CLIENT_ID ?? "").trim();
  const match = login.match(/^([a-z0-9](?:[a-z0-9-]{0,38}))\[bot\]$/);
  if (!match || !/^[A-Za-z0-9._-]{1,256}$/.test(clientId)) {
    throw new Error("Comment-triggered triage requires the configured GitHub App bot login and client ID");
  }
  const [app, user] = await Promise.all([github.getApp(match[1]), github.getUser(login)]);
  if (normalizedLogin(app?.slug) !== match[1] || String(app?.client_id ?? "") !== clientId || normalizedLogin(user?.login) !== login || user?.type !== "Bot" || !numericCommentId(user?.id)) {
    throw new Error("Configured GitHub App identity could not be verified for comment-triggered triage");
  }
  return { login, id: numericCommentId(user.id) };
}

function trustedIssueCommentAuthor(comment, issue) {
  const author = normalizedLogin(comment?.user?.login);
  if (!author) return false;
  if (author === normalizedLogin(issue?.user?.login)) return true;
  return TRUSTED_ISSUE_COMMENT_ASSOCIATIONS.has(String(comment?.author_association ?? "").toUpperCase());
}

async function verifiedIssueDispatchReceipt({ event, github, repository, number, actor, allowedCommands }) {
  const payload = event?.client_payload;
  const command = String(payload?.command_name ?? "")
    .trim()
    .toLowerCase();
  if (!allowedCommands.includes(command)) {
    throw new Error("Owner-command dispatch has an invalid issue command");
  }
  const requestedBy = String(payload?.requested_by ?? "").trim();
  const commandCommentId = numericCommentId(payload?.command_comment_id);
  const receiptCommentId = numericCommentId(payload?.command_receipt_comment_id);
  if (!requestedBy || normalizedLogin(requestedBy) !== normalizedLogin(actor) || !commandCommentId || !receiptCommentId) {
    throw new Error("Owner-command dispatch identity is incomplete");
  }
  const expected = issueDispatchReceipt({
    repository,
    number,
    command,
    actor: requestedBy,
    commentId: commandCommentId,
  });
  if (payload?.command_request_id !== expected.requestId || payload?.command_receipt_sha256 !== expected.sha256) {
    throw new Error("Owner-command dispatch receipt identity is invalid");
  }

  const configuredLogin = normalizedLogin(process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN ?? process.env.GITHUB_ACTOR);
  const senderId = numericCommentId(event?.sender?.id);
  if (!configuredLogin || normalizedLogin(event?.sender?.login) !== configuredLogin || event?.sender?.type !== "Bot" || !senderId) {
    throw new Error("Owner-command dispatch sender is not the configured GitHub App");
  }

  const receipt = (await github.request("GET", github.repoPath(`/issues/comments/${receiptCommentId}`))).data;
  const receiptCreatedAt = validTimestamp(receipt?.created_at);
  const receiptUpdatedAt = validTimestamp(receipt?.updated_at);
  const expectedIssuePath = `/repos/${String(repository).toLowerCase()}/issues/${number}`;
  let receiptIssuePath = "";
  try {
    receiptIssuePath = new URL(receipt?.issue_url).pathname.toLowerCase();
  } catch {
    // The exact issue URL is checked below.
  }
  const authorIdentity = { login: configuredLogin, id: senderId };
  if (numericCommentId(receipt?.id) !== receiptCommentId || receiptIssuePath !== expectedIssuePath || !receiptCreatedAt || !receiptUpdatedAt || !isOwnedMarkerComment(receipt, expected.marker, authorIdentity) || receipt.body !== expected.content || sha256(receipt.body) !== expected.sha256) {
    throw new Error("Owner-command dispatch receipt is not the exact immutable App receipt");
  }
  return {
    command: expected.command,
    requestId: expected.requestId,
    commandCommentId,
    receiptCommentId,
    receiptSha256: expected.sha256,
    receiptAuthor: authorIdentity,
    receiptCreatedAt,
    receiptUpdatedAt,
  };
}

async function freezeCommentTriggeredIssue({ event, github }) {
  const eventIssue = event.issue;
  const eventComment = event.comment;
  const number = Number(eventIssue?.number);
  const eventCommentId = numericCommentId(eventComment?.id);
  if (!Number.isSafeInteger(number) || number <= 0 || !eventCommentId) {
    throw new Error("Comment-triggered triage event is malformed");
  }
  const issue = await github.getIssue(number);
  if (!issue || issue.pull_request || issue.number !== number || !Number.isSafeInteger(issue.comments) || issue.comments < 0) {
    throw new Error("Comment-triggered triage must target one current GitHub issue");
  }
  const identity = await configuredIssueTriageIdentity(github);
  const liveTrigger = await github.getIssueComment(eventCommentId);
  requireCommentShape(liveTrigger, `Issue comment ${eventCommentId}`);
  const eventAuthor = normalizedLogin(eventComment?.user?.login);
  if (!eventAuthor || eventAuthor !== normalizedLogin(liveTrigger.user?.login) || String(eventComment?.body ?? "") !== String(liveTrigger.body ?? "")) {
    throw new Error("Comment-triggered triage event no longer matches the current comment");
  }
  const recent = await github.listIssueCommentWindow(number, eventCommentId, ISSUE_CONVERSATION_MAXIMUM_COMMENTS);
  if (!recent || !Array.isArray(recent.comments) || typeof recent.truncatedBefore !== "boolean" || typeof recent.truncatedAfter !== "boolean" || recent.comments.length > ISSUE_CONVERSATION_MAXIMUM_COMMENTS * 3 || recent.comments.length > issue.comments) {
    throw new Error("Comment-triggered triage received an invalid current issue conversation");
  }
  const comments = recent.comments.sort(compareCommentsByTime);
  for (const comment of comments) requireCommentShape(comment, `Issue comment ${comment?.id ?? "unknown"}`);
  const trigger = comments.find((comment) => numericCommentId(comment?.id) === eventCommentId);
  if (!trigger || recent.triggerIncluded === false) {
    throw new Error("Comment-triggered triage exceeded its bounded comment-retrieval budget before reaching the triggering comment");
  }
  if (normalizedLogin(trigger.user?.login) !== normalizedLogin(liveTrigger.user?.login) || String(trigger.body ?? "") !== String(liveTrigger.body ?? "") || commentTimestamp(trigger) !== commentTimestamp(liveTrigger)) {
    throw new Error("Comment-triggered triage event no longer matches the current comment");
  }
  const configuredBotLogin = normalizedLogin(process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN);
  if (trigger?.user?.type === "Bot" && normalizedLogin(trigger.user?.login) === configuredBotLogin) {
    throw new Error("Codekeeper comments cannot trigger issue triage");
  }
  if (parseOwnerCommand(trigger.body, configuredBotLogin)) {
    throw new Error("Exact owner commands are handled by the repository assistant, not comment-triggered triage");
  }
  if (!trustedIssueCommentAuthor(trigger, issue)) {
    throw new Error("Comment-triggered triage requires the reporter or a trusted maintainer");
  }
  if (trigger?.user?.type === "Bot" && normalizedLogin(trigger.user?.login) === identity.login && String(trigger.user?.id ?? "") === identity.id) {
    throw new Error("Codekeeper comments cannot trigger issue triage");
  }
  const ownedMarkers = comments.filter((comment) => isOwnedMarkerComment(comment, ISSUE_TRIAGE_MARKER, identity)).sort(compareCommentsByTime);
  const latestMarker = ownedMarkers.at(-1);
  if (!latestMarker) {
    throw new Error("Comment-triggered triage requires a current Codekeeper triage marker");
  }
  const previousTriage = parseIssueTriageStateMarker(latestMarker.body);
  if (!previousTriage || previousTriage.missingInformation.length === 0) {
    throw new Error("Comment-triggered triage requires a validated Codekeeper missing-information result");
  }
  const triggerTime = Date.parse(commentTimestamp(trigger));
  const markerTime = Date.parse(commentTimestamp(latestMarker));
  if (!Number.isFinite(triggerTime) || !Number.isFinite(markerTime) || triggerTime <= markerTime) {
    throw new Error("Comment-triggered triage comment is stale relative to the latest Codekeeper triage result");
  }
  const markerIndex = comments.findIndex((comment) => numericCommentId(comment.id) === numericCommentId(latestMarker.id));
  const triggerIndex = comments.findIndex((comment) => numericCommentId(comment.id) === eventCommentId);
  const conversation = comments.slice(markerIndex, triggerIndex + 1);
  if (markerIndex < 0 || triggerIndex <= markerIndex || conversation.length > ISSUE_CONVERSATION_MAXIMUM_WINDOW_COMMENTS) {
    throw new Error("Comment-triggered triage conversation exceeds the bounded comment window");
  }
  return {
    issue,
    conversation: issueConversation(conversation, issue.comments, {
      truncatedBefore: recent.truncatedBefore || markerIndex > 0,
    }),
    previousTriage: {
      ...previousTriage,
      markerCommentId: numericCommentId(latestMarker.id),
      markerUpdatedAt: commentTimestamp(latestMarker),
    },
    trigger: {
      commentId: eventCommentId,
      author: normalizedLogin(trigger.user?.login),
      createdAt: validTimestamp(trigger.created_at),
      authorAssociation: String(trigger.author_association ?? ""),
    },
  };
}

export async function prepareReview({ eventPath, directory, config, token, toolingSha, configSha256, ownerCommandContext: ownerCommandContextInput, agentProfilePath, agentProfileSourceSha, agentProfileSource }) {
  const agentProfile = await trustedAgentProfile("review", agentProfilePath, agentProfileSourceSha, agentProfileSource);
  const event = await readJson(eventPath);
  const repository = repositoryFromEvent(event);
  const requestedOwnerContext = normalizeOwnerCommandContext(ownerCommandContextInput, event);
  let ownerContext = null;
  if (requestedOwnerContext) {
    const github = new GitHubClient({ token, repository });
    ownerContext = await verifyOwnerCommandContext({
      context: requestedOwnerContext,
      event,
      github,
      repository,
      config,
      allowedCommands: ["review", "rerun", "triage"],
      surfaces: ["pull-request", "review-thread"],
    });
    const pull = await github.getPull(ownerContext.targetNumber);
    if (pull.number !== ownerContext.targetNumber) {
      throw new Error("Owner-command review target changed before preparation");
    }
    if (ownerContext.headSha && pull.head?.sha !== ownerContext.headSha) {
      throw new Error(`PR #${ownerContext.targetNumber} moved from ${ownerContext.headSha} to ${pull.head?.sha}; stale owner review will not start`);
    }
    event.pull_request = pull;
  } else if (!event.pull_request && event.action === "codekeeper_review") {
    const number = Number(event.client_payload?.number);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Review dispatch has no valid pull request number");
    const github = new GitHubClient({ token, repository });
    event.pull_request = await github.getPull(number);
    if (event.client_payload?.head_sha && event.pull_request.head?.sha !== event.client_payload.head_sha) {
      throw new Error(`PR #${number} moved before the requested review started`);
    }
  }
  const pull = pullRequestFromEvent(event, repository);
  if (ownerContext && pull.number !== ownerContext.targetNumber) {
    throw new Error("Owner-command review target does not match the live pull request");
  }
  if (ownerContext && pull.state !== "open") {
    throw new Error(`PR #${ownerContext.targetNumber} is not open`);
  }
  if (ownerContext && pull.draft) {
    throw new Error(`PR #${ownerContext.targetNumber} is a draft; owner review will not start`);
  }
  if (ownerContext && !pull.base?.ref) {
    throw new Error(`PR #${ownerContext.targetNumber} has no base branch`);
  }
  const feedbackEvent = ownerContext ? ownerContext.command === "triage" : Boolean(event.review || event.comment?.pull_request_review_id || event.client_payload?.review_feedback);
  const ownerReview = ownerContext !== null;
  if (feedbackEvent && !ownerReview && event.action !== "codekeeper_review" && config.automation.reviewFeedbackTriage !== true) {
    throw new Error("Automatic review-feedback triage is off in the Codekeeper policy");
  }
  if (!feedbackEvent && !ownerReview && event.action !== "codekeeper_review" && config.automation.automaticPrReview !== true) {
    throw new Error("Automatic pull request review is off in the Codekeeper policy");
  }
  const reviewFeedback = feedbackEvent ? await completeReviewFeedback(new GitHubClient({ token, repository }), pull.number, config) : [];
  const context = {
    mode: "review",
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
    agentProfile: agentProfile.metadata,
    runUrl: runUrl(repository),
    pullRequest: {
      number: pull.number,
      title: boundedText(pull.title, 512, "…"),
      body: boundedText(pull.body, 20000),
      author: boundedText(pull.user?.login, 256, "…"),
      url: boundedText(pull.html_url, 2048, "…"),
      state: pull.state,
      draft: pull.draft === true,
      baseRef: boundedText(pull.base?.ref ?? config.repository.defaultBranch, 512, "…"),
      headRef: boundedText(pull.head?.ref, 512, "…"),
      baseSha: pull.base?.sha,
      headSha: pull.head?.sha,
      baseRepository: boundedText(pull.base?.repo?.full_name, 512, "…"),
      headRepository: boundedText(pull.head?.repo?.full_name, 512, "…"),
      labels: boundedLabels(pull.labels),
      reviewFeedbackFrozen: feedbackEvent || ownerContext?.command === "triage",
      reviewFeedback,
    },
    ownerCommandContext: ownerContextMetadata(ownerContext),
  };
  if (!context.pullRequest.baseSha || !context.pullRequest.headSha) {
    throw new Error("Pull request base/head SHA is missing");
  }
  const disabledDiff = {
    patch: "",
    bytes: 0,
    includedBytes: 0,
    truncated: false,
    disabled: true,
  };
  const [changeResult, diffResult] = await Promise.allSettled([boundedChangedFileStatsBetween(context.pullRequest.baseSha, context.pullRequest.headSha, config.review.maximumChangedFiles), config.review.includeDiffInAgentContext ? boundedDiffBetween(context.pullRequest.baseSha, context.pullRequest.headSha, config.review.maximumDiffBytes) : disabledDiff]);
  const reviewReasons = [];
  let changeSummary;
  if (changeResult.status === "fulfilled") {
    changeSummary = changeResult.value;
  } else {
    const reason = changedFileLimitReason(changeResult.reason);
    if (!reason) throw changeResult.reason;
    reviewReasons.push(reason);
    changeSummary = {
      files: [],
      additions: 0,
      deletions: 0,
      changedLines: 0,
      largestFileChangedLines: 0,
    };
  }
  if (diffResult.status === "rejected") throw diffResult.reason;
  const diff = diffResult.value;
  if (diff.truncated) {
    reviewReasons.push(`Review diff is ${diff.bytes} bytes; configured context maximum is ${config.review.maximumDiffBytes}`);
  }
  context.pullRequest.changedFiles = changeSummary.files.map((file) => file.path);
  context.pullRequest.changeSummary = {
    changedFiles: changeSummary.files.length,
    additions: changeSummary.additions,
    deletions: changeSummary.deletions,
    changedLines: changeSummary.changedLines,
    largestFileChangedLines: changeSummary.largestFileChangedLines,
  };
  context.pullRequest.diff = diff;
  context.pullRequest.eligibility = evaluateReviewEligibility({
    config,
    pullRequest: context.pullRequest,
    repository,
    reviewReasons,
  });
  context.pullRequest.reasoningEscalation = reviewReasoningEscalation(config, context);
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("review", context, config),
    workspacePrompt: buildReviewPrompt(context, config, agentProfile.text),
    schema: reviewSchema(config),
    agentProfile,
  });
  return context;
}

export async function prepareAudit({ directory, config, toolingSha, configSha256, actor, repairAuthorized = false, agentProfilePath, agentProfileSourceSha, agentProfileSource }) {
  if (typeof repairAuthorized !== "boolean") throw new Error("Maintenance repair authorization must be a boolean");
  if (repairAuthorized && !config.audit.repair.enabled) {
    throw new Error("Maintenance repair was authorized while audit.repair.enabled=false");
  }
  const agentProfile = await trustedAgentProfile("audit", agentProfilePath, agentProfileSourceSha, agentProfileSource);
  const repository = process.env.GITHUB_REPOSITORY;
  const context = {
    mode: "audit",
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
    agentProfile: agentProfile.metadata,
    runUrl: runUrl(repository),
    baseSha: currentHead(),
    defaultBranch: config.repository.defaultBranch,
    repairAuthorized,
    repairAuthorizedBy: repairAuthorized ? actor : null,
  };
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("audit", context, config),
    workspacePrompt: buildAuditPrompt(context, config, agentProfile.text),
    schema: auditSchema(config),
    agentProfile,
  });
  return context;
}

export async function prepareIssue({ eventPath, eventName = process.env.GITHUB_EVENT_NAME, targetNumber, actor, triageMode, directory, config, token, toolingSha, configSha256, ownerCommandContext: ownerCommandContextInput, agentProfilePath, agentProfileSourceSha, agentProfileSource }) {
  const agentProfile = await trustedAgentProfile("issue", agentProfilePath, agentProfileSourceSha, agentProfileSource);
  if (triageMode !== "automatic" && triageMode !== "manual") {
    throw new Error("Issue triage mode must be automatic or manual");
  }
  if (triageMode === "manual" && !isConfiguredOwner(config, actor)) {
    throw new Error(`Actor ${actor || "unknown"} is not authorised to request Codekeeper issue triage`);
  }
  if (triageMode === "automatic" && config.automation.issueTriage !== true) {
    throw new Error("Automatic issue triage is off in the Codekeeper policy");
  }
  const event = await readJson(eventPath);
  const repository = repositoryFromEvent(event);
  const github = new GitHubClient({ token, repository });
  const requestedOwnerContext = normalizeOwnerCommandContext(ownerCommandContextInput, event);
  let ownerContext = null;
  if (requestedOwnerContext) {
    if (triageMode !== "manual") throw new Error("Owner-command issue preparation requires manual triage mode");
    if (normalizedLogin(actor) !== requestedOwnerContext.actor) {
      throw new Error("Owner-command issue actor does not match the original owner comment");
    }
    ownerContext = await verifyOwnerCommandContext({
      context: requestedOwnerContext,
      event,
      github,
      repository,
      config,
      allowedCommands: ["review", "triage"],
      surfaces: ["issue"],
    });
    if (targetNumber !== undefined && Number(targetNumber) !== ownerContext.targetNumber) {
      throw new Error("Owner-command issue target does not match the prepared target");
    }
    targetNumber = ownerContext.targetNumber;
    event.issue = await github.getIssue(targetNumber);
  }
  let ownerCommandDispatch = null;
  if (!ownerContext && !event.issue && event.action === "codekeeper_issue") {
    const number = Number(event.client_payload?.number);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Issue dispatch has no valid issue number");
    if (triageMode !== "manual") throw new Error("Owner-command issue dispatch requires manual triage mode");
    event.issue = await github.getIssue(number);
    ownerCommandDispatch = await verifiedIssueDispatchReceipt({
      event,
      github,
      repository,
      number,
      actor,
      allowedCommands: ["review", "triage"],
    });
  } else if (!ownerContext && !event.issue && eventName === "workflow_dispatch") {
    const inputNumber = Number(event.inputs?.issue_number);
    if (!Number.isSafeInteger(targetNumber) || targetNumber <= 0 || inputNumber !== targetNumber) {
      throw new Error("Manual issue triage has no valid bound issue number");
    }
    if (triageMode !== "manual") {
      throw new Error("Manual issue triage requires manual triage mode");
    }
    event.issue = await github.getIssue(targetNumber);
  }
  const commentTriggered = !ownerContext && event.action === "created" && Boolean(event.comment);
  const continuation = commentTriggered ? await freezeCommentTriggeredIssue({ event, github }) : null;
  const issue = continuation?.issue ?? event.issue;
  if (!issue || issue.pull_request) throw new Error("Issue payload is missing or refers to a pull request");
  if (ownerContext && issue.state !== "open") {
    throw new Error(`#${ownerContext.targetNumber} is not open`);
  }
  const [existing, pulls, closingPulls] = await Promise.all([github.listOpenIssues(config.issues.maximumOpenIssueContext), github.listOpenPulls(config.issues.maximumOpenIssueContext), config.issues.closeResolvedIssues ? github.listMergedPullRequestsClosingIssue(issue.number) : Promise.resolve([])]);
  const context = {
    mode: "issue",
    triageMode,
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
    agentProfile: agentProfile.metadata,
    runUrl: runUrl(repository),
    baseSha: currentHead(),
    ownerCommandDispatch,
    ownerCommandContext: ownerContextMetadata(ownerContext),
    issue: {
      number: issue.number,
      title: boundedText(issue.title, 512, "…"),
      body: boundedText(issue.body, 30000),
      originalBody: boundedText(issue.body, 30000),
      author: boundedText(issue.user?.login, 256, "…"),
      url: boundedText(issue.html_url, 2048, "…"),
      updatedAt: issue.updated_at ?? "",
      labels: boundedLabels(issue.labels),
      conversation: continuation?.conversation ?? null,
      previousTriage: continuation?.previousTriage ?? null,
      triageTrigger: continuation?.trigger ?? null,
    },
    resolvedByPullRequest: closingPulls[0] ?? null,
    duplicateCandidates: duplicateCandidates(issue, existing),
    relatedPullRequests: relatedPullRequests(issue, pulls),
  };
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("issue", context, config),
    workspacePrompt: buildIssuePrompt(context, config, agentProfile.text),
    schema: issueSchema(config),
    agentProfile,
  });
  return context;
}

export async function prepareFix({ eventPath = process.env.GITHUB_EVENT_PATH, targetNumber, actor, authorizationMode = "owner", expectedHead = "", reviewThreadIds = [], directory, config, token, toolingSha, configSha256, ownerCommandContext: ownerCommandContextInput, agentProfilePath, agentProfileSourceSha, agentProfileSource }) {
  const agentProfile = await trustedAgentProfile("fix", agentProfilePath, agentProfileSourceSha, agentProfileSource);
  if (!["owner", "policy"].includes(authorizationMode)) {
    throw new Error("Codekeeper fix authorization mode must be owner or policy");
  }
  if (!Array.isArray(reviewThreadIds) || reviewThreadIds.length > 128 || new Set(reviewThreadIds).size !== reviewThreadIds.length || reviewThreadIds.some((threadId) => typeof threadId !== "string" || !threadId.trim() || threadId.length > 512)) {
    throw new Error("Codekeeper fix review thread IDs are invalid");
  }
  if (authorizationMode === "owner" && !isConfiguredOwner(config, actor)) {
    throw new Error(`Actor ${actor || "unknown"} is not authorised to request a Codekeeper fix`);
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const github = new GitHubClient({ token, repository });
  const event = eventPath ? await readJson(eventPath) : null;
  const requestedOwnerContext = normalizeOwnerCommandContext(ownerCommandContextInput, event ?? {});
  let ownerContext = null;
  if (requestedOwnerContext) {
    if (authorizationMode !== "owner") throw new Error("Direct owner-command repair requires owner authorization mode");
    if (targetNumber !== undefined && Number(targetNumber) !== requestedOwnerContext.targetNumber) {
      throw new Error("Owner-command repair target does not match the prepared target");
    }
    if (normalizedLogin(actor) !== requestedOwnerContext.actor) {
      throw new Error("Owner-command repair actor does not match the original owner comment");
    }
    ownerContext = await verifyOwnerCommandContext({
      context: requestedOwnerContext,
      event: event ?? {},
      github,
      repository,
      config,
      allowedCommands: ["implement", "repair", "fix"],
      surfaces: ["issue", "pull-request", "review-thread"],
    });
    targetNumber = ownerContext.targetNumber;
  }
  const [issue, comments] = await Promise.all([github.getIssue(targetNumber), github.listIssueComments(targetNumber)]);
  if (issue.number !== targetNumber) throw new Error(`GitHub returned an unexpected target for #${targetNumber}`);
  if (issue.state !== "open") throw new Error(`#${targetNumber} is not open`);
  let target;
  let baseSha;
  let subject;
  let ownerCommandDispatch = null;
  let repairPlan = null;
  let boundReviewThreadIds = [...reviewThreadIds];
  const boundExpectedHead = expectedHead || ownerContext?.headSha || "";
  if (issue.pull_request) {
    if (ownerContext && (ownerContext.surface === "issue" || ownerContext.command === "implement")) {
      throw new Error("Owner-command issue implementation cannot target a pull request");
    }
    const pull = await github.getPull(targetNumber);
    if (pull.number !== targetNumber || pull.state !== "open") throw new Error(`PR #${targetNumber} is not open`);
    if (pull.draft) throw new Error(`PR #${targetNumber} is a draft`);
    if (pull.head?.repo?.full_name !== repository || pull.base?.repo?.full_name !== repository) {
      throw new Error(`PR #${targetNumber} is not a same-repository pull request`);
    }
    if (pull.base?.ref !== config.repository.defaultBranch) {
      throw new Error(`PR #${targetNumber} does not target ${config.repository.defaultBranch}`);
    }
    if (pull.head?.ref === config.repository.defaultBranch) {
      throw new Error(`PR #${targetNumber} uses the default branch as its head`);
    }
    if (boundExpectedHead && pull.head?.sha !== boundExpectedHead) {
      throw new Error(`PR #${targetNumber} moved from ${boundExpectedHead} to ${pull.head?.sha}; stale repair will not start`);
    }
    const liveLabels = labelNames(issue.labels);
    if (
      liveLabels.includes("paused") ||
      (liveLabels.includes("codekeeper:paused") && !ownerContext)
    ) {
      throw new Error(`PR #${targetNumber} is paused`);
    }
    if (authorizationMode === "policy") {
      if (!config.review.autoRepair) throw new Error("Automatic review repair is off in the Codekeeper policy");
      if (!boundExpectedHead) throw new Error("Automatic review repair requires its dispatched head SHA");
      repairPlan = authorizedAutomaticRepairPlan({ comments, actor, headSha: boundExpectedHead });
    }
    if (ownerContext?.surface === "review-thread") {
      const threads = await github.listPullReviewThreads(targetNumber);
      const sourceCommentId = Number(ownerContext.commentId);
      const thread = threads.find((candidate) => (candidate.comments?.nodes ?? candidate.comments ?? []).some((comment) => Number(comment.databaseId ?? comment.id) === sourceCommentId));
      if (!thread) throw new Error(`Owner-command review thread ${ownerContext.reviewThreadId ?? sourceCommentId} no longer exists`);
      if (ownerContext.reviewThreadId && thread.id !== ownerContext.reviewThreadId) {
        throw new Error("Owner-command review thread does not match the live source comment");
      }
      if (boundReviewThreadIds.length > 0 && (boundReviewThreadIds.length !== 1 || boundReviewThreadIds[0] !== thread.id)) {
        throw new Error("Owner-command review repair must be bound to exactly its source thread");
      }
      boundReviewThreadIds = [thread.id];
    }
    const reviewThreads = boundReviewThreadIds.length > 0 ? frozenPullRepairReviewThreads(await github.listPullReviewThreads(targetNumber), boundReviewThreadIds) : [];
    if (!/^[0-9a-f]{40}$/i.test(String(pull.head?.sha ?? "")) || !/^[0-9a-f]{40}$/i.test(String(pull.base?.sha ?? ""))) {
      throw new Error(`PR #${targetNumber} is missing full head or base commit SHAs`);
    }
    target = {
      kind: "pull_request",
      number: targetNumber,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      headRepository: pull.head.repo.full_name,
      baseRef: pull.base.ref,
      reviewThreadIds: [...boundReviewThreadIds],
      baseSha: pull.base.sha,
      baseRepository: pull.base.repo.full_name,
    };
    baseSha = target.headSha;
    const repairEvidencePolicy = {
      authorizationMode,
      actor,
      ownerLogins: [...config.repository.ownerLogins],
    };
    const frozenSubject = frozenPullRepairSubject(pull, comments, reviewThreads, repairEvidencePolicy);
    subject = {
      pullRequest: frozenSubject,
    };
    target.subjectSha256 = sha256(JSON.stringify(frozenSubject));
  } else {
    if (ownerContext && (ownerContext.surface !== "issue" || ownerContext.command !== "implement")) {
      throw new Error("Owner-command pull-request repair cannot target an issue");
    }
    if (!ownerContext && event) {
      if (event.action === "codekeeper_fix") {
        if (authorizationMode !== "owner" || Number(event.client_payload?.number) !== targetNumber) {
          throw new Error("Owner-command issue implementation dispatch is invalid");
        }
        ownerCommandDispatch = await verifiedIssueDispatchReceipt({
          event,
          github,
          repository,
          number: targetNumber,
          actor,
          allowedCommands: ["implement"],
        });
      }
    }
    if (authorizationMode === "policy" && !config.issues.allowAiImplementation) {
      throw new Error("AI issue implementation is disabled by issues.allowAiImplementation=false");
    }
    if (reviewThreadIds.length > 0) throw new Error("Issue implementation cannot resolve pull request review threads");
    const liveLabels = labelNames(issue.labels);
    if (authorizationMode === "policy" && (liveLabels.includes("codekeeper:paused") || liveLabels.includes("paused"))) {
      throw new Error(`Issue #${targetNumber} is paused`);
    }
    if (authorizationMode === "policy" && !liveLabels.includes("codekeeper:ready")) {
      throw new Error("Automatic issue implementation requires the codekeeper:ready label");
    }
    target = { kind: "issue", number: targetNumber };
    baseSha = currentHead();
    subject = {
      issue: {
        number: issue.number,
        title: boundedText(issue.title, 512, "…"),
        body: boundedText(issue.body, 12000),
        author: boundedText(issue.user?.login, 256, "…"),
        url: boundedText(issue.html_url, 2048, "…"),
        updatedAt: issue.updated_at ?? "",
        labels: boundedLabels(issue.labels),
        comments: boundedOwnerComments(comments, config),
      },
    };
  }
  const context = {
    mode: "fix",
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
    agentProfile: agentProfile.metadata,
    runUrl: runUrl(repository),
    baseSha,
    defaultBranch: config.repository.defaultBranch,
    requestedBy: actor,
    authorizationMode,
    ownerCommandDispatch,
    target,
    ...subject,
    ownerCommandContext: ownerContextMetadata(ownerContext),
    ...(repairPlan?.clusters.length
      ? { repairObjectives: repairPlan.objectives, repairClusters: repairPlan.clusters }
      : {}),
  };
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("fix", context, config),
    workspacePrompt: buildFixPrompt(context, config, agentProfile.text),
    schema: fixSchema(target),
    agentProfile,
  });
  return context;
}
