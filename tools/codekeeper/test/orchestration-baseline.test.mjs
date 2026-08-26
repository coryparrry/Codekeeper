import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveModePlan } from "../../../packages/codekeeper/src/mode-plan.mjs";
import {
  MAX_CLUSTERED_FIXER_AGENTS,
  MAX_WORKSPACE_PASSES,
} from "../src/lib/agents-runtime.mjs";
import { jobSection, workflow } from "./workflow-test-helpers.mjs";

const baselineFixture = JSON.parse(
  await readFile(
    new URL("./fixtures/runtime-v2-baseline.json", import.meta.url),
    "utf8",
  ),
);
const genericRuntime = await workflow("runtime");
const baselinePlanningInputs = Object.freeze({
  review: { requestedMode: "review", event: { eventName: "pull_request" } },
  issue: { requestedMode: "issues", event: { eventName: "issues" } },
  fix: { requestedMode: "fix", event: { eventName: "workflow_dispatch" } },
  maintain: { requestedMode: "maintain", event: { eventName: "schedule" } },
});

function productionJobNames(source) {
  const jobsStart = source.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, "production workflow must declare jobs");
  return [...source.slice(jobsStart).matchAll(/^  ([a-z][a-z0-9_-]*):$/gm)].map(
    (match) => match[1],
  );
}

function deriveRunnerAllocations() {
  const runtimeJobs = new Set(productionJobNames(genericRuntime));
  return Object.fromEntries(
    Object.entries(baselinePlanningInputs).map(([mode, input]) => {
      const plan = resolveModePlan({ ...input, policy: { publicationEnabled: true } });
      const stages = ["compute"];
      if (plan.validationRequired) stages.push("validate");
      if (plan.publicationRequired) stages.push("publish");
      assert.ok(
        stages.every((stage) => runtimeJobs.has(stage)),
        `${mode} plan references a stage absent from the production runtime workflow`,
      );
      return [mode, stages.length];
    }),
  );
}

function productionJobNeeds(source, stage) {
  const names = productionJobNames(source);
  const index = names.indexOf(stage);
  assert.notEqual(index, -1, `production runtime is missing ${stage}`);
  const section = jobSection(source, stage, names[index + 1]);
  const match = section.match(/^    needs: (.+)$/m);
  if (!match) return [];
  const value = match[1].trim();
  if (value.startsWith("[")) return value.slice(1, -1).split(",").map((item) => item.trim());
  return [value];
}

function derivePeakRunnerConcurrency() {
  const stageNeeds = new Map(
    ["compute", "validate", "publish"].map((stage) => [
      stage,
      productionJobNeeds(genericRuntime, stage),
    ]),
  );
  let peak = 0;
  for (const input of Object.values(baselinePlanningInputs)) {
    const plan = resolveModePlan({ ...input, policy: { publicationEnabled: true } });
    const activeStages = [
      "compute",
      ...(plan.validationRequired ? ["validate"] : []),
      ...(plan.publicationRequired ? ["publish"] : []),
    ];
    const levels = new Map();
    for (const stage of activeStages) {
      const dependencies = stageNeeds.get(stage).filter((dependency) => activeStages.includes(dependency));
      const level = dependencies.length === 0
        ? 0
        : Math.max(...dependencies.map((dependency) => levels.get(dependency))) + 1;
      levels.set(stage, level);
    }
    const counts = new Map();
    for (const level of levels.values()) counts.set(level, (counts.get(level) ?? 0) + 1);
    peak = Math.max(peak, ...counts.values());
  }
  return peak;
}

function deriveModelCalls() {
  return {
    review: {
      minimum: 2,
      maximum: 1 + MAX_WORKSPACE_PASSES.review,
      stages: ["workspace", "coordinator", "focused-workspace (optional)"],
    },
    issue: {
      minimum: 1,
      maximum: 1,
      stages: ["workspace or coordinator"],
    },
    fix: {
      minimum: 2,
      maximum: 1 + MAX_CLUSTERED_FIXER_AGENTS,
      stages: ["workspace", "coordinator", "second clustered workspace (optional)"],
    },
    maintain: {
      minimum: 2,
      maximum: 2,
      stages: ["workspace", "coordinator"],
    },
  };
}

function deriveRepairClusters() {
  return {
    review: { minimum: 0, maximum: 0 },
    issue: { minimum: 0, maximum: 0 },
    fix: { minimum: 0, maximum: MAX_CLUSTERED_FIXER_AGENTS },
    maintain: { minimum: 0, maximum: 0 },
  };
}

test("the committed baseline records current model, repair, and runner topology", () => {
  assert.equal(baselineFixture.schemaVersion, 1);
  assert.equal(
    baselineFixture.modelCallBasis,
    "Nominal successful stages; bounded provider retries are not topology stages.",
  );
  assert.deepEqual(Object.keys(baselineFixture.modelCalls), [
    "review",
    "issue",
    "fix",
    "maintain",
  ]);
  assert.deepEqual(baselineFixture.modelCalls, deriveModelCalls());
  assert.deepEqual(baselineFixture.repairClusters, deriveRepairClusters());
  assert.deepEqual(baselineFixture.runnerAllocations, deriveRunnerAllocations());
  assert.equal(baselineFixture.peakRunnerConcurrency, derivePeakRunnerConcurrency());
  assert.equal(baselineFixture.orchestrationSpecialistInvocations, 0);
});
