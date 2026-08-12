import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const harness = await readFile(new URL("../src/harness.mjs", import.meta.url), "utf8");
const publish = await readFile(new URL("../../tools/codekeeper/src/lib/publish.mjs", import.meta.url), "utf8");
const github = await readFile(new URL("../../tools/codekeeper/src/lib/github.mjs", import.meta.url), "utf8");

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

test("manually supplied review and issue runs require a dispatch freshness boundary", () => {
  const review = section(harness, "async function verifyReview", "async function verifyIssue");
  const issue = section(harness, "async function verifyIssue", "async function verifyFix");
  assertContains(review, /boundary\s*:/u, "review verification accepts a run without a freshness boundary");
  assertContains(issue, /boundary\s*:/u, "issue verification accepts a run without a freshness boundary");
});

test("acceptance quiescence accounts for workflow runs beyond the first page", () => {
  const quiescence = section(harness, "function assertQuiescent", "async function acceptanceTagRef");
  assertContains(quiescence, /pageInfo|hasNextPage|nextPage|pagination/u, "quiescence validates only the first returned run page");
});

test("audit publication binds mutations to the remote default branch", () => {
  const auditPublication = section(publish, "export async function publishAudit", "export async function publishFix");
  const branchMutation = section(github, "  async beginBranchMutation", "\n  async beginIssueMutation");
  assertContains(auditPublication, /github\.beginBranchMutation/u, "audit publication does not enter the branch mutation seam");
  assertContains(branchMutation, /assertMutationCurrent/u, "branch mutation is not checked inside the GitHub adapter");
});
