import { sha256 } from "../markers.mjs";

export const ORCHESTRATION_PLAN_SCHEMA_VERSION = 1;
export const ORCHESTRATION_MANAGERS = Object.freeze({
  review: "pr-review-manager",
  issues: "issue-triage-manager",
  fix: "repair-manager",
  maintain: "repository-maintenance-manager",
});
export const ORCHESTRATION_SPECIALISTS = Object.freeze([
  "correctness",
  "test-coverage",
]);

const DIGEST = /^[a-f0-9]{64}$/;
const PLAN_KEYS = [
  "schemaVersion",
  "mode",
  "manager",
  "specialists",
  "maximumSpecialists",
  "maximumConcurrency",
  "maximumTurns",
  "maximumToolCalls",
  "maximumTokensPerAgent",
  "maximumTotalTokens",
  "maximumOutputBytesPerAgent",
  "maximumOutputBytes",
  "deadlineMs",
  "maximumAttempts",
  "maximumRepairRounds",
  "credentialStage",
  "appPermissions",
  "bindings",
];
const PERMISSION_KEYS = ["contents", "issues", "pullRequests"];
const BINDING_KEYS = [
  "modePlan",
  "policy",
  "package",
  "repository",
  "context",
  "head",
];

function exactObject(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    throw new TypeError(`${name} contains unexpected or missing properties`);
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonical(value) {
  const ordered = {};
  for (const key of PLAN_KEYS) ordered[key] = value[key];
  ordered.appPermissions = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, value.appPermissions[key]]),
  );
  ordered.bindings = Object.fromEntries(
    BINDING_KEYS.map((key) => [key, value.bindings[key]]),
  );
  return `${JSON.stringify(ordered)}\n`;
}

export function assertOrchestrationPlan(plan, { modePlan, bindings } = {}) {
  exactObject(plan, "Orchestration plan", PLAN_KEYS);
  if (plan.schemaVersion !== ORCHESTRATION_PLAN_SCHEMA_VERSION)
    throw new TypeError("Unsupported orchestration-plan schema version");
  if (!Object.hasOwn(ORCHESTRATION_MANAGERS, plan.mode))
    throw new TypeError("Orchestration plan mode is invalid");
  if (plan.manager !== ORCHESTRATION_MANAGERS[plan.mode])
    throw new TypeError("Orchestration plan manager is invalid");
  if (!Array.isArray(plan.specialists))
    throw new TypeError("Orchestration plan specialists must be an array");
  if (new Set(plan.specialists).size !== plan.specialists.length)
    throw new TypeError(
      "Orchestration plan contains duplicate specialist roles",
    );
  for (const role of plan.specialists) {
    if (!ORCHESTRATION_SPECIALISTS.includes(role))
      throw new TypeError(`Unknown orchestration specialist role: ${role}`);
  }
  if (
    JSON.stringify(plan.specialists) !==
    JSON.stringify([...plan.specialists].sort())
  )
    throw new TypeError(
      "Orchestration plan specialist roles must be canonical",
    );
  const ceilings = modePlan?.orchestration;
  if (!ceilings)
    throw new TypeError("Verified orchestration ceilings are required");
  if (plan.mode !== modePlan.resolvedMode)
    throw new TypeError("Orchestration plan mode does not match mode plan");
  boundedInteger(
    plan.maximumSpecialists,
    "maximumSpecialists",
    0,
    ceilings.maximumSpecialists,
  );
  boundedInteger(
    plan.specialists.length,
    "specialist count",
    0,
    plan.maximumSpecialists,
  );
  boundedInteger(
    plan.maximumConcurrency,
    "maximumConcurrency",
    0,
    ceilings.maximumConcurrency,
  );
  boundedInteger(plan.maximumTurns, "maximumTurns", 1, 32);
  boundedInteger(
    plan.maximumToolCalls,
    "maximumToolCalls",
    0,
    ceilings.maximumToolCalls,
  );
  boundedInteger(
    plan.maximumTokensPerAgent,
    "maximumTokensPerAgent",
    1,
    ceilings.maximumTokensPerAgent,
  );
  boundedInteger(
    plan.maximumTotalTokens,
    "maximumTotalTokens",
    plan.maximumTokensPerAgent,
    ceilings.maximumTotalTokens,
  );
  boundedInteger(
    plan.maximumOutputBytesPerAgent,
    "maximumOutputBytesPerAgent",
    1,
    ceilings.maximumOutputBytes,
  );
  boundedInteger(
    plan.maximumOutputBytes,
    "maximumOutputBytes",
    1,
    ceilings.maximumOutputBytes,
  );
  boundedInteger(plan.deadlineMs, "deadlineMs", 1, 900000);
  boundedInteger(plan.maximumAttempts, "maximumAttempts", 1, 5);
  boundedInteger(
    plan.maximumRepairRounds,
    "maximumRepairRounds",
    0,
    ceilings.maximumAutomaticRepairRounds,
  );
  if (
    !ceilings.enabled &&
    (plan.specialists.length > 0 ||
      plan.maximumConcurrency > 0 ||
      plan.maximumToolCalls > 0 ||
      plan.maximumRepairRounds > 0)
  )
    throw new TypeError("Disabled orchestration requires a manager-only plan");
  if (
    !ceilings.enabled &&
    (plan.maximumTurns !== 1 || plan.maximumAttempts !== 1)
  )
    throw new TypeError(
      "Disabled orchestration requires one turn and one attempt",
    );
  if (plan.maximumConcurrency > plan.specialists.length)
    throw new TypeError("maximumConcurrency exceeds selected specialists");
  if (
    plan.maximumTotalTokens <
    plan.maximumTokensPerAgent * (plan.specialists.length + 1)
  )
    throw new TypeError(
      "maximumTotalTokens does not cover every selected agent",
    );
  if (
    plan.maximumOutputBytes <
    plan.maximumOutputBytesPerAgent * (plan.specialists.length + 1)
  )
    throw new TypeError(
      "maximumOutputBytes does not cover every selected agent",
    );
  if (plan.credentialStage !== "coordinator")
    throw new TypeError(
      "Orchestration plan credentialStage must be coordinator",
    );
  exactObject(
    plan.appPermissions,
    "Orchestration plan appPermissions",
    PERMISSION_KEYS,
  );
  for (const key of PERMISSION_KEYS) {
    if (plan.appPermissions[key] !== modePlan.appPermissions[key])
      throw new TypeError(
        `Orchestration plan ${key} permission does not match mode plan`,
      );
  }
  exactObject(plan.bindings, "Orchestration plan bindings", BINDING_KEYS);
  for (const key of BINDING_KEYS) {
    if (
      typeof plan.bindings[key] !== "string" ||
      !DIGEST.test(plan.bindings[key])
    )
      throw new TypeError(
        `Orchestration plan ${key} binding must be a SHA-256 digest`,
      );
    if (bindings && plan.bindings[key] !== bindings[key])
      throw new TypeError(`Orchestration plan ${key} binding is stale`);
  }
  return deepFreeze(structuredClone(plan));
}

export function createOrchestrationPlan({
  modePlan,
  bindings,
  specialists = [],
  maximumSpecialists = modePlan?.orchestration?.maximumSpecialists,
  maximumConcurrency = specialists.length === 0 ? 0 : 1,
  maximumTurns = 1,
  maximumToolCalls = specialists.length === 0
    ? 0
    : modePlan?.orchestration?.maximumToolCalls,
  maximumTokensPerAgent = modePlan?.orchestration?.maximumTokensPerAgent,
  maximumTotalTokens = modePlan?.orchestration?.maximumTotalTokens,
  maximumOutputBytes = modePlan?.orchestration?.maximumOutputBytes,
  maximumOutputBytesPerAgent = Math.floor(
    maximumOutputBytes / (specialists.length + 1),
  ),
  deadlineMs = 900000,
  maximumAttempts = 1,
  maximumRepairRounds = 0,
}) {
  return assertOrchestrationPlan(
    {
      schemaVersion: ORCHESTRATION_PLAN_SCHEMA_VERSION,
      mode: modePlan.resolvedMode,
      manager: ORCHESTRATION_MANAGERS[modePlan.resolvedMode],
      specialists: [...specialists].sort(),
      maximumSpecialists,
      maximumConcurrency,
      maximumTurns,
      maximumToolCalls,
      maximumTokensPerAgent,
      maximumTotalTokens,
      maximumOutputBytesPerAgent,
      maximumOutputBytes,
      deadlineMs,
      maximumAttempts,
      maximumRepairRounds,
      credentialStage: "coordinator",
      appPermissions: { ...modePlan.appPermissions },
      bindings: { ...bindings },
    },
    { modePlan, bindings },
  );
}

export function orchestrationPlanBytes(plan, options) {
  return Buffer.from(canonical(assertOrchestrationPlan(plan, options)), "utf8");
}

export function orchestrationPlanSha256(plan, options) {
  return sha256(orchestrationPlanBytes(plan, options));
}

export function orchestrationPlanBindings({
  modePlanBytes,
  policyBytes,
  packageIdentity,
  repository,
  contextBytes,
  head,
}) {
  exactObject(packageIdentity, "Package identity", [
    "name",
    "version",
    "integrity",
    "sourceCommit",
  ]);
  return Object.freeze({
    modePlan: sha256(modePlanBytes),
    policy: sha256(policyBytes),
    package: sha256(Buffer.from(JSON.stringify(packageIdentity), "utf8")),
    repository: sha256(Buffer.from(repository, "utf8")),
    context: sha256(contextBytes),
    head: sha256(Buffer.from(head, "utf8")),
  });
}

export function parseOrchestrationPlan(value, options) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError(`Invalid orchestration-plan JSON: ${error.message}`);
  }
  const plan = assertOrchestrationPlan(parsed, options);
  if (Buffer.compare(bytes, orchestrationPlanBytes(plan, options)) !== 0)
    throw new TypeError("Orchestration plan is not canonical");
  return plan;
}

export function assertProviderSettingsWithinPlan(plan, settings) {
  exactObject(settings, "Provider settings", ["maxTurns", "maximumAttempts"]);
  boundedInteger(settings.maxTurns, "Provider maxTurns", 1, 32);
  boundedInteger(settings.maximumAttempts, "Provider maximumAttempts", 1, 5);
  if (
    settings.maxTurns > plan.maximumTurns ||
    settings.maximumAttempts > plan.maximumAttempts
  )
    throw new TypeError("Provider settings exceed orchestration-plan ceilings");
  return Object.freeze({ ...settings });
}
