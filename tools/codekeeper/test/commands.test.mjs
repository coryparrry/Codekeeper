import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  authorizeOwnerCommand,
  authorizeOwnerRequest,
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
      "@codekeeper-acme please rerun this",
      "codekeeper-acme[bot]",
    ),
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

test("token-free owner authorization rejects associated users outside policy", () => {
  const event = {
    issue: { number: 42 },
    comment: {
      body: "/codekeeper fix",
      author_association: "COLLABORATOR",
      user: { login: "associated-collaborator" },
    },
  };
  assert.throws(
    () =>
      authorizeOwnerCommand({
        event,
        config: {
          automation: { ownerRequests: true },
          repository: { ownerLogins: ["repository-owner"] },
        },
        automationLogin: "codekeeper[bot]",
      }),
    /not authorised/,
  );
});

test("token-free owner authorization accepts an exact configured-owner command", () => {
  assert.deepEqual(
    authorizeOwnerCommand({
      event: {
        issue: { number: 42 },
        comment: {
          body: "@codekeeper fix",
          author_association: "COLLABORATOR",
          user: { login: "Repository-Owner" },
        },
      },
      config: {
        automation: { ownerRequests: true },
        repository: { ownerLogins: ["repository-owner"] },
      },
      automationLogin: "codekeeper[bot]",
    }),
    {
      actor: "Repository-Owner",
      command: "fix",
      number: 42,
      skipped: false,
    },
  );
});

test("token-free owner authorization does not trust a configured bot login", () => {
  assert.deepEqual(
    authorizeOwnerRequest({
      event: {
        issue: { number: 42 },
        comment: {
          body: "@unverified-login fix",
          author_association: "OWNER",
          user: { login: "repository-owner" },
        },
      },
      config: {
        automation: { ownerRequests: true },
        repository: { ownerLogins: ["repository-owner"] },
      },
    }),
    {
      actor: "repository-owner",
      command: "fix",
      number: 42,
      skipped: false,
    },
  );
  assert.equal(
    authorizeOwnerCommand({
      event: {
        issue: { number: 42 },
        comment: {
          body: "@unverified-login fix",
          author_association: "OWNER",
          user: { login: "repository-owner" },
        },
      },
      config: {
        automation: { ownerRequests: true },
        repository: { ownerLogins: ["repository-owner"] },
      },
      automationLogin: "real-codekeeper[bot]",
    }).skipped,
    true,
  );
});

test("ordinary collaborator comments are ignored without touching GitHub", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-command-ignore-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "This implementation looks ready to merge.",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originalGetIssue = GitHubClient.prototype.getIssue;
  GitHubClient.prototype.getIssue = async () => {
    throw new Error("ordinary comments must not call GitHub");
  };
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
    GitHubClient.prototype.getIssue = originalGetIssue;
    await rm(directory, { recursive: true, force: true });
  }
});

test("commands fail before dispatch when their workflow is not installed", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-command-mode-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "/codekeeper implement",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    createRepositoryDispatch: GitHubClient.prototype.createRepositoryDispatch,
  };
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    labels: [],
  });
  GitHubClient.prototype.createRepositoryDispatch = async () => {
    throw new Error("an unavailable workflow must not be dispatched");
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
        installedModes: ["review", "maintain"],
      }),
      /requires the Fixer workflow/,
    );
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});

test("defer requires the Issues workflow before reading review evidence", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-defer-mode-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        id: 99,
        body: "/codekeeper defer",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    getReviewComment: GitHubClient.prototype.getReviewComment,
  };
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    pull_request: {},
    labels: [],
  });
  GitHubClient.prototype.getReviewComment = async () => {
    throw new Error("review evidence must not be read without Issue triage");
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
        installedModes: ["review", "maintain"],
      }),
      /\/defer requires the Issue triage workflow/,
    );
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});

test("documentation advertises the exact supported mention grammar", async () => {
  const readme = await readFile(
    new URL("../../../README.md", import.meta.url),
    "utf8",
  );
  assert.match(readme, /`@<app-slug> review`/);
  assert.match(
    readme,
    /free-form requests such as `@<app-slug> please review this` are ignored/,
  );
  assert.doesNotMatch(readme, /same fixed actions in natural language/);
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
    labels: [{ name: "codekeeper:paused" }],
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

test("an owner fix rejects an ordinary issue before changing its state", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-fix-issue-command-"),
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
  };
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    labels: [],
  });
  GitHubClient.prototype.removeLabel = async () => {
    throw new Error("ordinary issue state must not change");
  };
  GitHubClient.prototype.getPull = async () => {
    throw new Error("ordinary issue must not be read as a pull request");
  };
  GitHubClient.prototype.createRepositoryDispatch = async () => {
    throw new Error("ordinary issue repair must not be dispatched");
  };
  try {
    await assert.rejects(
      runOwnerCommand({
        eventPath,
        config: { repository: { ownerLogins: ["repository-owner"] } },
        token: "app-token",
        automationIdentity: { login: "codekeeper[bot]", id: "123" },
      }),
      /\/codekeeper fix requires a pull request/,
    );
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

test("owner stop confirms ambiguous auto-merge disablement without accepting deterministic errors", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-stop-command-"),
  );
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      issue: { number: 42 },
      comment: {
        body: "/codekeeper stop",
        author_association: "OWNER",
        user: { login: "repository-owner" },
      },
    }),
  );
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    ensureLabels: GitHubClient.prototype.ensureLabels,
    addLabels: GitHubClient.prototype.addLabels,
    removeLabel: GitHubClient.prototype.removeLabel,
    getPull: GitHubClient.prototype.getPull,
    disableAutoMerge: GitHubClient.prototype.disableAutoMerge,
    upsertMarkerComment: GitHubClient.prototype.upsertMarkerComment,
  };
  let ambiguous = true;
  let pullReads = 0;
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    pull_request: {},
    labels: [],
  });
  GitHubClient.prototype.ensureLabels = async () => {};
  GitHubClient.prototype.addLabels = async () => {};
  GitHubClient.prototype.removeLabel = async () => {};
  GitHubClient.prototype.getPull = async () => {
    pullReads += 1;
    return pullReads === 1
      ? { number: 42, node_id: "PR_42", auto_merge: { enabled_at: "now" } }
      : { number: 42, node_id: "PR_42", auto_merge: null };
  };
  GitHubClient.prototype.disableAutoMerge = async () => {
    const error = new Error(ambiguous ? "response lost" : "not permitted");
    if (ambiguous) error.githubMutationOutcome = "ambiguous";
    throw error;
  };
  GitHubClient.prototype.upsertMarkerComment = async () => {};
  try {
    const options = {
      eventPath,
      config: {
        automation: { ownerRequests: true },
        repository: { ownerLogins: ["repository-owner"] },
        labels: {},
      },
      token: "app-token",
      automationIdentity: { login: "codekeeper[bot]", id: "123" },
    };
    const result = await runOwnerCommand(options);
    assert.equal(result.command, "stop");
    assert.equal(pullReads, 2);

    ambiguous = false;
    pullReads = 0;
    await assert.rejects(runOwnerCommand(options), /not permitted/);
    assert.equal(pullReads, 1);
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});
