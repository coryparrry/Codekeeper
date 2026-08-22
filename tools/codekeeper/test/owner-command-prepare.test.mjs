import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { sha256 } from "../src/lib/markers.mjs";
import {
  prepareFix,
  prepareIssue,
  prepareReview,
} from "../src/lib/prepare.mjs";

const repository = "owner/repository";
const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const baseSha = headSha;
const config = JSON.parse(
  await readFile(
    new URL("../../../.github/codekeeper.json", import.meta.url),
    "utf8",
  ),
);
config.repository.ownerLogins = ["repository-owner"];
config.automation.automaticPrReview = false;
config.automation.reviewFeedbackTriage = false;
config.automation.issueTriage = false;

function profile() {
  return { agentProfileSource: "package", agentProfileSourceSha: headSha };
}

function issueComment(body, id = 701) {
  return {
    id,
    body,
    issue_url: `https://api.github.com/repos/${repository}/issues/7`,
    created_at: "2026-08-22T10:00:00Z",
    updated_at: "2026-08-22T10:00:00Z",
    author_association: "OWNER",
    user: { login: "repository-owner", id: "12", type: "User" },
  };
}

function reviewComment(body, id = 702) {
  return {
    id,
    body,
    pull_request_url: `https://api.github.com/repos/${repository}/pulls/7`,
    created_at: "2026-08-22T10:00:00Z",
    updated_at: "2026-08-22T10:00:00Z",
    author_association: "OWNER",
    user: { login: "repository-owner", id: "12", type: "User" },
    path: "src/index.mjs",
    line: 12,
  };
}

function pull() {
  return {
    number: 7,
    title: "Owner command target",
    body: "",
    html_url: `https://github.com/${repository}/pull/7`,
    state: "open",
    draft: false,
    labels: [],
    user: { login: "contributor" },
    head: { ref: "feature", sha: headSha, repo: { full_name: repository } },
    base: { ref: "main", sha: baseSha, repo: { full_name: repository } },
  };
}

function issue({ pullRequest = false } = {}) {
  return {
    number: 7,
    title: "Owner command issue",
    body: "The issue body.",
    html_url: `https://github.com/${repository}/issues/7`,
    state: "open",
    labels: [],
    user: { login: "reporter" },
    ...(pullRequest
      ? {
          pull_request: {
            url: `https://api.github.com/repos/${repository}/pulls/7`,
          },
        }
      : {}),
  };
}

async function eventFile(t, event) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-prepare-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, "event.json");
  await writeFile(eventPath, JSON.stringify(event));
  return { directory, eventPath };
}

function installGithubFixture(
  t,
  { liveComment, targetIssue, targetPull, threads = [], reviews = [] },
) {
  const methods = {
    getIssueComment: GitHubClient.prototype.getIssueComment,
    getReviewComment: GitHubClient.prototype.getReviewComment,
    getIssue: GitHubClient.prototype.getIssue,
    getPull: GitHubClient.prototype.getPull,
    listIssueComments: GitHubClient.prototype.listIssueComments,
    listPullReviewThreads: GitHubClient.prototype.listPullReviewThreads,
    listPullReviews: GitHubClient.prototype.listPullReviews,
    listOpenIssues: GitHubClient.prototype.listOpenIssues,
    listOpenPulls: GitHubClient.prototype.listOpenPulls,
    listMergedPullRequestsClosingIssue:
      GitHubClient.prototype.listMergedPullRequestsClosingIssue,
  };
  GitHubClient.prototype.getIssueComment = async () => liveComment;
  GitHubClient.prototype.getReviewComment = async () => liveComment;
  GitHubClient.prototype.getIssue = async () => targetIssue;
  GitHubClient.prototype.getPull = async () => targetPull;
  GitHubClient.prototype.listIssueComments = async () => [];
  GitHubClient.prototype.listPullReviewThreads = async () => threads;
  GitHubClient.prototype.listPullReviews = async () => reviews;
  GitHubClient.prototype.listOpenIssues = async () => [];
  GitHubClient.prototype.listOpenPulls = async () => [];
  GitHubClient.prototype.listMergedPullRequestsClosingIssue = async () => [];
  t.after(() => {
    for (const [name, implementation] of Object.entries(methods))
      GitHubClient.prototype[name] = implementation;
  });
}

function ownerContext(command, surface, comment) {
  return {
    command,
    surface,
    actor: "repository-owner",
    targetNumber: 7,
    originalComment: comment,
  };
}

function closedOwnerContext(command, surface, comment) {
  return {
    schemaVersion: 1,
    eventName: "issue_comment",
    repository,
    actor: "repository-owner",
    association: "OWNER",
    command,
    canonicalCommand: command === "triage" ? "review" : command,
    surface,
    targetNumber: 7,
    commentId: comment.id,
    commentSha256: sha256(comment.body),
    executionKind: "mode",
  };
}

test("direct owner review hydrates and binds a live PR while bypassing automatic-review policy", async (t) => {
  const comment = reviewComment("/codekeeper review");
  const { directory, eventPath } = await eventFile(t, {
    action: "created",
    repository: { full_name: repository },
    issue: {
      number: 7,
      pull_request: {
        url: `https://api.github.com/repos/${repository}/pulls/7`,
      },
    },
    comment,
  });
  installGithubFixture(t, {
    liveComment: comment,
    targetIssue: issue({ pullRequest: true }),
    targetPull: pull(),
  });
  const prepared = await prepareReview({
    eventPath,
    directory: path.join(directory, "bundle"),
    config,
    token: "read-token",
    toolingSha: headSha,
    ownerCommandContext: closedOwnerContext("review", "review-thread", comment),
    ...profile(),
  });
  assert.equal(prepared.pullRequest.number, 7);
  assert.equal(prepared.pullRequest.headSha, headSha);
  assert.equal(prepared.pullRequest.reviewFeedbackFrozen, false);
  assert.equal(prepared.ownerCommandContext.schemaVersion, 1);
  assert.equal(
    prepared.ownerCommandContext.commentSha256,
    sha256(comment.body),
  );
});

test("direct owner review-feedback triage freezes the complete live feedback surface", async (t) => {
  const comment = reviewComment("/codekeeper triage");
  const feedbackComment = {
    databaseId: 703,
    body: "Please cover this case.",
    url: `https://github.com/${repository}/pull/7#discussion_r703`,
    path: "src/index.mjs",
    line: 12,
    author: { login: "reviewer" },
  };
  const { directory, eventPath } = await eventFile(t, {
    action: "created",
    repository: { full_name: repository },
    issue: {
      number: 7,
      pull_request: {
        url: `https://api.github.com/repos/${repository}/pulls/7`,
      },
    },
    comment,
  });
  installGithubFixture(t, {
    liveComment: comment,
    targetIssue: issue({ pullRequest: true }),
    targetPull: pull(),
    threads: [
      {
        id: "PRRT_owner",
        isResolved: false,
        isOutdated: false,
        comments: { nodes: [feedbackComment] },
      },
    ],
    reviews: [
      {
        id: 704,
        state: "CHANGES_REQUESTED",
        submitted_at: "2026-08-22T09:00:00Z",
        body: "Review body",
        user: { login: "reviewer" },
      },
    ],
  });
  const prepared = await prepareReview({
    eventPath,
    directory: path.join(directory, "bundle"),
    config,
    token: "read-token",
    toolingSha: headSha,
    ownerCommandContext: ownerContext("triage", "review-thread", comment),
    ...profile(),
  });
  assert.equal(prepared.pullRequest.reviewFeedbackFrozen, true);
  assert.ok(
    prepared.pullRequest.reviewFeedback.some(
      (item) => item.sourceKey === "review:704",
    ),
  );
  assert.ok(
    prepared.pullRequest.reviewFeedback.some(
      (item) => item.sourceKey === "review_comment:703",
    ),
  );
});

test("direct owner issue triage uses the original command without continuation validation", async (t) => {
  const comment = issueComment("/codekeeper triage");
  const { directory, eventPath } = await eventFile(t, {
    action: "created",
    repository: { full_name: repository },
    issue: { number: 7 },
    comment,
  });
  installGithubFixture(t, {
    liveComment: comment,
    targetIssue: issue(),
    targetPull: null,
  });
  const prepared = await prepareIssue({
    eventPath,
    actor: "repository-owner",
    triageMode: "manual",
    directory: path.join(directory, "bundle"),
    config,
    token: "read-token",
    toolingSha: headSha,
    ownerCommandContext: ownerContext("triage", "issue", comment),
    ...profile(),
  });
  assert.equal(prepared.issue.number, 7);
  assert.equal(prepared.issue.conversation, null);
  assert.equal(prepared.issue.previousTriage, null);
  assert.equal(prepared.ownerCommandContext.command, "triage");
});

test("direct owner issue triage rejects a closed live issue", async (t) => {
  const comment = issueComment("/codekeeper triage");
  const { directory, eventPath } = await eventFile(t, {
    action: "created",
    repository: { full_name: repository },
    issue: { number: 7 },
    comment,
  });
  installGithubFixture(t, {
    liveComment: comment,
    targetIssue: { ...issue(), state: "closed" },
    targetPull: null,
  });
  await assert.rejects(
    prepareIssue({
      eventPath,
      actor: "repository-owner",
      triageMode: "manual",
      directory: path.join(directory, "bundle"),
      config,
      token: "read-token",
      toolingSha: headSha,
      ownerCommandContext: ownerContext("triage", "issue", comment),
      ...profile(),
    }),
    /#7 is not open/,
  );
});

test("direct owner implementation and review-thread repair bind their live targets", async (t) => {
  const implementationComment = issueComment("/codekeeper implement");
  const implementationFixture = await eventFile(t, {
    action: "created",
    repository: { full_name: repository },
    issue: { number: 7 },
    comment: implementationComment,
  });
  const originalRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = repository;
  installGithubFixture(t, {
    liveComment: implementationComment,
    targetIssue: issue(),
    targetPull: null,
  });
  try {
    const implementation = await prepareFix({
      eventPath: implementationFixture.eventPath,
      targetNumber: 7,
      actor: "repository-owner",
      authorizationMode: "owner",
      directory: path.join(implementationFixture.directory, "bundle"),
      config,
      token: "read-token",
      toolingSha: headSha,
      ownerCommandContext: ownerContext(
        "implement",
        "issue",
        implementationComment,
      ),
      ...profile(),
    });
    assert.equal(implementation.target.kind, "issue");

    const repairComment = reviewComment("/codekeeper repair");
    const repairFixture = await eventFile(t, {
      action: "created",
      repository: { full_name: repository },
      issue: {
        number: 7,
        pull_request: {
          url: `https://api.github.com/repos/${repository}/pulls/7`,
        },
      },
      comment: repairComment,
    });
    const thread = {
      id: "PRRT_repair",
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            databaseId: repairComment.id,
            body: repairComment.body,
            author: { login: "repository-owner" },
            url: "https://example.invalid/comment",
            path: "src/index.mjs",
            line: 12,
          },
        ],
      },
    };
    installGithubFixture(t, {
      liveComment: repairComment,
      targetIssue: { ...issue({ pullRequest: true }), labels: ["codekeeper:paused"] },
      targetPull: pull(),
      threads: [thread],
    });
    const repair = await prepareFix({
      eventPath: repairFixture.eventPath,
      targetNumber: 7,
      actor: "repository-owner",
      authorizationMode: "owner",
      directory: path.join(repairFixture.directory, "bundle"),
      config,
      token: "read-token",
      toolingSha: headSha,
      ownerCommandContext: ownerContext(
        "repair",
        "review-thread",
        repairComment,
      ),
      ...profile(),
    });
    assert.deepEqual(repair.target.reviewThreadIds, ["PRRT_repair"]);
    assert.equal(repair.ownerCommandContext.commentId, "702");
  } finally {
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  }
});
