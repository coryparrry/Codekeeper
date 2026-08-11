import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOwnerCommand } from "../src/lib/commands.mjs";
import { GitHubClient } from "../src/lib/github.mjs";

const ownerConfig = {
  automation: { ownerRequests: true },
  repository: { ownerLogins: ["repository-owner"], defaultBranch: "main" },
  labels: {}
};
const identity = { login: "codekeeper[bot]", id: "123" };

async function eventFile(t, body) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-command-hardening-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "event.json");
  await writeFile(filePath, JSON.stringify({
    repository: { full_name: "owner/repository" },
    issue: { number: 42 },
    comment: {
      body,
      author_association: "OWNER",
      user: { login: "repository-owner" }
    }
  }));
  return filePath;
}

function patchGitHub(methods) {
  const originals = Object.fromEntries(Object.keys(methods).map((name) => [name, GitHubClient.prototype[name]]));
  Object.assign(GitHubClient.prototype, methods);
  return () => Object.assign(GitHubClient.prototype, originals);
}

test("failed owner repair dispatch does not leave a target unpaused", async (t) => {
  const eventPath = await eventFile(t, "/codekeeper fix");
  const labels = new Set(["codekeeper:paused"]);
  const restore = patchGitHub({
    async getIssue() { return { number: 42, state: "open", labels: [...labels], pull_request: {} }; },
    async removeLabel(_number, label) { labels.delete(label); },
    async addLabels(_number, labelsToAdd) { labelsToAdd.forEach((label) => labels.add(label)); },
    async getPull() { return { head: { sha: "a".repeat(40) } }; },
    async createRepositoryDispatch() { throw new Error("dispatch unavailable"); }
  });
  t.after(restore);
  await assert.rejects(
    runOwnerCommand({ eventPath, config: ownerConfig, token: "audit-token", automationIdentity: identity }),
    /dispatch unavailable/
  );
  assert.equal(labels.has("codekeeper:paused"), true, "dispatch failure removed the only pause guard");
});

test("owner PR triage rejects a draft or retargeted pull request before dispatch", async (t) => {
  const eventPath = await eventFile(t, "/codekeeper triage");
  let dispatches = 0;
  const restore = patchGitHub({
    async getIssue() { return { number: 42, state: "open", labels: [], pull_request: {} }; },
    async getPull() {
      return {
        draft: true,
        head: { sha: "a".repeat(40), repo: { full_name: "owner/repository" } },
        base: { sha: "b".repeat(40), ref: "release", repo: { full_name: "owner/repository" } }
      };
    },
    async createRepositoryDispatch() { dispatches += 1; },
    async upsertMarkerComment() {}
  });
  t.after(restore);
  let error;
  try {
    await runOwnerCommand({ eventPath, config: ownerConfig, token: "audit-token", automationIdentity: identity });
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual({ dispatches, error: error?.message }, {
    dispatches: 0,
    error: "PR #42 is not eligible for Codekeeper review"
  });
});
