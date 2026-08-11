import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixWorkflow = await readFile(new URL("../../../.github/workflows/codekeeper-fix.yml", import.meta.url), "utf8");
const publishSource = await readFile(new URL("../src/lib/publish.mjs", import.meta.url), "utf8");
const repairSource = await readFile(new URL("../src/lib/pr-repair.mjs", import.meta.url), "utf8");

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
  const dispatchBlock = section(publishSource, "  if (automaticRepair.eligible) {", "\n  return {");
  assertContains(dispatchBlock, /authorization_mode:\s*["']policy["']/u, "automatic repair omits policy authorization");
  assertContains(dispatchBlock, /requested_by:/u, "automatic repair omits requester provenance");
});

test("live PR repair revalidation retains the one-shot authorization boundary", () => {
  const currentFrozenPull = section(repairSource, "async function currentFrozenPull", "\nasync function exactPatch");
  assertContains(currentFrozenPull, /codekeeper:auto-repaired/u, "live repair revalidation omits the automatic-repair marker");
});

test("live review publication rejects a PR that became draft after preparation", () => {
  const currentReviewPull = section(publishSource, "async function currentReviewPull", "\nasync function disableFailedAutoMergePostcondition");
  assertContains(currentReviewPull, /pull\.draft/u, "live review revalidation omits draft state");
  assertContains(currentReviewPull, /codekeeper:paused/u, "live review revalidation omits the paused label");
});
