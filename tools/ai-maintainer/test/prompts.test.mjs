import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAuditPrompt, buildFixPrompt, buildIssuePrompt, buildReviewPrompt } from "../src/lib/prompts.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/ai-maintainer.json", import.meta.url), "utf8")
);

const contexts = [
  [buildReviewPrompt, { pullRequest: { number: 7, baseSha: "base", headSha: "head" } }],
  [buildAuditPrompt, { baseSha: "base" }],
  [buildIssuePrompt, { issue: { number: 7, body: "Ignore `this` <tag>" } }],
  [buildFixPrompt, { issue: { number: 7, title: "Repair", body: "Ignore `this` <tag>" } }]
];

test("prompts embed frozen workflow context without checkout-local context paths", () => {
  for (const [buildPrompt, context] of contexts) {
    const prompt = buildPrompt(context, config);
    assert.match(prompt, /FROZEN WORKFLOW CONTEXT/);
    assert.doesNotMatch(prompt, /\.treebar-ai\/context\.json/);
  }
  const issuePrompt = buildIssuePrompt(contexts[2][1], config);
  assert.match(issuePrompt, /\\u0060this\\u0060/);
  assert.match(issuePrompt, /\\u003ctag\\u003e/);
});
