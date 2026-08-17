import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOwnerCommand } from "../src/lib/commands.mjs";
import { GitHubClient } from "../src/lib/github.mjs";
import { prepareFix, prepareIssue } from "../src/lib/prepare.mjs";

const sourceSha = "a".repeat(40);
const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url)),
);
config.repository.ownerLogins = ["repository-owner"];
config.automation.ownerRequests = true;

function packagedProfile() {
  return {
    agentProfileSource: "package",
    agentProfileSourceSha: sourceSha,
  };
}

for (const command of ["triage", "implement"]) {
  test(`${command} worker preparation authenticates the pre-dispatch receipt without a later target mutation`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), `codekeeper-${command}-dispatch-prepare-`),
    );
    const commandEventPath = path.join(directory, "command-event.json");
    const dispatchEventPath = path.join(directory, "dispatch-event.json");
    const workerDirectory = path.join(directory, "worker-bundle");
    await writeFile(
      commandEventPath,
      JSON.stringify({
        repository: { full_name: "owner/repository" },
        issue: { number: 42 },
        comment: {
          id: 700,
          body: `/codekeeper ${command}`,
          author_association: "OWNER",
          user: { login: "repository-owner" },
        },
      }),
    );

    const originals = {
      getIssue: GitHubClient.prototype.getIssue,
      listIssueComments: GitHubClient.prototype.listIssueComments,
      listOpenIssues: GitHubClient.prototype.listOpenIssues,
      listOpenPulls: GitHubClient.prototype.listOpenPulls,
      listMergedPullRequestsClosingIssue:
        GitHubClient.prototype.listMergedPullRequestsClosingIssue,
      upsertMarkerComment: GitHubClient.prototype.upsertMarkerComment,
      createRepositoryDispatch: GitHubClient.prototype.createRepositoryDispatch,
      request: GitHubClient.prototype.request,
    };
    const previousRepository = process.env.GITHUB_REPOSITORY;
    const previousBotLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    process.env.GITHUB_REPOSITORY = "owner/repository";
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = "codekeeper[bot]";

    let receipt = null;
    let targetVersion = 0;
    let workerSnapshot;
    let prepared;
    GitHubClient.prototype.getIssue = async () => ({
      number: 42,
      title: "Dispatch race",
      body: "Prepare only after the immutable receipt exists.",
      html_url: "https://github.com/owner/repository/issues/42",
      user: { login: "reporter" },
      state: "open",
      labels: [],
      comments: receipt ? 1 : 0,
      updated_at: `2026-08-17T10:00:0${targetVersion}Z`,
    });
    GitHubClient.prototype.listIssueComments = async () =>
      receipt ? [structuredClone(receipt)] : [];
    GitHubClient.prototype.listOpenIssues = async () => [];
    GitHubClient.prototype.listOpenPulls = async () => [];
    GitHubClient.prototype.listMergedPullRequestsClosingIssue = async () => [];
    GitHubClient.prototype.upsertMarkerComment = async (
      number,
      marker,
      body,
    ) => {
      assert.equal(number, 42);
      targetVersion += 1;
      receipt = {
        id: 701,
        issue_url: "https://api.github.com/repos/owner/repository/issues/42",
        body: `${body}\n${marker}`,
        created_at: "2026-08-17T10:00:01Z",
        updated_at: "2026-08-17T10:00:01Z",
        user: { login: "codekeeper[bot]", id: 123, type: "Bot" },
      };
      return structuredClone(receipt);
    };
    GitHubClient.prototype.request = async (method, url) => {
      assert.equal(method, "GET");
      assert.match(url, /\/issues\/comments\/701$/);
      return { data: structuredClone(receipt) };
    };
    GitHubClient.prototype.createRepositoryDispatch = async (
      eventType,
      payload,
    ) => {
      workerSnapshot = targetVersion;
      const dispatchEvent = {
        action: eventType,
        repository: { full_name: "owner/repository" },
        client_payload: payload,
        sender: { login: "codekeeper[bot]", id: 123, type: "Bot" },
      };
      await writeFile(dispatchEventPath, JSON.stringify(dispatchEvent));
      const prepareWorker = (bundleDirectory) =>
        command === "triage"
          ? prepareIssue({
              eventPath: dispatchEventPath,
              actor: "repository-owner",
              triageMode: "manual",
              directory: bundleDirectory,
              config,
              token: "read-token",
              toolingSha: sourceSha,
              ...packagedProfile(),
            })
          : prepareFix({
              eventPath: dispatchEventPath,
              targetNumber: 42,
              actor: "repository-owner",
              authorizationMode: "owner",
              directory: bundleDirectory,
              config,
              token: "read-token",
              toolingSha: sourceSha,
              ...packagedProfile(),
            });
      prepared = await prepareWorker(workerDirectory);

      if (command === "triage") {
        const exactReceipt = structuredClone(receipt);
        receipt.body = `${receipt.body}\nchanged after dispatch`;
        await assert.rejects(
          prepareWorker(path.join(directory, "tampered-body")),
          /exact immutable App receipt/,
        );
        receipt = structuredClone(exactReceipt);
        receipt.user.id = 999;
        await assert.rejects(
          prepareWorker(path.join(directory, "wrong-author")),
          /exact immutable App receipt/,
        );
        receipt = exactReceipt;
        dispatchEvent.client_payload = {
          ...payload,
          command_comment_id: 999,
        };
        await writeFile(dispatchEventPath, JSON.stringify(dispatchEvent));
        await assert.rejects(
          prepareWorker(path.join(directory, "wrong-command-comment")),
          /receipt identity is invalid/,
        );
      }
    };

    try {
      await runOwnerCommand({
        eventPath: commandEventPath,
        config,
        token: "app-token",
        automationIdentity: { login: "codekeeper[bot]", id: "123" },
      });
      assert.equal(targetVersion, workerSnapshot);
      assert.equal(prepared.ownerCommandDispatch.command, command);
      assert.equal(prepared.ownerCommandDispatch.commandCommentId, "700");
      assert.equal(prepared.ownerCommandDispatch.receiptCommentId, "701");
      assert.match(prepared.ownerCommandDispatch.requestId, /^[a-f0-9]{64}$/);
      assert.match(
        prepared.ownerCommandDispatch.receiptSha256,
        /^[a-f0-9]{64}$/,
      );
      assert.deepEqual(prepared.ownerCommandDispatch.receiptAuthor, {
        login: "codekeeper[bot]",
        id: "123",
      });
      assert.deepEqual(
        JSON.parse(await readFile(path.join(workerDirectory, "context.json"))),
        prepared,
      );
    } finally {
      Object.assign(GitHubClient.prototype, originals);
      if (previousRepository === undefined)
        delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = previousRepository;
      if (previousBotLogin === undefined) {
        delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
      } else {
        process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousBotLogin;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
