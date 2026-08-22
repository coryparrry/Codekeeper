import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { prepareIssue } from "../src/lib/prepare.mjs";

const sourceSha = "a".repeat(40);

test("manual issue preparation hydrates the mode-plan-bound workflow target", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-manual-issue-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));

  const config = JSON.parse(
    await readFile(
      new URL("../../../.github/codekeeper.json", import.meta.url),
    ),
  );
  config.repository.ownerLogins = ["repository-owner"];
  const eventPath = path.join(directory, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "owner/repository" },
      inputs: { issue_number: "42" },
    }),
  );

  const originals = {
    getIssue: GitHubClient.prototype.getIssue,
    listOpenIssues: GitHubClient.prototype.listOpenIssues,
    listOpenPulls: GitHubClient.prototype.listOpenPulls,
    listMergedPullRequestsClosingIssue:
      GitHubClient.prototype.listMergedPullRequestsClosingIssue,
  };
  GitHubClient.prototype.getIssue = async (number) => ({
    number,
    title: "Manual triage",
    body: "Inspect this issue.",
    html_url: `https://github.com/owner/repository/issues/${number}`,
    user: { login: "reporter" },
    labels: [],
    updated_at: "2026-08-22T00:00:00Z",
  });
  GitHubClient.prototype.listOpenIssues = async () => [];
  GitHubClient.prototype.listOpenPulls = async () => [];
  GitHubClient.prototype.listMergedPullRequestsClosingIssue = async () => [];

  const options = {
    eventPath,
    eventName: "workflow_dispatch",
    targetNumber: 42,
    actor: "repository-owner",
    triageMode: "manual",
    config,
    token: "read-token",
    toolingSha: sourceSha,
    configSha256: "b".repeat(64),
    agentProfileSource: "package",
    agentProfileSourceSha: sourceSha,
  };
  try {
    const prepared = await prepareIssue({
      ...options,
      directory: path.join(directory, "bundle"),
    });
    assert.equal(prepared.issue.number, 42);
    assert.equal(prepared.triageMode, "manual");

    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { full_name: "owner/repository" },
        inputs: { issue_number: "41" },
      }),
    );
    await assert.rejects(
      prepareIssue({
        ...options,
        directory: path.join(directory, "mismatched-bundle"),
      }),
      /no valid bound issue number/,
    );
  } finally {
    for (const [name, implementation] of Object.entries(originals)) {
      GitHubClient.prototype[name] = implementation;
    }
  }
});
