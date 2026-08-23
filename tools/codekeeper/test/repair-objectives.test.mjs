import assert from "node:assert/strict";
import test from "node:test";
import { automaticRepairMarker } from "../src/lib/markers.mjs";
import {
  authorizedAutomaticRepairPlan,
  automaticRepairDispatchDetails,
  clusterRepairObjectives,
  mergeFixWorkspaceResults,
  parseRepairObjectivesMarker,
  repairItemsFromReviewResult,
  repairObjectivesMarker
} from "../src/lib/repair-objectives.mjs";

const headSha = "9".repeat(40);

function reviewResult() {
  return {
    blockingFindings: [{
      title: "FX exposure truncation can allow batches over the treasury cap",
      file: "src/settlement.mjs",
      line: 65,
      explanation: "Integer division floors converted exposure.",
      validation: "grossCents=4999501 and fxRateBps=10001 must round up."
    }],
    tests: {
      notes: "Main paths are covered.",
      missingTest: "test/settlement.test.mjs: add the fractional FX boundary case with grossCents=4,999,501."
    },
    reviewFeedback: []
  };
}

test("a blocking finding and its missing test stay in one fixer cluster", () => {
  const items = repairItemsFromReviewResult(reviewResult());
  const clusters = clusterRepairObjectives(items);
  assert.equal(items.length, 2);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].id, "settlement");
  assert.deepEqual(clusters[0].items.map((item) => item.kind), ["finding", "missing-test"]);
});

test("extra independent clusters fold into a remaining fixer agent", () => {
  const items = ["a", "b", "c", "d", "e"].map((name) => ({
    kind: "finding",
    title: `${name} defect`,
    file: `src/${name}.mjs`,
    line: 1,
    explanation: `${name} is wrong`,
    validation: `Fix ${name}`
  }));
  const clusters = clusterRepairObjectives(items);
  assert.equal(clusters.length, 4);
  assert.equal(clusters.at(-1).id, "remaining");
  assert.equal(clusters.at(-1).items.length, 2);
});

test("independent source files become separate fixer clusters", () => {
  const items = repairItemsFromReviewResult({
    blockingFindings: [
      { title: "FX truncation", file: "src/settlement.mjs", line: 65, explanation: "floor", validation: "ceil" },
      { title: "TTL counted twice", file: "src/idempotency.mjs", line: 50, explanation: "ttl", validation: "once" }
    ],
    tests: { missingTest: null },
    reviewFeedback: []
  });
  const clusters = clusterRepairObjectives(items);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map((cluster) => cluster.id).sort(), ["idempotency", "settlement"]);
});

test("repair objective markers round-trip through the dispatch comment", () => {
  const items = repairItemsFromReviewResult(reviewResult());
  const details = automaticRepairDispatchDetails(headSha, items);
  assert.match(details, /This run will use 1 fixer agent/);
  assert.match(details, /FX exposure truncation/);
  assert.match(details, /src\/settlement\.mjs:65/);
  assert.match(details, /Add the missing test coverage/);
  const parsed = parseRepairObjectivesMarker(details);
  assert.equal(parsed.headSha, headSha);
  assert.equal(parsed.items.length, 2);
  assert.equal(repairObjectivesMarker({ headSha, items: parsed.items }), details.trim().split("\n").at(-1));
});

test("policy repair reads trusted objectives from the owned dispatch comment", () => {
  const items = repairItemsFromReviewResult(reviewResult());
  const body = `Automatic repair was dispatched for head ${headSha}.${automaticRepairDispatchDetails(headSha, items)}\n${automaticRepairMarker(headSha)}`;
  const plan = authorizedAutomaticRepairPlan({
    comments: [{
      body,
      user: { login: "codekeeper[bot]", type: "Bot" }
    }],
    actor: "codekeeper[bot]",
    headSha
  });
  assert.equal(plan.clusters.length, 1);
  assert.equal(plan.objectives.length, 2);
});

test("malformed repair objectives fail closed", () => {
  const body = `Automatic repair was dispatched for head ${headSha}.\n<!-- codekeeper:repair-objectives=v1:not-valid -->\n${automaticRepairMarker(headSha)}`;
  assert.throws(
    () => authorizedAutomaticRepairPlan({
      comments: [{ body, user: { login: "codekeeper[bot]", type: "Bot" } }],
      actor: "codekeeper[bot]",
      headSha
    }),
    /malformed/
  );
});

test("clustered fixer results keep a successful patch when a sibling makes no change", () => {
  const merged = mergeFixWorkspaceResults([
    {
      mode: "fix",
      summary: "Rounded FX exposure up.",
      risk: "medium",
      targetKind: "pull_request",
      targetNumber: 74,
      changedSummary: "Use ceiling rounding.",
      testsRun: [{ command: "node --test", result: "passed" }],
      resolvedReviewThreadIds: [],
      readyForReview: true,
      noChangeReason: null
    },
    {
      mode: "fix",
      summary: "No independent idempotency defect.",
      risk: "low",
      targetKind: "pull_request",
      targetNumber: 74,
      changedSummary: "",
      testsRun: [],
      resolvedReviewThreadIds: [],
      readyForReview: false,
      noChangeReason: "The checkout already expires entries once."
    }
  ], { kind: "pull_request", number: 74 });
  assert.equal(merged.readyForReview, true);
  assert.equal(merged.noChangeReason, null);
  assert.equal(merged.risk, "medium");
  assert.match(merged.changedSummary, /ceiling rounding/);
});
