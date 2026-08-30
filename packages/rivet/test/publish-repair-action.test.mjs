import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  inspectRepairPatch,
  normalizeRepairPatch,
  parseRepairRequest,
  runPublishRepairAction,
} from "../assets/repair/.github/rivet/actions/publish-repair/index.mjs";

const event = {
  repository: { full_name: "owner/repository" },
  issue: {
    number: 12,
    pull_request: { url: "https://api.github.com/pulls/12" },
  },
  comment: {
    id: 34,
    body: "/rivet-repair",
    author_association: "OWNER",
    created_at: "2026-08-27T12:00:00Z",
    user: { login: "owner" },
  },
};

test("binds one repair patch to the owner command", () => {
  const request = parseRepairRequest({
    event,
    agentOutput: { items: [{ type: "publish_repair", patch: "patch" }] },
    outputType: "publish_repair",
  });
  assert.equal(request.repository, "owner/repository");
  assert.equal(request.pullRequest, 12);
  assert.equal(request.authorization.commentId, 34);
  assert.equal(request.patch, "patch");
});

test("rejects ambiguous or unauthorized repair requests", () => {
  assert.throws(
    () =>
      parseRepairRequest({
        event: {
          ...event,
          comment: { ...event.comment, author_association: "NONE" },
        },
        agentOutput: { items: [{ type: "publish_repair", patch: "patch" }] },
        outputType: "publish_repair",
      }),
    /invalid repair authorization/,
  );
  assert.throws(
    () =>
      parseRepairRequest({
        event,
        agentOutput: {
          items: [
            { type: "publish_repair", patch: "one" },
            { type: "publish_repair", patch: "two" },
          ],
        },
        outputType: "publish_repair",
      }),
    /exactly one repair patch/,
  );
});

test("accepts a bounded existing-file patch", () => {
  const patch = [
    "diff --git a/src/discount.mjs b/src/discount.mjs",
    "index 1234567..89abcde 100644",
    "--- a/src/discount.mjs",
    "+++ b/src/discount.mjs",
    "@@ -1 +1 @@",
    "-export const valid = false;",
    "+export const valid = true;",
    "",
  ].join("\n");
  assert.deepEqual(inspectRepairPatch(patch), ["src/discount.mjs"]);
  assert.equal(normalizeRepairPatch(patch.slice(0, -1)), patch);
});

test("rejects protected, renamed, binary, and oversized patches", () => {
  assert.throws(
    () =>
      inspectRepairPatch(
        "diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml\n",
      ),
    /protected path/,
  );
  assert.throws(
    () => inspectRepairPatch("diff --git a/old.mjs b/new.mjs\n"),
    /renamed/,
  );
  assert.throws(
    () => inspectRepairPatch("diff --git a/a.png b/a.png\nGIT binary patch\n"),
    /binary/,
  );
  assert.throws(
    () => inspectRepairPatch(`diff --git a/a b/a\n${"x".repeat(1024 * 1024)}`),
    /oversized/,
  );
});

test("publishes only an exact-head validated artifact", async () => {
  const patch = [
    "diff --git a/src/discount.mjs b/src/discount.mjs",
    "index 1234567..89abcde 100644",
    "--- a/src/discount.mjs",
    "+++ b/src/discount.mjs",
    "@@ -1 +1 @@",
    "-export const valid = false;",
    "+export const valid = true;",
    "",
  ].join("\n");
  const reviewedHead = "a".repeat(40);
  const repairedHead = "b".repeat(40);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const responses = [
    { slug: "rivet-test" },
    { id: 7 },
    { token: "installation-token" },
    { id: 1234 },
    {
      head: {
        sha: reviewedHead,
        ref: "repair-branch",
        repo: { full_name: "owner/repository" },
      },
    },
    [
      {
        id: 99,
        body: "Blocking finding",
        commit_id: reviewedHead,
        submitted_at: "2026-08-27T11:59:00Z",
        user: { login: "rivet-test[bot]" },
      },
    ],
    [{ id: 101, path: "src/discount.mjs", line: 1, body: "Fix the bound" }],
    { head: { sha: reviewedHead, ref: "repair-branch" } },
  ];
  const calls = [];
  const validationReceipt = {
    schemaVersion: 1,
    repository: "owner/repository",
    pullRequest: 12,
    authorization: {
      actor: "owner",
      commentId: 34,
      createdAt: "2026-08-27T12:00:00Z",
    },
    headSha: reviewedHead,
    headRef: "repair-branch",
    changedPaths: ["src/discount.mjs"],
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    validation: [{ command: "npm test", exitCode: 0 }],
  };
  const receipt = await runPublishRepairAction({
    env: {
      GITHUB_EVENT_PATH: "/event.json",
      GH_AW_AGENT_OUTPUT: "/output.json",
      GITHUB_WORKSPACE: "/workspace",
      RUNNER_TEMP: "/runner",
      GITHUB_OUTPUT: "/github-output",
      RIVET_REPAIR_ARTIFACT: "/artifact",
      RIVET_APP_CLIENT_ID: "Iv123456789012345678",
      RIVET_APP_PRIVATE_KEY: privateKey,
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => responses.shift(),
    }),
    readFileImpl: async (filePath) => {
      if (filePath === "/event.json") return JSON.stringify(event);
      if (filePath === "/output.json") {
        return JSON.stringify({
          items: [
            {
              type: "publish_repair",
              confirmation: "publish-validated-repair",
            },
          ],
        });
      }
      if (filePath.endsWith("patch.diff")) return patch;
      return JSON.stringify(validationReceipt);
    },
    writeFileImpl: async () => {},
    appendFileImpl: async () => {},
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "diff") return "src/discount.mjs\0";
      if (args[0] === "rev-parse") return repairedHead;
      return "";
    },
  });
  const pushIndex = calls.findIndex(([, first]) => first === "push");
  assert.ok(pushIndex >= 0);
  assert.equal(
    calls.some(([command]) => command === "/bin/sh"),
    false,
  );
  assert.deepEqual(calls[pushIndex].slice(0, 3), [
    "git",
    "push",
    `--force-with-lease=refs/heads/repair-branch:${reviewedHead}`,
  ]);
  assert.equal(receipt.review.headSha, reviewedHead);
  assert.equal(receipt.authorization.commentId, 34);
  assert.equal(receipt.repair.commitSha, repairedHead);
  assert.deepEqual(receipt.repair.validation, [
    { command: "npm test", exitCode: 0 },
  ]);
});
