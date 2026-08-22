import assert from "node:assert/strict";
import test from "node:test";
import { resumeDirectOwnerFix } from "../src/lib/publish/owner-command.mjs";

function context({ kind = "issue", command = "implement" } = {}) {
  return {
    authorizationMode: "owner",
    target: { kind, number: 42 },
    issue: { number: 42, updatedAt: "2026-08-22T05:00:00Z" },
    ownerCommandContext: {
      executionKind: "mode",
      canonicalCommand: command,
    },
  };
}

test("direct owner implementation resumes a sealed paused issue", async () => {
  const calls = [];
  let paused = true;
  let updatedAt = "2026-08-22T05:00:00Z";
  const github = {
    async getIssue(number) {
      calls.push(["get", number]);
      return {
        number,
        updated_at: updatedAt,
        labels: paused ? [{ name: "codekeeper:paused" }] : [],
      };
    },
    async removeLabel(number, label) {
      calls.push(["remove", number, label]);
      paused = false;
      updatedAt = "2026-08-22T05:01:00Z";
    },
  };
  const resumed = await resumeDirectOwnerFix(github, context());
  assert.equal(resumed.updated_at, "2026-08-22T05:01:00Z");
  assert.deepEqual(calls, [
    ["get", 42],
    ["remove", 42, "codekeeper:paused"],
    ["get", 42],
  ]);
});

test("direct owner implementation refuses stale issue state before resuming", async () => {
  let removed = false;
  const github = {
    async getIssue(number) {
      return {
        number,
        updated_at: "2026-08-22T05:02:00Z",
        labels: [{ name: "codekeeper:paused" }],
      };
    },
    async removeLabel() {
      removed = true;
    },
  };
  await assert.rejects(
    resumeDirectOwnerFix(github, context()),
    /changed after implementation started/,
  );
  assert.equal(removed, false);
});

test("ambiguous pause removal is restored before failing", async () => {
  let paused = true;
  let additions = 0;
  const github = {
    async getIssue(number) {
      return {
        number,
        updated_at: "2026-08-22T05:00:00Z",
        labels: paused ? [{ name: "codekeeper:paused" }] : [],
      };
    },
    async removeLabel() {
      paused = false;
      const error = new Error("pause removal response was lost");
      error.githubMutationOutcome = "ambiguous";
      throw error;
    },
    async addLabels(number, labels) {
      assert.equal(number, 42);
      assert.deepEqual(labels, ["codekeeper:paused"]);
      additions += 1;
      paused = true;
    },
  };
  await assert.rejects(
    resumeDirectOwnerFix(github, context()),
    /pause removal response was lost/,
  );
  assert.equal(additions, 1);
  assert.equal(paused, true);
});

test("direct owner repair resumes its PR only after trusted publication", async () => {
  let removed = false;
  const github = {
    async getIssue(number) {
      return {
        number,
        state: "open",
        labels: removed ? [] : ["codekeeper:paused"],
      };
    },
    async removeLabel(number, label) {
      assert.equal(number, 42);
      assert.equal(label, "codekeeper:paused");
      removed = true;
    },
  };
  const resumed = await resumeDirectOwnerFix(
    github,
    context({ kind: "pull_request", command: "repair" }),
  );
  assert.deepEqual(resumed.labels, []);
  assert.equal(removed, true);
});

test("automatic and legacy dispatch fixes never resume through the direct path", async () => {
  let reads = 0;
  const github = {
    async getIssue() {
      reads += 1;
    },
  };
  assert.equal(
    await resumeDirectOwnerFix(github, {
      ...context(),
      authorizationMode: "policy",
    }),
    null,
  );
  const legacy = context();
  delete legacy.ownerCommandContext;
  assert.equal(await resumeDirectOwnerFix(github, legacy), null);
  assert.equal(reads, 0);
});
