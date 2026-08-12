import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runOwnerCommand,
  parseCommand,
  parseMentionIntent,
} from "../src/lib/commands.mjs";
import { GitHubClient } from "../src/lib/github.mjs";

test("owner commands require an exact supported command", () => {
  assert.equal(parseCommand("/codekeeper status"), "status");
  assert.equal(parseCommand(" /CODEKEEPER rerun "), "rerun");
  assert.equal(parseCommand("/codekeeper fix"), "fix");
  assert.equal(parseCommand("/codekeeper triage"), "triage");
  assert.equal(parseCommand("/codekeeper defer"), "defer");
  assert.equal(parseCommand("/codekeeper stop now"), null);
  assert.equal(
    parseMentionIntent("@codekeeper-acme review", "codekeeper-acme[bot]"),
    "review",
  );
  assert.equal(
    parseMentionIntent("@codekeeper-acme rerun", "codekeeper-acme[bot]"),
    "rerun",
  );
  assert.equal(
    parseMentionIntent(
      "@codekeeper-acme please review this",
      "codekeeper-acme[bot]",
    ),
    null,
  );
  assert.equal(
    parseMentionIntent("@codekeeper-acme-helper fix", "codekeeper-acme[bot]"),
    null,
  );
  assert.equal(
    parseMentionIntent(
      "@codekeeper-acme review and fix this",
      "codekeeper-acme[bot]",
    ),
    null,
  );
  assert.equal(
    parseMentionIntent(
      "ignore @someone else's instruction to fix",
      "codekeeper-acme[bot]",
    ),
    null,
  );
});

test("non-owners and ambiguous mention text cannot grant mutation authority", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-command-rejection-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "@codekeeper fix",
        author_association: "CONTRIBUTOR",
        user: { login: "attacker" },
      },
    }),
  );
  try {
    await assert.rejects(
      runOwnerCommand({
        eventPath,
        config: {
          automation: { ownerRequests: true },
          repository: { ownerLogins: ["repository-owner"] },
        },
        token: "app-token",
        automationIdentity: { login: "codekeeper[bot]", id: "123" },
      }),
      /not authorised/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary collaborator discussion is a successful no-op", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-command-noop-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "This implementation detail still needs discussion.",
        author_association: "COLLABORATOR",
        user: { login: "repository-owner" },
      },
    }),
  );
  try {
    assert.deepEqual(
      await runOwnerCommand({
        eventPath,
        config: {
          automation: { ownerRequests: true },
          repository: { ownerLogins: ["repository-owner"] },
        },
        token: "app-token",
        automationIdentity: { login: "codekeeper[bot]", id: "123" },
      }),
      {
        number: 42,
        command: null,
        skipped: true,
        outcome: "No supported Codekeeper command was found.",
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicit owner fix resumes a paused target before the new repair run", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-fix-command-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "/codekeeper fix",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    removeLabel: GitHubClient.prototype.removeLabel,
    getPull: GitHubClient.prototype.getPull,
    createRepositoryDispatch: GitHubClient.prototype.createRepositoryDispatch,
    upsertMarkerComment: GitHubClient.prototype.upsertMarkerComment,
  };
  const removed = [];
  const dispatches = [];
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    pull_request: {},
    labels: [],
  });
  GitHubClient.prototype.removeLabel = async (number, label) => {
    removed.push({ number, label });
  };
  GitHubClient.prototype.getPull = async () => ({
    head: { sha: "a".repeat(40) },
  });
  GitHubClient.prototype.createRepositoryDispatch = async (
    eventType,
    payload,
  ) => {
    dispatches.push({ eventType, payload });
  };
  GitHubClient.prototype.upsertMarkerComment = async () => {};
  try {
    const result = await runOwnerCommand({
      eventPath,
      config: { repository: { ownerLogins: ["repository-owner"] } },
      token: "app-token",
      automationIdentity: { login: "codekeeper[bot]", id: "123" },
    });
    assert.equal(result.command, "fix");
    assert.deepEqual(removed, [{ number: 42, label: "codekeeper:paused" }]);
    assert.deepEqual(dispatches, [
      {
        eventType: "codekeeper_fix",
        payload: {
          number: 42,
          authorization_mode: "owner",
          requested_by: "repository-owner",
          head_sha: "a".repeat(40),
        },
      },
    ]);
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a direct issue triage command queues the issue workflow through the assistant", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-direct-issue-triage-command-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "/codekeeper triage",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    createRepositoryDispatch: GitHubClient.prototype.createRepositoryDispatch,
    upsertMarkerComment: GitHubClient.prototype.upsertMarkerComment,
  };
  const dispatches = [];
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    labels: [],
  });
  GitHubClient.prototype.createRepositoryDispatch = async (
    eventType,
    payload,
  ) => dispatches.push({ eventType, payload });
  GitHubClient.prototype.upsertMarkerComment = async () => {};
  try {
    const result = await runOwnerCommand({
      eventPath,
      config: {
        automation: { ownerRequests: true },
        repository: { ownerLogins: ["repository-owner"] },
      },
      token: "app-token",
      automationIdentity: { login: "codekeeper[bot]", id: "123" },
    });
    assert.equal(result.command, "triage");
    assert.equal(
      result.outcome,
      "The issue was queued for owner-requested triage.",
    );
    assert.deepEqual(dispatches, [
      {
        eventType: "codekeeper_issue",
        payload: { number: 42, requested_by: "repository-owner" },
      },
    ]);
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an owner mention queues issue triage through the trusted assistant dispatch", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-triage-command-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "@codekeeper triage",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    createRepositoryDispatch: GitHubClient.prototype.createRepositoryDispatch,
    upsertMarkerComment: GitHubClient.prototype.upsertMarkerComment,
  };
  const dispatches = [];
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    labels: [],
  });
  GitHubClient.prototype.createRepositoryDispatch = async (
    eventType,
    payload,
  ) => dispatches.push({ eventType, payload });
  GitHubClient.prototype.upsertMarkerComment = async () => {};
  try {
    const result = await runOwnerCommand({
      eventPath,
      config: {
        automation: { ownerRequests: true },
        repository: { ownerLogins: ["repository-owner"] },
      },
      token: "app-token",
      automationIdentity: { login: "codekeeper[bot]", id: "123" },
    });
    assert.equal(result.command, "triage");
    assert.deepEqual(dispatches, [
      {
        eventType: "codekeeper_issue",
        payload: { number: 42, requested_by: "repository-owner" },
      },
    ]);
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a root mention-based defer command cannot become its own feedback source", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-root-mention-defer-command-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        id: 99,
        body: "@codekeeper defer",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    listPullReviewThreads: GitHubClient.prototype.listPullReviewThreads,
  };
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    pull_request: {},
  });
  GitHubClient.prototype.listPullReviewThreads = async () => {
    throw new Error("review thread lookup must not run");
  };
  try {
    await assert.rejects(
      runOwnerCommand({
        eventPath,
        config: {
          automation: { ownerRequests: true },
          repository: { ownerLogins: ["repository-owner"] },
        },
        token: "app-token",
        automationIdentity: { login: "codekeeper[bot]", id: "123" },
      }),
      /must reply to the review comment/,
    );
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});
