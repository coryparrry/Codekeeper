import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveModePlan } from "../../../packages/codekeeper/src/mode-plan.mjs";
import {
  advanceEnvelope,
  createEnvelope,
} from "../src/lib/orchestration/envelope.mjs";
import { createHandoff } from "../src/lib/orchestration/handoff.mjs";
import {
  assertOrchestrationPlan,
  assertProviderSettingsWithinPlan,
  createOrchestrationPlan,
  orchestrationPlanBytes,
  orchestrationPlanSha256,
  parseOrchestrationPlan,
} from "../src/lib/orchestration/orchestration-plan.mjs";
import { sha256 } from "../src/lib/markers.mjs";

const DIGESTS = Object.freeze({
  modePlan: "1".repeat(64),
  policy: "2".repeat(64),
  package: "3".repeat(64),
  repository: "4".repeat(64),
  context: "5".repeat(64),
  head: "6".repeat(64),
});
const POLICY = Object.freeze({
  enabled: false,
  modes: Object.freeze({
    review: false,
    issues: false,
    fix: false,
    maintain: false,
  }),
  maximumSpecialists: 4,
  maximumConcurrency: 3,
  maximumToolCalls: 6,
  maximumTokensPerAgent: 32000,
  maximumTotalTokens: 96000,
  maximumOutputBytes: 262144,
  maximumAutomaticRepairRounds: 1,
  providerMultiAgent: false,
});

function modePlan(enabled = false) {
  const plan = resolveModePlan({
    requestedMode: "review",
    event: { eventName: "pull_request" },
    policy: { orchestration: POLICY },
  });
  return enabled
    ? { ...plan, orchestration: { ...plan.orchestration, enabled: true } }
    : plan;
}

test("manager-only plans are canonical, exact, and digest bound", () => {
  const source = createOrchestrationPlan({
    modePlan: modePlan(),
    bindings: DIGESTS,
  });
  assert.deepEqual(source.specialists, []);
  assert.equal(source.maximumConcurrency, 0);
  assert.equal(source.maximumToolCalls, 0);
  assert.equal(
    orchestrationPlanSha256(source, {
      modePlan: modePlan(),
      bindings: DIGESTS,
    }),
    sha256(
      orchestrationPlanBytes(source, {
        modePlan: modePlan(),
        bindings: DIGESTS,
      }),
    ),
  );
  assert.throws(
    () =>
      assertOrchestrationPlan(
        { ...source, unexpected: true },
        { modePlan: modePlan() },
      ),
    /unexpected or missing properties/,
  );
  assert.throws(
    () =>
      parseOrchestrationPlan(
        Buffer.concat([
          Buffer.from(" "),
          orchestrationPlanBytes(source, {
            modePlan: modePlan(),
            bindings: DIGESTS,
          }),
        ]),
        { modePlan: modePlan(), bindings: DIGESTS },
      ),
    /not canonical/,
  );
  assert.throws(
    () =>
      createOrchestrationPlan({
        modePlan: modePlan(),
        bindings: DIGESTS,
        specialists: ["correctness"],
      }),
    /manager-only plan/,
  );
});

test("plans reject unknown, duplicate, stale, and over-budget specialist work", () => {
  const enabledPlan = modePlan(true);
  const input = {
    modePlan: enabledPlan,
    bindings: DIGESTS,
    specialists: ["correctness", "test-coverage"],
    maximumConcurrency: 2,
  };
  const plan = createOrchestrationPlan(input);
  assert.equal(
    orchestrationPlanSha256(plan, {
      modePlan: enabledPlan,
      bindings: DIGESTS,
    }),
    orchestrationPlanSha256(
      createOrchestrationPlan({
        ...input,
        specialists: ["test-coverage", "correctness"],
      }),
      { modePlan: enabledPlan, bindings: DIGESTS },
    ),
  );
  assert.throws(
    () => createOrchestrationPlan({ ...input, specialists: ["security"] }),
    /Unknown orchestration specialist role/,
  );
  assert.throws(
    () =>
      createOrchestrationPlan({
        ...input,
        specialists: ["correctness", "correctness"],
      }),
    /duplicate specialist roles/,
  );
  assert.throws(
    () => createOrchestrationPlan({ ...input, maximumConcurrency: 3 }),
    /exceeds selected specialists/,
  );
  assert.throws(
    () => createOrchestrationPlan({ ...input, maximumTotalTokens: 63999 }),
    /does not cover every selected agent/,
  );
  assert.throws(
    () =>
      assertOrchestrationPlan(plan, {
        modePlan: enabledPlan,
        bindings: { ...DIGESTS, context: "7".repeat(64) },
      }),
    /context binding is stale/,
  );
});

test("plans reject authority tampering and provider escalation", () => {
  const verifiedModePlan = modePlan(true);
  const plan = createOrchestrationPlan({
    modePlan: verifiedModePlan,
    bindings: DIGESTS,
    maximumTurns: 2,
    maximumAttempts: 2,
  });
  assert.throws(
    () =>
      assertOrchestrationPlan(
        { ...plan, credentialStage: "publication" },
        { modePlan: verifiedModePlan },
      ),
    /credentialStage must be coordinator/,
  );
  assert.throws(
    () =>
      assertOrchestrationPlan(
        { ...plan, mode: "issues", manager: "issue-triage-manager" },
        { modePlan: verifiedModePlan },
      ),
    /mode does not match mode plan/,
  );
  assert.throws(
    () =>
      assertOrchestrationPlan(
        {
          ...plan,
          appPermissions: { ...plan.appPermissions, contents: "write" },
        },
        { modePlan: verifiedModePlan },
      ),
    /contents permission does not match/,
  );
  assert.deepEqual(
    assertProviderSettingsWithinPlan(plan, { maxTurns: 2, maximumAttempts: 2 }),
    { maxTurns: 2, maximumAttempts: 2 },
  );
  assert.throws(
    () =>
      assertProviderSettingsWithinPlan(plan, {
        maxTurns: 3,
        maximumAttempts: 2,
      }),
    /exceed orchestration-plan ceilings/,
  );
});

test("disabled plans preserve the one-turn compatibility ceiling", () => {
  assert.throws(
    () =>
      createOrchestrationPlan({
        modePlan: modePlan(),
        bindings: DIGESTS,
        maximumTurns: 2,
      }),
    /one turn and one attempt/,
  );
});

test("handoffs bind an optional orchestration plan through the existing envelope", async () => {
  const verifiedModePlan = modePlan();
  const planBytes = orchestrationPlanBytes(
    createOrchestrationPlan({ modePlan: verifiedModePlan, bindings: DIGESTS }),
    { modePlan: verifiedModePlan, bindings: DIGESTS },
  );
  const required = {
    "mode-plan.json": Buffer.from("mode"),
    "policy.json": Buffer.from("policy"),
    "profile.json": Buffer.from("profile"),
    "context.json": Buffer.from("context"),
    "workspace-result.json": Buffer.from("workspace"),
    "candidate.json": Buffer.from("candidate"),
    "orchestration-plan.json": planBytes,
  };
  const created = createEnvelope({
    mode: "review",
    run: { repository: "owner/repo", runId: "1", attempt: 1 },
    package: {
      name: "@coryparry/codekeeper",
      version: "1.0.0",
      integrity: "sha512-YQ==",
      sourceCommit: "a".repeat(40),
    },
    request: { eventName: "pull_request", targetNumber: 1, requestedBy: "bot" },
    repository: {
      defaultBranch: "main",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    digests: {
      modePlan: sha256(required["mode-plan.json"]),
      policy: sha256(required["policy.json"]),
      profile: sha256(required["profile.json"]),
      context: sha256(required["context.json"]),
      orchestrationPlan: sha256(planBytes),
    },
  });
  const envelope = advanceEnvelope(created, "compute-complete", {
    digests: {
      workspaceResult: sha256(required["workspace-result.json"]),
      candidate: sha256(required["candidate.json"]),
    },
  });
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "orchestration-plan-test-"),
  );
  try {
    const result = await createHandoff({
      directory,
      envelope,
      kind: "compute",
      files: required,
    });
    assert.equal(
      result.manifest.files.find(
        ({ path: name }) => name === "orchestration-plan.json",
      ).sha256,
      envelope.digests.orchestrationPlan,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
