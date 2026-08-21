import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  COMMAND_MODE_MAP,
  MODE_IDS,
  MODE_PLAN_KEYS,
  MODE_REGISTRY,
  MODES,
  RUNTIME_WORKFLOW_IDS,
  RUNTIME_WORKFLOWS,
  resolveModePlan,
  validateModeRegistry,
} from "../src/mode-registry.mjs";

const registryRecords = () =>
  Object.values(MODE_REGISTRY).map((mode) => structuredClone(mode));

test("the registry contains the existing package modes and derived compatibility references", () => {
  assert.deepEqual(MODE_IDS, ["review", "maintain", "issues", "fix"]);
  assert.deepEqual(MODE_IDS, Object.keys(MODES));
  assert.deepEqual(AGENT_PROFILE_IDS, [
    "pr-reviewer",
    "repository-auditor",
    "issue-triager",
    "fixer",
  ]);
  assert.equal(MODES.maintain.policyAgent, "audit");
  assert.equal(MODES.issues.policyAgent, "issue");
  assert.equal(MODES.fix.agentProfile, "fixer");
  assert.equal(MODES.review.target, ".github/workflows/codekeeper-review.yml");
  assert.equal(
    RUNTIME_WORKFLOWS.fix.target,
    ".github/workflows/codekeeper-runtime-fix.yml",
  );
  assert.deepEqual(RUNTIME_WORKFLOW_IDS, ["assistant", ...MODE_IDS]);
  assert.equal(AGENT_PROFILES.fixer.asset, "agents/fixer.md");
  assert.equal(COMMAND_MODE_MAP.implement, "fix");
  assert.equal(validateModeRegistry(MODE_REGISTRY), true);
});

test("registry validation rejects duplicate IDs and unknown profiles", () => {
  const records = registryRecords();
  assert.throws(
    () => validateModeRegistry([...records, { ...records[0] }]),
    /duplicate mode ID/,
  );
  const unknownProfile = registryRecords();
  unknownProfile[0].agentProfile = "missing-profile";
  assert.throws(
    () => validateModeRegistry(unknownProfile),
    /unknown agent profile/,
  );
});

test("registry validation rejects invalid permissions, unsafe topology, and missing adapters", () => {
  const invalidPermissions = registryRecords();
  invalidPermissions[0].appPermissions.contents = "admin";
  assert.throws(
    () => validateModeRegistry(invalidPermissions),
    /invalid App permissions/,
  );

  const writableWithoutValidation = registryRecords();
  writableWithoutValidation[3].stages.validation = "never";
  assert.throws(
    () => validateModeRegistry(writableWithoutValidation),
    /write-capable.*validation/,
  );

  const gateWithoutPublication = registryRecords();
  gateWithoutPublication[0].stages.publication = "never";
  assert.throws(
    () => validateModeRegistry(gateWithoutPublication),
    /gate without a publication/,
  );

  const publicationWithoutAdapter = registryRecords();
  publicationWithoutAdapter[0].publicationAdapter = "";
  assert.throws(
    () => validateModeRegistry(publicationWithoutAdapter),
    /publication but no adapter/,
  );

  const bogusAdapter = registryRecords();
  bogusAdapter[0].publicationAdapter = "unknown";
  assert.throws(
    () => validateModeRegistry(bogusAdapter),
    /unknown or incorrect publication adapter/,
  );

  const divergentValidation = registryRecords();
  divergentValidation[3].candidateValidation = "never";
  assert.throws(
    () => validateModeRegistry(divergentValidation),
    /candidate validation diverges/,
  );

  const badScope = registryRecords();
  badScope[0].concurrency.scope = "global";
  assert.throws(
    () => validateModeRegistry(badScope),
    /unknown concurrency scope/,
  );

  const badIsolation = registryRecords();
  badIsolation[0].workspace.isolation = "privileged";
  assert.throws(
    () => validateModeRegistry(badIsolation),
    /invalid workspace access/,
  );

  const mismatchedIsolation = registryRecords();
  mismatchedIsolation[0].workspace.isolation = "none";
  assert.throws(
    () => validateModeRegistry(mismatchedIsolation),
    /access and isolation pairing/,
  );
});

test("registry validation rejects command routes to unknown modes and cancellation of mutation runs", () => {
  const unknownCommandTarget = registryRecords();
  unknownCommandTarget[3].supportedCommands.fix = "unknown";
  assert.throws(
    () => validateModeRegistry(unknownCommandTarget),
    /targets an unknown mode/,
  );

  const cancellingFix = registryRecords();
  cancellingFix[3].concurrency.cancelAutomaticSupersededRuns = true;
  assert.throws(
    () => validateModeRegistry(cancellingFix),
    /cannot automatically cancel mutation-authorized/,
  );

  const extraMode = registryRecords();
  extraMode.push({ ...structuredClone(extraMode[0]), id: "extra" });
  assert.throws(
    () => validateModeRegistry(extraMode),
    /exactly the canonical mode IDs/,
  );

  const missingLabel = registryRecords();
  missingLabel[0].label = "";
  assert.throws(() => validateModeRegistry(missingLabel), /missing a label/);

  const missingArtifact = registryRecords();
  delete missingArtifact[0].runtime.asset;
  assert.throws(
    () => validateModeRegistry(missingArtifact),
    /runtime artifact references/,
  );

  const missingGate = registryRecords();
  delete missingGate[0].requiredGate;
  assert.throws(
    () => validateModeRegistry(missingGate),
    /gate or manual trigger flags/,
  );

  const missingCommandMap = registryRecords();
  delete missingCommandMap[0].supportedCommands;
  assert.throws(
    () => validateModeRegistry(missingCommandMap),
    /invalid command routing/,
  );

  const reservedCommand = registryRecords();
  reservedCommand[0].supportedCommands.constructor = "review";
  assert.throws(
    () => validateModeRegistry(reservedCommand),
    /reserved command name/,
  );
});

test("resolved plans are closed, frozen, deterministic, and reject event authority injection", () => {
  const plan = resolveModePlan({
    requestedMode: "fix",
    event: {
      eventName: "issue_comment",
      command: "implement",
      targetNumber: "197",
    },
    policy: { candidateRequiresValidation: true },
  });
  assert.deepEqual(Object.keys(plan), MODE_PLAN_KEYS);
  assert.equal(plan.resolvedMode, "fix");
  assert.equal(plan.trigger, "owner-command");
  assert.equal(plan.targetNumber, 197);
  assert.equal(plan.workspaceAccess, "write");
  assert.equal(plan.validationRequired, true);
  assert.equal(plan.publicationRequired, true);
  assert.equal(plan.publicationAdapter, "fix");
  assert.deepEqual(plan.appPermissions, MODES.fix.appPermissions);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.appPermissions));
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "fix",
        event: {
          eventName: "issue_comment",
          command: "implement",
          appPermissions: { contents: "read" },
        },
        policy: {},
      }),
    /unknown properties/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "fix",
        event: { eventName: "issue_comment", command: "implement" },
        policy: { stages: { validation: "never" } },
      }),
    /unknown properties/,
  );
  assert.deepEqual(
    plan,
    resolveModePlan({
      requestedMode: "fix",
      event: {
        eventName: "issue_comment",
        command: "implement",
        targetNumber: 197,
      },
      policy: { candidateRequiresValidation: true },
    }),
  );
});

test("auto resolution uses unambiguous event and command routes", () => {
  assert.equal(
    resolveModePlan({
      requestedMode: "auto",
      event: { eventName: "pull_request" },
    }).resolvedMode,
    "review",
  );
  assert.equal(
    resolveModePlan({ requestedMode: "auto", event: { eventName: "schedule" } })
      .resolvedMode,
    "maintain",
  );
  assert.equal(
    resolveModePlan({ requestedMode: "auto", event: { eventName: "issues" } })
      .resolvedMode,
    "issues",
  );
  assert.equal(
    resolveModePlan({
      requestedMode: "auto",
      event: { eventName: "issues", action: "labeled" },
      policy: { readyLabelFix: true },
    }).resolvedMode,
    "fix",
  );
  assert.equal(
    resolveModePlan({
      requestedMode: "auto",
      event: {
        eventName: "issue_comment",
        command: "implement",
        targetNumber: 9,
      },
    }).resolvedMode,
    "fix",
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "auto",
        event: { eventName: "issue_comment", command: "unknown" },
      }),
    /Auto mode requires|Unknown mode command/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "review",
        event: { eventName: "issue_comment", command: "implement" },
      }),
    /does not target mode review/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "auto",
        event: { eventName: "workflow_dispatch" },
      }),
    /unambiguous validated mode route/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "auto",
        event: { eventName: "issue_comment", command: "constructor" },
      }),
    /Unknown mode command/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "auto",
        event: { eventName: "issue_comment", command: "toString" },
      }),
    /Unknown mode command/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "review",
        event: { eventName: "pull_request", trigger: "issue" },
      }),
    /unknown properties/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "auto",
        event: { eventName: "pull_request", command: "triage" },
      }),
    /ambiguous event route/,
  );
  const parsedProto = JSON.parse(
    '{"requestedMode":"review","event":{"eventName":"pull_request","__proto__":{}},"policy":{}}',
  );
  assert.throws(() => resolveModePlan(parsedProto), /forbidden property/);
  const parsedConstructor = JSON.parse(
    '{"requestedMode":"review","event":{"eventName":"pull_request","constructor":{}},"policy":{}}',
  );
  assert.throws(() => resolveModePlan(parsedConstructor), /forbidden property/);
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "review",
        event: Object.create({ eventName: "pull_request" }),
      }),
    /plain object prototype/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "review",
        event: { eventName: "pull_request", action: { value: "opened" } },
      }),
    /event action must be a string/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "review",
        event: { eventName: "pull_request", dryRun: "true" },
      }),
    /event dry-run flag must be boolean/,
  );
  assert.throws(
    () =>
      resolveModePlan({
        requestedMode: "review",
        event: { eventName: "pull_request" },
        policy: Object.create({ candidateRequiresValidation: false }),
      }),
    /plain object prototype/,
  );
});

test("the direct resolver CLI accepts JSON input or standalone field flags", () => {
  const cli = fileURLToPath(
    new URL("../bin/resolve-mode-plan.mjs", import.meta.url),
  );
  const valid = spawnSync(
    process.execPath,
    [
      cli,
      "--json",
      JSON.stringify({
        requestedMode: "auto",
        event: {
          eventName: "issue_comment",
          command: "implement",
          targetNumber: 12,
        },
        policy: {},
      }),
    ],
    { encoding: "utf8" },
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).resolvedMode, "fix");

  const flags = spawnSync(
    process.execPath,
    [
      cli,
      "--mode",
      "fix",
      "--event",
      "issue_comment",
      "--command",
      "implement",
      "--target-number",
      "12",
    ],
    { encoding: "utf8" },
  );
  assert.equal(flags.status, 0, flags.stderr);
  assert.equal(JSON.parse(flags.stdout).resolvedMode, "fix");

  const invalid = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /event name is invalid/);
});
