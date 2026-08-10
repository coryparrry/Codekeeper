import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOwnerCommand, parseCommand } from "../src/lib/commands.mjs";
import { GitHubClient } from "../src/lib/github.mjs";

test("owner commands require an exact supported command", () => {
  assert.equal(parseCommand("/codekeeper status"), "status");
  assert.equal(parseCommand(" /CODEKEEPER rerun "), "rerun");
  assert.equal(parseCommand("/codekeeper fix"), "fix");
  assert.equal(parseCommand("/codekeeper stop now"), null);
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
    upsertMarkerComment: GitHubClient.prototype.upsertMarkerComment,
  };
  const removed = [];
  GitHubClient.prototype.getIssue = async () => ({
    number: 42,
    state: "open",
    pull_request: {},
    labels: [],
  });
  GitHubClient.prototype.removeLabel = async (number, label) => {
    removed.push({ number, label });
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
  } finally {
    Object.assign(GitHubClient.prototype, originals);
    await rm(directory, { recursive: true, force: true });
  }
});
