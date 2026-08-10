import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { AGENT_PROFILE_BUNDLE_FILE, loadTrustedAgentProfile } from "./agent-profiles.mjs";
import { boundedChangedFilesBetween, boundedDiffBetween, currentHead } from "./git.mjs";
import { GitHubClient } from "./github.mjs";
import { readJson, writeJson, writeText } from "./io.mjs";
import { frozenPullRepairSubject, frozenPullRepairSubjectSha256 } from "./pr-repair.mjs";
import { auditSchema, fixSchema, issueSchema, planSchema, providerCompatibleJsonSchema, reviewSchema, validatePlanResult } from "./schemas.mjs";
import { buildAuditPrompt, buildFixPrompt, buildIssuePrompt, buildPlanPrompt, buildReviewPrompt } from "./prompts.mjs";
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

function isConfiguredOwner(config, actor) {
  const normalizedActor = String(actor ?? "").trim().toLowerCase();
  return normalizedActor.length > 0 && (config.repository.ownerLogins ?? [])
    .some((owner) => String(owner).trim().toLowerCase() === normalizedActor);
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

async function writeBundle({ directory, context, prompt, schema, agentProfile }) {
  assertRunnerOwnedDirectory(directory);
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Runner-owned bundle directory already exists: ${directory}`);
    throw error;
  }
  await writeFile(path.join(directory, AGENT_PROFILE_BUNDLE_FILE), agentProfile.bytes, { flag: "wx" });
  await writeJson(path.join(directory, "context.json"), context);
  await writeText(path.join(directory, "prompt.md"), `${prompt}\n`);
  await writeJson(path.join(directory, "schema.json"), providerCompatibleJsonSchema(schema));
}

function trustedAgentProfile(mode, agentProfilePath, agentProfileSourceSha) {
  return loadTrustedAgentProfile({
    mode,
    sourcePath: agentProfilePath,
    sourceSha: agentProfileSourceSha
  });
}

function runMetadata({ toolingSha = process.env.CODEKEEPER_TOOLING_SHA ?? "", configSha256 = "" } = {}) {
  return {
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    toolingSha: String(toolingSha).trim(),
    configSha256: String(configSha256).trim()
  };
}

function frozenFixTarget(context) {
  return {
    repository: context.repository,
    baseSha: context.baseSha,
    defaultBranch: context.defaultBranch,
    target: context.target,
    issue: context.issue ?? null,
    pullRequest: context.pullRequest ?? null
  };
}

function assertPlanTargetUnchanged(planContext, currentContext) {
  if (planContext?.mode !== "plan") throw new Error("Fix preparation requires a planner context");
  if (JSON.stringify(frozenFixTarget(planContext)) !== JSON.stringify(frozenFixTarget(currentContext))) {
    throw new Error(`Target #${currentContext.target.number} changed after planning; stale plan will not continue`);
  }
}

export async function prepareReview({ eventPath, directory, config, token, toolingSha, configSha256, agentProfilePath, agentProfileSourceSha }) {
  const agentProfile = await trustedAgentProfile("review", agentProfilePath, agentProfileSourceSha);
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
      headSha: pull.head?.sha
    }
  };
  if (!context.pullRequest.baseSha || !context.pullRequest.headSha) {
    throw new Error("Pull request base/head SHA is missing");
  }
  context.pullRequest.changedFiles = await boundedChangedFilesBetween(
    context.pullRequest.baseSha,
    context.pullRequest.headSha,
    config.review.maximumChangedFiles
  );
  if (config.review.includeDiffInAgentContext) {
    context.pullRequest.diff = await boundedDiffBetween(
      context.pullRequest.baseSha,
      context.pullRequest.headSha,
      config.review.maximumDiffBytes
    );
  } else {
    context.pullRequest.diff = {
      patch: "",
      bytes: 0,
      includedBytes: 0,
      truncated: false,
      disabled: true
    };
  }
  await writeBundle({
    directory,
    context,
    prompt: buildReviewPrompt(context, config, agentProfile.text),
    schema: reviewSchema(config),
    agentProfile
  });
  return context;
}

export async function prepareAudit({ directory, config, toolingSha, configSha256, actor, repairAuthorized = false, agentProfilePath, agentProfileSourceSha }) {
  if (typeof repairAuthorized !== "boolean") throw new Error("Maintenance repair authorization must be a boolean");
  if (repairAuthorized && !config.audit.repair.enabled) {
    throw new Error("Maintenance repair was authorized while audit.repair.enabled=false");
  }
  const agentProfile = await trustedAgentProfile("audit", agentProfilePath, agentProfileSourceSha);
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
    prompt: buildAuditPrompt(context, config, agentProfile.text),
    schema: auditSchema(config),
    agentProfile
  });
  return context;
}

export async function prepareIssue({ eventPath, actor, triageMode, directory, config, token, toolingSha, configSha256, agentProfilePath, agentProfileSourceSha }) {
  const agentProfile = await trustedAgentProfile("issue", agentProfilePath, agentProfileSourceSha);
  if (triageMode !== "automatic" && triageMode !== "manual") {
    throw new Error("Issue triage mode must be automatic or manual");
  }
  if (triageMode === "manual" && !isConfiguredOwner(config, actor)) {
    throw new Error(`Actor ${actor || "unknown"} is not authorised to request Codekeeper issue triage`);
  }
  const event = await readJson(eventPath);
  const repository = repositoryFromEvent(event);
  const issue = event.issue;
  if (!issue || issue.pull_request) throw new Error("Issue payload is missing or refers to a pull request");
  const github = new GitHubClient({ token, repository });
  const [existing, pulls] = await Promise.all([
    github.listOpenIssues(config.issues.maximumOpenIssueContext),
    github.listOpenPulls(config.issues.maximumOpenIssueContext)
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
    existingOpenIssues: existing
      .filter((candidate) => candidate.number !== issue.number)
      .map((candidate) => ({
        number: candidate.number,
        title: boundedText(candidate.title, 512, "…"),
        labels: boundedLabels(candidate.labels)
      })),
    existingOpenPullRequests: pulls.map((pull) => ({
      number: pull.number,
      title: boundedText(pull.title, 512, "…"),
      body: boundedText(pull.body, 4000),
      labels: boundedLabels(pull.labels),
      url: boundedText(pull.html_url, 2048, "…")
    }))
  };
  await writeBundle({
    directory,
    context,
    prompt: buildIssuePrompt(context, config, agentProfile.text),
    schema: issueSchema(config),
    agentProfile
  });
  return context;
}

export async function prepareFix({ targetNumber, actor, authorizationMode = "owner", expectedHead = "", directory, config, token, toolingSha, configSha256, agentProfilePath, agentProfileSourceSha, mode = "fix", planResultPath = undefined, planContextPath = undefined }) {
  if (!["plan", "fix"].includes(mode)) throw new Error("Codekeeper implementation role must be plan or fix");
  const agentProfile = await trustedAgentProfile(mode, agentProfilePath, agentProfileSourceSha);
  if (!["owner", "policy"].includes(authorizationMode)) {
    throw new Error("Codekeeper fix authorization mode must be owner or policy");
  }
  if (authorizationMode === "owner" && !isConfiguredOwner(config, actor)) {
    throw new Error(`Actor ${actor || "unknown"} is not authorised to request a Codekeeper fix`);
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const github = new GitHubClient({ token, repository });
  const issue = await github.getIssue(targetNumber);
  if (issue.number !== targetNumber) throw new Error(`GitHub returned an unexpected target for #${targetNumber}`);
  if (issue.state !== "open") throw new Error(`#${targetNumber} is not open`);
  const comments = await github.listIssueComments(targetNumber);
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
    const labels = boundedLabels(issue.labels);
    if (labels.includes("codekeeper:paused")) throw new Error(`PR #${targetNumber} is paused`);
    if (authorizationMode === "policy") {
      if (!config.review.autoRepair) throw new Error("Automatic review repair is off in the Codekeeper policy");
      if (!labels.includes("codekeeper:auto-repaired")) {
        throw new Error("Automatic review repair requires the codekeeper:auto-repaired marker");
      }
    }
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
      baseSha: pull.base.sha,
      baseRepository: pull.base.repo.full_name
    };
    baseSha = target.headSha;
    subject = {
      pullRequest: frozenPullRepairSubject(pull, comments)
    };
    target.subjectSha256 = frozenPullRepairSubjectSha256(pull, comments);
  } else {
    if (!config.issues.allowAiImplementation) {
      throw new Error("AI issue implementation is disabled by issues.allowAiImplementation=false");
    }
    const labels = boundedLabels(issue.labels);
    if (authorizationMode === "policy" && labels.includes("codekeeper:paused")) {
      throw new Error(`Issue #${targetNumber} is paused`);
    }
    if (authorizationMode === "policy" && !labels.includes("codekeeper:ready")) {
      throw new Error("Automatic issue implementation requires the codekeeper:ready label");
    }
    target = { kind: "issue", number: targetNumber };
    baseSha = currentHead();
    subject = {
      issue: {
        number: issue.number,
        title: boundedText(issue.title, 512, "…"),
        body: boundedText(issue.body, 30000),
        author: boundedText(issue.user?.login, 256, "…"),
        url: boundedText(issue.html_url, 2048, "…"),
        updatedAt: issue.updated_at ?? "",
        labels,
        comments: comments.slice(-20).map((comment) => ({
          author: boundedText(comment.user?.login, 256, "…"),
          body: boundedText(comment.body, 12000),
          createdAt: comment.created_at ?? ""
        }))
      }
    };
  }
  const context = {
    mode,
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
  if (mode === "fix") {
    assertPlanTargetUnchanged(await readJson(planContextPath), context);
    context.plan = validatePlanResult(await readJson(planResultPath), target);
    if (!context.plan.readyForFixer) {
      throw new Error("Planner did not approve the requested fix");
    }
  }
  await writeBundle({
    directory,
    context,
    prompt: mode === "plan" ? buildPlanPrompt(context, config, agentProfile.text) : buildFixPrompt(context, config, agentProfile.text),
    schema: mode === "plan" ? planSchema(target) : fixSchema(target),
    agentProfile
  });
  return context;
}

export function preparePlan(options) {
  return prepareFix({ ...options, mode: "plan" });
}
