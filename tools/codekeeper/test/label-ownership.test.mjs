import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { LABELS } from "../src/lib/label-ownership.mjs";
import { normalizeLivePolicy } from "../src/lib/policy-normalization.mjs";
import { validatePolicy } from "../src/lib/policy-validator.mjs";
import { findingLabels, issueTypeLabel, reviewLabels } from "../src/lib/policy.mjs";

const source = normalizeLivePolicy(JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8"),
));

test("Codekeeper emits concise review and issue labels", () => {
  const labels = reviewLabels({
    risk: "high",
    labels: [LABELS.SECURITY],
    tests: { missingTest: true },
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    mergeRecommendation: "manual",
  });

  assert.deepEqual(new Set(labels), new Set([
    LABELS.NEEDS_TESTS,
    LABELS.REVIEW_NEEDED,
  ]));
  assert.equal(issueTypeLabel("security"), LABELS.SECURITY);
  assert.deepEqual(findingLabels({ category: "security", labels: [] }), [
    LABELS.AUTOMATED_MAINTENANCE,
    LABELS.SECURITY,
  ]);
});

test("policy validation rejects generic labels from Codekeeper-managed sets", () => {
  const config = structuredClone(source);
  config.labels["risk high"] = { color: "B60205", description: "Repository taxonomy label" };
  config.review.managedLabels = [LABELS.REVIEW_NEEDED, "risk high"];
  assert.throws(
    () => validatePolicy(config),
    /review may only emit Codekeeper-owned labels: risk high/,
  );
});

test("label reconciliation removes only Codekeeper-owned labels", async () => {
  const originalFetch = globalThis.fetch;
  const deletes = [];
  const issue = {
    number: 7,
    labels: [
      { name: "external-taxonomy" },
      { name: "risk high" },
      { name: LABELS.REVIEW_NEEDED },
      { name: "codekeeper:risk-high" },
    ],
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const pathname = new URL(url).pathname;
    if (method === "GET" && pathname.endsWith("/issues/7")) {
      return new Response(JSON.stringify(issue), { status: 200 });
    }
    if (method === "DELETE") {
      deletes.push(pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected ${method} ${pathname}`);
  };
  try {
    const github = new GitHubClient({ token: "token", repository: "owner/repository" });
    await github.replaceManagedLabels(
      7,
      [LABELS.REVIEW_NEEDED],
      [LABELS.REVIEW_NEEDED, "codekeeper:risk-high"],
    );
    await assert.rejects(
      github.replaceManagedLabels(7, ["external-taxonomy"], ["external-taxonomy"]),
      /outside Codekeeper ownership: external-taxonomy/,
    );
    await assert.rejects(
      github.rollbackPullLabel(7, "external-taxonomy"),
      /outside Codekeeper ownership: external-taxonomy/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(deletes, [
    "/repos/owner/repository/issues/7/labels/codekeeper%3Arisk-high",
  ]);
});
