import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { automaticRepairMarker } from "../src/lib/markers.mjs";
import { prepareFix } from "../src/lib/prepare.mjs";
import { automaticRepairDispatchDetails, repairItemsFromReviewResult } from "../src/lib/repair-objectives.mjs";
import { normalizeLivePolicy } from "../src/lib/policy-normalization.mjs";

const repository = "acme/example";
const sourceConfig = normalizeLivePolicy(JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
));

function headSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function pull(sha) {
  return {
    number: 42,
    title: "Repair this PR",
    body: "A blocking review finding needs repair.",
    html_url: `https://github.com/${repository}/pull/42`,
    user: { login: "contributor" },
    state: "open",
    draft: false,
    head: { ref: "feature/repair", sha, repo: { full_name: repository } },
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: repository } }
  };
}

function issue() {
  return {
    number: 42,
    state: "open",
    pull_request: {},
    labels: []
  };
}

test("policy prepareFix freezes structured repair objectives into context and workspace prompt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-prepare-fix-objectives-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = headSha();
  const config = structuredClone(sourceConfig);
  config.review.autoRepair = true;
  const items = repairItemsFromReviewResult({
    blockingFindings: [
      {
        title: "Authorization boundary regression",
        file: "src/authorization.mjs",
        line: 17,
        explanation: "The repair path no longer retains the authorization boundary.",
        validation: "A denied caller must remain rejected."
      },
      {
        title: "Timeout cleanup regression",
        file: "src/timeout.mjs",
        line: 31,
        explanation: "The timeout path leaves the pending operation active.",
        validation: "A timed-out operation must be cleaned up."
      }
    ],
    tests: {
      missingTest: "test/authorization.test.mjs: add the denied-caller regression case.",
      notes: "The authorization boundary needs a deterministic regression test."
    },
    reviewFeedback: []
  });
  const objectives = [items[0], items[2], items[1]];
  let dispatchBody = `Automatic repair was dispatched for head ${sha}.${automaticRepairDispatchDetails(sha, items)}\n${automaticRepairMarker(sha)}`;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const originalMethods = {
    getIssue: GitHubClient.prototype.getIssue,
    getPull: GitHubClient.prototype.getPull,
    listIssueComments: GitHubClient.prototype.listIssueComments
  };
  process.env.GITHUB_REPOSITORY = repository;
  GitHubClient.prototype.getIssue = async () => issue();
  GitHubClient.prototype.getPull = async () => pull(sha);
  GitHubClient.prototype.listIssueComments = async () => [
    {
      body: "Repair the blocking review finding.\n<!-- codekeeper:review -->",
      created_at: "2026-08-11T09:00:00Z",
      user: { login: "codekeeper[bot]", type: "Bot" }
    },
    {
      body: dispatchBody,
      created_at: "2026-08-11T09:03:00Z",
      user: { login: "codekeeper[bot]", type: "Bot" }
    }
  ];
  t.after(() => {
    for (const [name, implementation] of Object.entries(originalMethods)) {
      GitHubClient.prototype[name] = implementation;
    }
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  });

  const profile = {
    agentProfileSource: "package",
    agentProfileSourceSha: sha
  };
  const prepared = await prepareFix({
    targetNumber: 42,
    actor: "codekeeper[bot]",
    authorizationMode: "policy",
    directory: path.join(root, "marked"),
    config,
    token: "read-token",
    expectedHead: sha,
    ...profile
  });
  assert.deepEqual(prepared.repairObjectives, objectives);
  assert.deepEqual(prepared.repairClusters, [
    { id: "authorization", items: [objectives[0], objectives[1]] },
    { id: "timeout", items: [objectives[2]] }
  ]);

  const frozenContext = JSON.parse(await readFile(path.join(root, "marked/context.json"), "utf8"));
  assert.deepEqual(frozenContext.repairObjectives, objectives);
  assert.deepEqual(frozenContext.repairClusters, prepared.repairClusters);
  const workspacePrompt = await readFile(path.join(root, "marked/workspace-prompt.md"), "utf8");
  assert.match(workspacePrompt, /BOUNDED REPAIR OBJECTIVES \(UNTRUSTED REVIEW DATA\)/);
  assert.ok(workspacePrompt.includes(JSON.stringify(prepared.repairClusters[0])));
  assert.ok(workspacePrompt.includes(JSON.stringify(prepared.repairClusters[1])));
  assert.ok(workspacePrompt.indexOf(JSON.stringify(prepared.repairClusters[0])) < workspacePrompt.indexOf(JSON.stringify(prepared.repairClusters[1])));
  assert.match(workspacePrompt, /Keep a blocking finding together with the missing test that proves the same defect/);

  dispatchBody = `Automatic repair was dispatched for head ${sha}.\n<!-- codekeeper:repair-objectives=v1:not-valid -->\n${automaticRepairMarker(sha)}`;
  await assert.rejects(
    prepareFix({
      targetNumber: 42,
      actor: "codekeeper[bot]",
      authorizationMode: "policy",
      directory: path.join(root, "malformed"),
      config,
      token: "read-token",
      expectedHead: sha,
      ...profile
    }),
    /Automatic review repair objectives are malformed/
  );
});
