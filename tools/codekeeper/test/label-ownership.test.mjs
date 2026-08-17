import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { validatePolicy } from "../src/lib/policy-validator.mjs";
import { findingLabels, issueTypeLabel, reviewLabels } from "../src/lib/policy.mjs";

const source = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8"),
);

test("Codekeeper emits canonical namespaced labels", () => {
  const labels = reviewLabels({
    risk: "high",
    labels: ["codekeeper:type-security"],
    tests: { missingTest: true },
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    mergeRecommendation: "manual",
  });

  assert.deepEqual(new Set(labels), new Set([
    "codekeeper:reviewed",
    "codekeeper:risk-high",
    "codekeeper:type-security",
    "codekeeper:needs-tests",
    "codekeeper:manual-review",
  ]));
  assert.equal(issueTypeLabel("security"), "codekeeper:type-security");
  assert.deepEqual(findingLabels({ category: "security", labels: [] }), [
    "codekeeper:maintenance",
    "codekeeper:type-security",
  ]);
});

test("policy validation rejects generic labels from Codekeeper-managed sets", () => {
  const config = structuredClone(source);
  config.labels["risk high"] = { color: "B60205", description: "Repository taxonomy label" };
  config.review.managedLabels = ["codekeeper:reviewed", "risk high"];
  assert.throws(
    () => validatePolicy(config),
    /review may only emit Codekeeper-owned labels: risk high/,
  );
});

test("label reconciliation preserves generic labels and only deletes Codekeeper labels", async () => {
  const originalFetch = globalThis.fetch;
  const deletes = [];
  const issue = {
    number: 7,
    labels: [
      { name: "bug" },
      { name: "security" },
      { name: "ready" },
      { name: "paused" },
      { name: "risk high" },
      { name: "codekeeper:reviewed" },
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
      ["codekeeper:reviewed"],
      ["codekeeper:reviewed", "codekeeper:risk-high"],
    );
    await assert.rejects(
      github.replaceManagedLabels(7, ["ready"], ["ready"]),
      /outside Codekeeper ownership: ready/,
    );
    await assert.rejects(
      github.removeLabel(7, "paused"),
      /outside Codekeeper ownership: paused/,
    );
    await assert.rejects(
      github.rollbackPullLabel(7, "ready"),
      /outside Codekeeper ownership: ready/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(deletes, [
    "/repos/owner/repository/issues/7/labels/codekeeper%3Arisk-high",
  ]);
});
