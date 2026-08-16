import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AGENT_PROFILE_BUNDLE_FILE, loadTrustedAgentProfile } from "./agent-profiles.mjs";
import { reviewReasoningEscalation } from "./config.mjs";
import { boundedChangedFileStatsBetween, boundedDiffBetween, currentHead } from "./git.mjs";
import { GitHubClient } from "./github.mjs";
import { readJson, writeJson, writeText } from "./io.mjs";
import { automaticRepairMarker, sha256 } from "./markers.mjs";
import { frozenPullRepairReviewThreads, frozenPullRepairSubject } from "./pr-repair.mjs";
import { completeReviewFeedback } from "./review-feedback.mjs";
import { auditSchema, fixSchema, issueSchema, providerCompatibleJsonSchema, reviewSchema } from "./schemas.mjs";
import { buildAuditPrompt, buildCoordinatorPrompt, buildFixPrompt, buildIssuePrompt, buildReviewPrompt } from "./prompts.mjs";
import { assertRunnerOwnedDirectory, runUrl } from "./workspace.mjs";

function repositoryFromEvent(event) {
  return event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
}

function boundedText(value, maximum, suffix = "\n…[truncated]") {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

function boundedLabels(labels, maximum = 30) {
  return (labels ?? [])
    .slice(0, maximum)
    .map((label) => boundedText(typeof label === "string" ? label : label?.name, 128, "…"));
}

function labelNames(labels) {
  return (labels ?? []).map((label) => typeof label === "string" ? label : label?.name);
}

function configuredOwnerLogins(config) {
  return new Set((config.repository.ownerLogins ?? []).map((login) => String(login).trim().toLowerCase()));
}

function isConfiguredOwner(config, actor) {
  const normalizedActor = String(actor ?? "").trim().toLowerCase();
  return normalizedActor.length > 0 && configuredOwnerLogins(config).has(normalizedActor);
}

function ensureSameRepositoryPullRequest(event, repository) {
  const pull = event.pull_request;
  if (!pull) throw new Error("Pull request payload is missing");
  if (pull.head?.repo?.full_name !== repository) {
    throw new Error("Fork pull requests are not eligible for Codekeeper automation");
  }
  if (pull.draft) throw new Error("Draft pull requests are not eligible for automatic review");
  return pull;
}

async function writeBundle({ directory, context, prompt, workspacePrompt, schema, agentProfile }) {
  directory = assertRunnerOwnedDirectory(directory);
  await mkdir(path.dirname(directory), { recursive: true });
  directory = assertRunnerOwnedDirectory(directory);
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Runner-owned bundle directory already exists: ${directory}`);
    throw error;
  }
  directory = assertRunnerOwnedDirectory(directory);
  await writeFile(path.join(directory, AGENT_PROFILE_BUNDLE_FILE), agentProfile.bytes, { flag: "wx" });
  await writeJson(path.join(directory, "context.json"), context);
  await writeText(path.join(directory, "prompt.md"), `${prompt}\n`);
  await writeText(path.join(directory, "workspace-prompt.md"), `${workspacePrompt}\n`);
  await writeJson(path.join(directory, "schema.json"), providerCompatibleJsonSchema(schema));
}

function trustedAgentProfile(mode, agentProfilePath, agentProfileSourceSha, agentProfileSource) {
  return loadTrustedAgentProfile({
    mode,
    source: agentProfileSource,
    sourcePath: agentProfilePath,
    sourceSha: agentProfileSourceSha
  });
}

function runMetadata({ toolingSha = process.env.CODEKEEPER_TOOLING_SHA ?? "", configSha256 = "" } = {}) {
  return {
    runId: process.env.GITHUB_RUN_ID ?? "",
    toolingSha: String(toolingSha).trim(),
    configSha256: String(configSha256).trim()
  };
}

function normalizedWords(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
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
      score: overlapScore(needleWords, `${candidate.title ?? ""}\n${candidate.body ?? ""}`)
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

function boundedOwnerComments(comments, config) {
  const owners = configuredOwnerLogins(config);
  return comments
    .filter((comment) => owners.has(String(comment.user?.login ?? "").trim().toLowerCase()))
    .slice(-5)
    .map((comment) => ({
      author: boundedText(comment.user?.login, 256, "…"),
      body: boundedText(comment.body, 2000),
      createdAt: comment.created_at ?? ""
    }));
}

export async function prepareReview({ eventPath, directory, config, token, toolingSha, configSha256, agentProfilePath, agentProfileSourceSha, agentProfileSource }) {
  const agentProfile = await trustedAgentProfile("review", agentProfilePath, agentProfileSourceSha, agentProfileSource);
  const event = await readJson(eventPath);
  const repository = repositoryFromEvent(event);
  if (!event.pull_request && event.action === "codekeeper_review") {
    const number = Number(event.client_payload?.number);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Review dispatch has no valid pull request number");
    const github = new GitHubClient({ token, repository });
    event.pull_request = await github.getPull(number);
    if (event.client_payload?.head_sha && event.pull_request.head?.sha !== event.client_payload.head_sha) {
      throw new Error(`PR #${number} moved before the requested review started`);
    }
  }
  const pull = ensureSameRepositoryPullRequest(event, repository);
  const feedbackEvent = Boolean(event.review || event.comment?.pull_request_review_id || event.client_payload?.review_feedback);
  if (feedbackEvent && event.action !== "codekeeper_review" && config.automation.reviewFeedbackTriage !== true) {
    throw new Error("Automatic review-feedback triage is off in the Codekeeper policy");
  }
  if (!feedbackEvent && event.action !== "codekeeper_review" && config.automation.automaticPrReview !== true) {
    throw new Error("Automatic pull request review is off in the Codekeeper policy");
  }
  const reviewFeedback = feedbackEvent
    ? await completeReviewFeedback(new GitHubClient({ token, repository }), pull.number, config)
    : [];
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
      baseRef: boundedText(pull.base?.ref ?? config.repository.defaultBranch, 512, "…"),
      headRef: boundedText(pull.head?.ref, 512, "…"),
      baseSha: pull.base?.sha,
      headSha: pull.head?.sha,
      labels: boundedLabels(pull.labels),
      reviewFeedbackFrozen: feedbackEvent,
      reviewFeedback
    }
  };
  if (!context.pullRequest.baseSha || !context.pullRequest.headSha) {
    throw new Error("Pull request base/head SHA is missing");
  }
  const disabledDiff = {
    patch: "",
    bytes: 0,
    includedBytes: 0,
    truncated: false,
    disabled: true
  };
  const [changeSummary, diff] = await Promise.all([
    boundedChangedFileStatsBetween(
      context.pullRequest.baseSha,
      context.pullRequest.headSha,
      config.review.maximumChangedFiles
    ),
    config.review.includeDiffInAgentContext
      ? boundedDiffBetween(
          context.pullRequest.baseSha,
          context.pullRequest.headSha,
          config.review.maximumDiffBytes
        )
      : disabledDiff
  ]);
  context.pullRequest.changedFiles = changeSummary.files.map((file) => file.path);
  context.pullRequest.changeSummary = {
    changedFiles: changeSummary.files.length,
    additions: changeSummary.additions,
    deletions: changeSummary.deletions,
    changedLines: changeSummary.changedLines,
    largestFileChangedLines: changeSummary.largestFileChangedLines
  };
  context.pullRequest.diff = diff;
  context.pullRequest.reasoningEscalation = reviewReasoningEscalation(config, context);
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("review", context, config),
    workspacePrompt: buildReviewPrompt(context, config, agentProfile.text),
    schema: reviewSchema(config),
    agentProfile
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
    repairAuthorizedBy: repairAuthorized ? actor : null
  };
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("audit", context, config),
    workspacePrompt: buildAuditPrompt(context, config, agentProfile.text),
    schema: auditSchema(config),
    agentProfile
  });
  return context;
}

export async function prepareIssue({ eventPath, actor, triageMode, directory, config, token, toolingSha, configSha256, agentProfilePath, agentProfileSourceSha, agentProfileSource }) {
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
  if (!event.issue && event.action === "codekeeper_issue") {
    const number = Number(event.client_payload?.number);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Issue dispatch has no valid issue number");
    event.issue = await github.getIssue(number);
  }
  const issue = event.issue;
  if (!issue || issue.pull_request) throw new Error("Issue payload is missing or refers to a pull request");
  const [existing, pulls, closingPulls] = await Promise.all([
    github.listOpenIssues(config.issues.maximumOpenIssueContext),
    github.listOpenPulls(config.issues.maximumOpenIssueContext),
    config.issues.closeResolvedIssues
      ? github.listMergedPullRequestsClosingIssue(issue.number)
      : Promise.resolve([])
  ]);
  const context = {
    mode: "issue",
    triageMode,
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
    agentProfile: agentProfile.metadata,
    runUrl: runUrl(repository),
    issue: {
      number: issue.number,
      title: boundedText(issue.title, 512, "…"),
      body: boundedText(issue.body, 30000),
      author: boundedText(issue.user?.login, 256, "…"),
      url: boundedText(issue.html_url, 2048, "…"),
      updatedAt: issue.updated_at ?? ""
    },
    resolvedByPullRequest: closingPulls[0] ?? null,
    duplicateCandidates: duplicateCandidates(issue, existing),
    relatedPullRequests: relatedPullRequests(issue, pulls)
  };
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("issue", context, config),
    workspacePrompt: buildIssuePrompt(context, config, agentProfile.text),
    schema: issueSchema(config),
    agentProfile
  });
  return context;
}

export async function prepareFix({ targetNumber, actor, authorizationMode = "owner", expectedHead = "", reviewThreadIds = [], directory, config, token, toolingSha, configSha256, agentProfilePath, agentProfileSourceSha, agentProfileSource }) {
  const agentProfile = await trustedAgentProfile("fix", agentProfilePath, agentProfileSourceSha, agentProfileSource);
  if (!["owner", "policy"].includes(authorizationMode)) {
    throw new Error("Codekeeper fix authorization mode must be owner or policy");
  }
  if (!Array.isArray(reviewThreadIds) || reviewThreadIds.length > 128 || new Set(reviewThreadIds).size !== reviewThreadIds.length
    || reviewThreadIds.some((threadId) => typeof threadId !== "string" || !threadId.trim() || threadId.length > 512)) {
    throw new Error("Codekeeper fix review thread IDs are invalid");
  }
  if (authorizationMode === "owner" && !isConfiguredOwner(config, actor)) {
    throw new Error(`Actor ${actor || "unknown"} is not authorised to request a Codekeeper fix`);
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const github = new GitHubClient({ token, repository });
  const [issue, comments] = await Promise.all([
    github.getIssue(targetNumber),
    github.listIssueComments(targetNumber)
  ]);
  if (issue.number !== targetNumber) throw new Error(`GitHub returned an unexpected target for #${targetNumber}`);
  if (issue.state !== "open") throw new Error(`#${targetNumber} is not open`);
  let target;
  let baseSha;
  let subject;
  if (issue.pull_request) {
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
    if (expectedHead && pull.head?.sha !== expectedHead) {
      throw new Error(`PR #${targetNumber} moved from ${expectedHead} to ${pull.head?.sha}; stale repair will not start`);
    }
    const liveLabels = labelNames(issue.labels);
    if (liveLabels.includes("paused")) throw new Error(`PR #${targetNumber} is paused`);
    if (authorizationMode === "policy") {
      if (!config.review.autoRepair) throw new Error("Automatic review repair is off in the Codekeeper policy");
      if (!expectedHead) throw new Error("Automatic review repair requires its dispatched head SHA");
      const normalizedActor = String(actor ?? "").trim().toLowerCase();
      const marker = automaticRepairMarker(expectedHead);
      const authorized = comments.some((comment) =>
        comment?.user?.type === "Bot" &&
        String(comment?.user?.login ?? "").trim().toLowerCase() === normalizedActor &&
        typeof comment?.body === "string" &&
        comment.body.endsWith(marker)
      );
      if (!authorized) {
        throw new Error("Automatic review repair requires its current-head authorization marker");
      }
    }
    const reviewThreads = reviewThreadIds.length > 0
      ? frozenPullRepairReviewThreads(
        await github.listPullReviewThreads(targetNumber),
        reviewThreadIds
      )
      : [];
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
      reviewThreadIds: [...reviewThreadIds],
      baseSha: pull.base.sha,
      baseRepository: pull.base.repo.full_name
    };
    baseSha = target.headSha;
    const repairEvidencePolicy = {
      authorizationMode,
      actor,
      ownerLogins: [...config.repository.ownerLogins]
    };
    const frozenSubject = frozenPullRepairSubject(pull, comments, reviewThreads, repairEvidencePolicy);
    subject = {
      pullRequest: frozenSubject
    };
    target.subjectSha256 = sha256(JSON.stringify(frozenSubject));
  } else {
    if (authorizationMode === "policy" && !config.issues.allowAiImplementation) {
      throw new Error("AI issue implementation is disabled by issues.allowAiImplementation=false");
    }
    if (reviewThreadIds.length > 0) throw new Error("Issue implementation cannot resolve pull request review threads");
    const liveLabels = labelNames(issue.labels);
    if (authorizationMode === "policy" && liveLabels.includes("paused")) {
      throw new Error(`Issue #${targetNumber} is paused`);
    }
    if (authorizationMode === "policy" && !liveLabels.includes("ready")) {
      throw new Error("Automatic issue implementation requires the ready label");
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
        comments: boundedOwnerComments(comments, config)
      }
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
    target,
    ...subject
  };
  await writeBundle({
    directory,
    context,
    prompt: buildCoordinatorPrompt("fix", context, config),
    workspacePrompt: buildFixPrompt(context, config, agentProfile.text),
    schema: fixSchema(target),
    agentProfile
  });
  return context;
}
