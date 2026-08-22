import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOwnerCommandContext,
  runDeterministicOwnerCommand,
  resolveOwnerCommandContext,
} from "../src/lib/commands.mjs";
import { GitHubClient } from "../src/lib/github.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const cliPath = path.join(repositoryRoot, "tools/codekeeper/src/cli.mjs");
const repositoryConfigPath = path.join(
  repositoryRoot,
  ".github/codekeeper.json",
);

function commandConfig() {
  return {
    automation: { ownerRequests: true },
    repository: {
      ownerLogins: ["repository-owner"],
      defaultBranch: "main",
    },
    labels: {},
  };
}

function commandEvent({ body = "/codekeeper status", ...overrides } = {}) {
  return {
    repository: { full_name: "owner/repository" },
    issue: { number: 42 },
    comment: {
      id: 9001,
      body,
      author_association: "OWNER",
      user: { login: "repository-owner" },
    },
    ...overrides,
  };
}

test("owner-command context is closed, immutable, and binds the original request", () => {
  const context = resolveOwnerCommandContext({
    event: commandEvent({ body: "/codekeeper implement" }),
    config: commandConfig(),
    automationLogin: "codekeeper-acme[bot]",
    eventName: "issue_comment",
  });
  assert.deepEqual(Object.keys(context), [
    "schemaVersion",
    "eventName",
    "repository",
    "actor",
    "association",
    "command",
    "canonicalCommand",
    "surface",
    "targetNumber",
    "commentId",
    "commentSha256",
    "executionKind",
  ]);
  assert.equal(Object.isFrozen(context), true);
  assert.deepEqual(
    {
      schemaVersion: context.schemaVersion,
      eventName: context.eventName,
      repository: context.repository,
      actor: context.actor,
      association: context.association,
      command: context.command,
      canonicalCommand: context.canonicalCommand,
      surface: context.surface,
      targetNumber: context.targetNumber,
      commentId: context.commentId,
      executionKind: context.executionKind,
    },
    {
      schemaVersion: 1,
      eventName: "issue_comment",
      repository: "owner/repository",
      actor: "repository-owner",
      association: "OWNER",
      command: "implement",
      canonicalCommand: "implement",
      surface: "issue",
      targetNumber: 42,
      commentId: 9001,
      executionKind: "mode",
    },
  );
  assert.match(context.commentSha256, /^[a-f0-9]{64}$/);
  assert.equal(assertOwnerCommandContext(context), context);
});

test("owner-command context rejects bot authors, invalid surfaces, and missing comment targets", () => {
  assert.throws(
    () =>
      resolveOwnerCommandContext({
        event: commandEvent({
          body: "/codekeeper status",
          comment: {
            id: 9001,
            body: "/codekeeper status",
            author_association: "OWNER",
            user: { login: "codekeeper-acme[bot]" },
          },
        }),
        config: {
          ...commandConfig(),
          repository: {
            ...commandConfig().repository,
            ownerLogins: ["codekeeper-acme[bot]"],
          },
        },
        automationLogin: "codekeeper-acme[bot]",
      }),
    /automation bot cannot issue/,
  );
  assert.throws(
    () =>
      resolveOwnerCommandContext({
        event: commandEvent({ body: "/codekeeper repair" }),
        config: commandConfig(),
        automationLogin: "codekeeper-acme[bot]",
      }),
    /not available on this issue/,
  );
  assert.throws(
    () =>
      resolveOwnerCommandContext({
        event: commandEvent({
          comment: {
            id: 0,
            body: "/codekeeper status",
            author_association: "OWNER",
            user: { login: "repository-owner" },
          },
        }),
        config: commandConfig(),
        automationLogin: "codekeeper-acme[bot]",
      }),
    /comment ID must be a positive integer/,
  );
});

test("deterministic owner execution refuses mode commands before GitHub access", async () => {
  const originalGetIssue = GitHubClient.prototype.getIssue;
  GitHubClient.prototype.getIssue = async () => {
    throw new Error("mode commands must not access GitHub in direct execution");
  };
  try {
    await assert.rejects(
      runDeterministicOwnerCommand({
        event: commandEvent({ body: "/codekeeper review" }),
        config: commandConfig(),
        token: "app-token",
        automationIdentity: { login: "codekeeper-acme[bot]", id: "1" },
      }),
      /refuses mode command/,
    );
  } finally {
    GitHubClient.prototype.getIssue = originalGetIssue;
  }
});

test("deterministic owner execution reauthorizes and performs pause without dispatch", async () => {
  const calls = [];
  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    ensureLabels: GitHubClient.prototype.ensureLabels,
    addLabels: GitHubClient.prototype.addLabels,
    removeLabel: GitHubClient.prototype.removeLabel,
    upsertMarkerComment: GitHubClient.prototype.upsertMarkerComment,
    createRepositoryDispatch: GitHubClient.prototype.createRepositoryDispatch,
  };
  GitHubClient.prototype.getIssue = async (number) => ({
    number,
    state: "open",
    labels: [],
    pull_request: null,
  });
  GitHubClient.prototype.ensureLabels = async () => calls.push("ensure-labels");
  GitHubClient.prototype.addLabels = async () => calls.push("add-paused");
  GitHubClient.prototype.removeLabel = async () => calls.push("remove-ready");
  GitHubClient.prototype.upsertMarkerComment = async () => calls.push("status");
  GitHubClient.prototype.createRepositoryDispatch = async () => {
    throw new Error("deterministic commands must not dispatch");
  };
  try {
    const result = await runDeterministicOwnerCommand({
      event: commandEvent({ body: "/codekeeper pause" }),
      config: commandConfig(),
      token: "app-token",
      automationIdentity: { login: "codekeeper-acme[bot]", id: "1" },
    });
    assert.deepEqual(result, {
      number: 42,
      command: "pause",
      outcome:
        "Automatic implementation, repair, and merge are paused for this item.",
    });
    assert.deepEqual(calls, [
      "ensure-labels",
      "add-paused",
      "remove-ready",
      "status",
    ]);
  } finally {
    Object.assign(GitHubClient.prototype, originals);
  }
});

test("the CLI owner-command-context stage writes the closed context", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-owner-context-cli-"),
  );
  try {
    const eventPath = path.join(directory, "event.json");
    const configPath = path.join(directory, "config.json");
    const resultPath = path.join(directory, "context.json");
    const config = JSON.parse(await readFile(repositoryConfigPath, "utf8"));
    config.repository.ownerLogins = ["repository-owner"];
    config.automation.ownerRequests = true;
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(
      eventPath,
      JSON.stringify(commandEvent({ body: "/codekeeper status" })),
    );
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn(
        "node",
        [
          cliPath,
          "stage",
          "compute",
          "--operation",
          "owner-command-context",
          "--event",
          eventPath,
          "--config",
          configPath,
          "--automation-bot-login",
          "codekeeper-acme[bot]",
          "--result",
          resultPath,
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, GITHUB_EVENT_NAME: "issue_comment" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(outcome.code, 0, outcome.stderr);
    const context = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(context.executionKind, "deterministic");
    assert.equal(context.eventName, "issue_comment");
    assert.equal(context.repository, "owner/repository");
    assert.equal(Object.keys(context).length, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
