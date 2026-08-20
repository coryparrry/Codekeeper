import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixWorkflow = await readFile(new URL("../../../.github/workflows/codekeeper-fix.yml", import.meta.url), "utf8");
const publishSource = await readFile(new URL("../src/lib/publish.mjs", import.meta.url), "utf8");
const reviewPublishSource = await readFile(new URL("../src/lib/publish/review.mjs", import.meta.url), "utf8");
const repairSource = await readFile(new URL("../src/lib/pr-repair.mjs", import.meta.url), "utf8");
const githubSource = await readFile(new URL("../src/lib/github/mutation-guard.mjs", import.meta.url), "utf8");
const pullsSource = await readFile(new URL("../src/lib/github/pulls.mjs", import.meta.url), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

function assertContains(source, pattern, message) {
  assert.equal(pattern.test(source), true, message);
}

test("workspace and analyze resolve repository-dispatch repair targets identically", () => {
  const workspace = section(fixWorkflow, "  workspace:", "\n  analyze:");
  const analyze = section(fixWorkflow, "  analyze:", "\n  seal:");
  assertContains(workspace, /github\.event\.client_payload\.number/u, "workspace omits repository-dispatch issue number");
  assertContains(analyze, /github\.event\.client_payload\.number/u, "analyze omits repository-dispatch issue number");
});

test("automatic review repair dispatch carries policy authorization", () => {
  const dispatchBlock = section(publishSource, "  if (automaticRepair.eligible) {", "\nexport async function publishReview");
  assertContains(dispatchBlock, /authorization_mode:\s*["']policy["']/u, "automatic repair omits policy authorization");
  assertContains(dispatchBlock, /requested_by:/u, "automatic repair omits requester provenance");
});

test("conditional PR repair mutation retains the one-shot authorization boundary", () => {
  const beginRepair = section(githubSource, "  async beginPullRepairMutation", "\n  async beginBranchMutation");
  const assertCurrent = section(githubSource, "  async assertPullMutationCurrent", "\n  advancePullMutationState");
  assertContains(beginRepair, /repairEvidencePolicy/u, "repair mutation omits frozen policy authorization state");
  assertContains(assertCurrent, /automaticRepairMarker\(expected\.headSha\)/u, "repair mutation omits the current-head authorization marker");
  assertContains(repairSource, /beginPullRepairMutation/u, "PR repair does not enter the conditional mutation seam");
});

test("conditional review mutation rejects draft and paused pull requests", () => {
  const assertCurrent = section(githubSource, "  async assertPullMutationCurrent", "\n  advancePullMutationState");
  const assertIdentity = section(pullsSource, "  assertPullMutationIdentity", "\n  async getPull");
  assertContains(assertIdentity, /pull\.draft/u, "conditional review mutation omits draft state");
  assertContains(assertCurrent, /paused/u, "conditional review mutation omits the paused label");
  assertContains(reviewPublishSource, /beginPullMutation/u, "review publication does not enter the conditional mutation seam");
});
