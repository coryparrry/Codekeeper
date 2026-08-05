import path from "node:path";
import { mkdir } from "node:fs/promises";
import { boundedChangedFilesBetween, boundedDiffBetween, currentHead } from "./git.mjs";
import { GitHubClient } from "./github.mjs";
import { readJson, writeJson, writeText } from "./io.mjs";
import { auditSchema, fixSchema, issueSchema, reviewSchema } from "./schemas.mjs";
import { buildAuditPrompt, buildFixPrompt, buildIssuePrompt, buildReviewPrompt } from "./prompts.mjs";
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

function ensureSameRepositoryPullRequest(event, repository) {
  const pull = event.pull_request;
  if (!pull) throw new Error("Pull request payload is missing");
  if (pull.head?.repo?.full_name !== repository) {
    throw new Error("Fork pull requests are not eligible for AI maintainer automation");
  }
  if (pull.draft) throw new Error("Draft pull requests are not eligible for automatic review");
  return pull;
}

async function writeBundle({ directory, context, prompt, schema }) {
  assertRunnerOwnedDirectory(directory);
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Runner-owned bundle directory already exists: ${directory}`);
    throw error;
  }
  await writeJson(path.join(directory, "context.json"), context);
  await writeText(path.join(directory, "prompt.md"), `${prompt}\n`);
  await writeJson(path.join(directory, "schema.json"), schema);
}

function runMetadata({ toolingSha = process.env.AI_MAINTAINER_TOOLING_SHA ?? "", configSha256 = "" } = {}) {
  return {
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    toolingSha: String(toolingSha).trim(),
    configSha256: String(configSha256).trim()
  };
}

export async function prepareReview({ eventPath, directory, config, toolingSha, configSha256 }) {
  const event = await readJson(eventPath);
  const repository = repositoryFromEvent(event);
  const pull = ensureSameRepositoryPullRequest(event, repository);
  const context = {
    mode: "review",
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
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
    prompt: buildReviewPrompt(context, config),
    schema: reviewSchema(config)
  });
  return context;
}

export async function prepareAudit({ directory, config, toolingSha, configSha256 }) {
  const repository = process.env.GITHUB_REPOSITORY;
  const context = {
    mode: "audit",
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
    runUrl: runUrl(repository),
    baseSha: currentHead(),
    defaultBranch: config.repository.defaultBranch
  };
  await writeBundle({
    directory,
    context,
    prompt: buildAuditPrompt(context, config),
    schema: auditSchema(config)
  });
  return context;
}

export async function prepareIssue({ eventPath, actor, triageMode, directory, config, token, toolingSha, configSha256 }) {
  if (triageMode !== "automatic" && triageMode !== "manual") {
    throw new Error("Issue triage mode must be automatic or manual");
  }
  if (triageMode === "manual" && !config.repository.ownerLogins.includes(actor)) {
    throw new Error(`Actor ${actor || "unknown"} is not authorised to request AI maintainer issue triage`);
  }
  const event = await readJson(eventPath);
  const repository = repositoryFromEvent(event);
  const issue = event.issue;
  if (!issue || issue.pull_request) throw new Error("Issue payload is missing or refers to a pull request");
  const github = new GitHubClient({ token, repository });
  const existing = await github.listOpenIssues(config.issues.maximumOpenIssueContext);
  const context = {
    mode: "issue",
    triageMode,
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
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
      }))
  };
  await writeBundle({
    directory,
    context,
    prompt: buildIssuePrompt(context, config),
    schema: issueSchema(config)
  });
  return context;
}

export async function prepareFix({ issueNumber, actor, directory, config, token, toolingSha, configSha256 }) {
  if (!config.issues.allowAiImplementation) {
    throw new Error("AI issue implementation is disabled by issues.allowAiImplementation=false");
  }
  if (!config.repository.ownerLogins.includes(actor)) {
    throw new Error(`Actor ${actor || "unknown"} is not authorised to request an AI maintainer fix`);
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const github = new GitHubClient({ token, repository });
  const issue = await github.getIssue(issueNumber);
  if (issue.pull_request) throw new Error(`#${issueNumber} is a pull request, not an issue`);
  if (issue.state !== "open") throw new Error(`#${issueNumber} is not open`);
  const comments = await github.listIssueComments(issueNumber);
  const context = {
    mode: "fix",
    repository,
    ...runMetadata({ toolingSha, configSha256 }),
    runUrl: runUrl(repository),
    baseSha: currentHead(),
    defaultBranch: config.repository.defaultBranch,
    requestedBy: actor,
    issue: {
      number: issue.number,
      title: boundedText(issue.title, 512, "…"),
      body: boundedText(issue.body, 30000),
      author: boundedText(issue.user?.login, 256, "…"),
      url: boundedText(issue.html_url, 2048, "…"),
      updatedAt: issue.updated_at ?? "",
      labels: boundedLabels(issue.labels),
      comments: comments.slice(-20).map((comment) => ({
        author: boundedText(comment.user?.login, 256, "…"),
        body: boundedText(comment.body, 12000),
        createdAt: comment.created_at ?? ""
      }))
    }
  };
  await writeBundle({
    directory,
    context,
    prompt: buildFixPrompt(context, config),
    schema: fixSchema()
  });
  return context;
}
