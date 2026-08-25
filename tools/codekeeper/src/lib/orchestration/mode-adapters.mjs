import {
  prepareAudit,
  prepareFix,
  prepareIssue,
  prepareReview,
} from "../prepare.mjs";
import {
  publishAudit,
  publishFix,
  publishIssue,
  publishReview,
} from "../publish.mjs";
import {
  sealAudit,
  sealFix,
  sealIssue,
  sealReview,
  validateAudit,
  validateFix,
  validateIssue,
  validateReview,
  verifyAudit,
  verifyFix,
} from "../validate.mjs";

const PERMISSION_VALUES = new Set(["read", "write"]);
const TRIGGER_VALUES = new Set([
  "pull-request",
  "issue",
  "schedule",
  "manual",
  "owner-command",
]);
const WORKSPACE_ACCESS_VALUES = new Set(["none", "read", "write"]);
const MODE_ALIASES = Object.freeze({ issue: "issues", audit: "maintain" });
const ORCHESTRATION_KEYS = [
  "enabled",
  "providerMultiAgent",
  "maximumSpecialists",
  "maximumConcurrency",
  "maximumToolCalls",
  "maximumTokensPerAgent",
  "maximumTotalTokens",
  "maximumOutputBytes",
  "maximumAutomaticRepairRounds",
];
const ORCHESTRATION_MAXIMUMS = Object.freeze({
  maximumSpecialists: 4,
  maximumConcurrency: 3,
  maximumToolCalls: 6,
  maximumTokensPerAgent: 32000,
  maximumTotalTokens: 96000,
  maximumOutputBytes: 262144,
  maximumAutomaticRepairRounds: 1,
});

// These are the closed semantic invariants of the package registry. The
// resolver remains the source of the plan; this table only prevents a
// tampered plan from changing a stage boundary after resolution.
const CANONICAL_SEMANTICS = Object.freeze({
  review: Object.freeze({
    workspaceAccess: "read",
    validationRequired: false,
    requiredGate: true,
    appPermissions: Object.freeze({
      contents: "read",
      issues: "write",
      pullRequests: "write",
    }),
  }),
  issues: Object.freeze({
    workspaceAccess: "none",
    validationRequired: false,
    requiredGate: false,
    appPermissions: Object.freeze({
      contents: "read",
      issues: "write",
      pullRequests: "read",
    }),
  }),
  maintain: Object.freeze({
    workspaceAccess: "write",
    validationRequired: true,
    requiredGate: false,
    appPermissions: Object.freeze({
      contents: "read",
      issues: "write",
      pullRequests: "read",
    }),
  }),
  fix: Object.freeze({
    workspaceAccess: "write",
    validationRequired: true,
    requiredGate: false,
    appPermissions: Object.freeze({
      contents: "write",
      issues: "write",
      pullRequests: "write",
    }),
  }),
});

const ADAPTERS = Object.freeze({
  review: Object.freeze({
    mode: "review",
    publicationAdapter: "review",
    prepare: prepareReview,
    validate: validateReview,
    seal: sealReview,
    publish: publishReview,
  }),
  issues: Object.freeze({
    mode: "issues",
    publicationAdapter: "issue",
    prepare: prepareIssue,
    validate: validateIssue,
    seal: sealIssue,
    publish: publishIssue,
  }),
  maintain: Object.freeze({
    mode: "maintain",
    publicationAdapter: "audit",
    prepare: prepareAudit,
    validate: validateAudit,
    verify: verifyAudit,
    seal: sealAudit,
    publish: publishAudit,
  }),
  fix: Object.freeze({
    mode: "fix",
    publicationAdapter: "fix",
    prepare: prepareFix,
    validate: validateFix,
    verify: verifyFix,
    seal: sealFix,
    publish: publishFix,
  }),
});

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function canonicalMode(mode) {
  const normalized = String(mode ?? "")
    .trim()
    .toLowerCase();
  const canonical = MODE_ALIASES[normalized] ?? normalized;
  if (!ADAPTERS[canonical]) throw new Error(`Unknown Codekeeper mode: ${mode}`);
  return canonical;
}

function assertPermissions(permissions) {
  plainObject(permissions, "Mode-plan appPermissions");
  const keys = Object.keys(permissions).sort();
  if (keys.join(",") !== "contents,issues,pullRequests") {
    throw new TypeError(
      "Mode-plan appPermissions must contain the three GitHub permission keys",
    );
  }
  for (const value of Object.values(permissions)) {
    if (!PERMISSION_VALUES.has(value))
      throw new TypeError(
        "Mode-plan appPermissions contains an invalid permission",
      );
  }
}

function assertOrchestration(value, mode, config) {
  if (value === null) {
    if (config?.ai?.orchestration)
      throw new Error("Mode plan is missing orchestration policy bindings");
    return null;
  }
  plainObject(value, "Mode-plan orchestration");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== [...ORCHESTRATION_KEYS].sort().join(",")) {
    throw new TypeError("Mode-plan orchestration has an invalid key set");
  }
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.providerMultiAgent !== "boolean"
  )
    throw new TypeError("Mode-plan orchestration flags must be booleans");
  for (const [key, maximum] of Object.entries(ORCHESTRATION_MAXIMUMS)) {
    const minimum = key === "maximumAutomaticRepairRounds" ? 0 : 1;
    if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < minimum ||
      value[key] > maximum
    )
      throw new TypeError(
        `Mode-plan orchestration ${key} must be an integer from ${minimum} to ${maximum}`,
      );
  }
  if (
    value.maximumConcurrency > value.maximumSpecialists ||
    value.maximumTotalTokens <
      value.maximumTokensPerAgent * value.maximumConcurrency
  )
    throw new TypeError("Mode-plan orchestration ceilings are inconsistent");
  const policy = config?.ai?.orchestration;
  if (policy) {
    const expected = {
      ...Object.fromEntries(
        ORCHESTRATION_KEYS.filter(
          (key) => !["enabled", "providerMultiAgent"].includes(key),
        ).map((key) => [key, policy[key]]),
      ),
      enabled: policy.enabled && policy.modes[mode],
      providerMultiAgent: policy.providerMultiAgent,
    };
    for (const key of ORCHESTRATION_KEYS) {
      if (value[key] !== expected[key])
        throw new Error(`Mode plan orchestration ${key} does not match policy`);
    }
  }
  return Object.freeze({ ...value });
}

/**
 * Validate the closed, package-produced mode plan before any adapter is run.
 * Runtime code intentionally consumes this artifact instead of re-resolving
 * routing from mutable workflow inputs.
 */
export function assertVerifiedModePlan(
  plan,
  expectedMode = undefined,
  { config } = {},
) {
  plainObject(plan, "Mode plan");
  const allowed = new Set([
    "schemaVersion",
    "requestedMode",
    "resolvedMode",
    "trigger",
    "targetNumber",
    "workspaceAccess",
    "validationRequired",
    "publicationRequired",
    "requiredGate",
    "publicationAdapter",
    "appPermissions",
    "orchestration",
  ]);
  const unknown = Object.keys(plan).filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !Object.hasOwn(plan, key));
  if (unknown.length)
    throw new TypeError(
      `Mode plan contains unknown properties: ${unknown.join(", ")}`,
    );
  if (missing.length)
    throw new TypeError(
      `Mode plan is missing required properties: ${missing.join(", ")}`,
    );
  if (plan.schemaVersion !== 1)
    throw new TypeError("Unsupported mode-plan schema version");
  if (typeof plan.requestedMode !== "string" || !plan.requestedMode.trim()) {
    throw new TypeError("Mode-plan requestedMode must be a non-empty string");
  }
  if (!TRIGGER_VALUES.has(plan.trigger))
    throw new TypeError("Mode-plan trigger is invalid");
  if (!WORKSPACE_ACCESS_VALUES.has(plan.workspaceAccess)) {
    throw new TypeError("Mode-plan workspaceAccess is invalid");
  }
  const mode = canonicalMode(plan.resolvedMode);
  if (expectedMode !== undefined && mode !== canonicalMode(expectedMode)) {
    throw new Error(`Mode plan resolves to ${mode}; expected ${expectedMode}`);
  }
  if (
    typeof plan.validationRequired !== "boolean" ||
    typeof plan.publicationRequired !== "boolean" ||
    typeof plan.requiredGate !== "boolean"
  ) {
    throw new TypeError("Mode plan stage requirements must be booleans");
  }
  if (plan.publicationAdapter !== ADAPTERS[mode].publicationAdapter) {
    throw new Error(`Mode plan publication adapter does not match ${mode}`);
  }
  const semantics = CANONICAL_SEMANTICS[mode];
  if (plan.workspaceAccess !== semantics.workspaceAccess) {
    throw new Error(`Mode plan workspaceAccess does not match ${mode}`);
  }
  if (plan.validationRequired !== semantics.validationRequired) {
    throw new Error(`Mode plan validationRequired does not match ${mode}`);
  }
  if (plan.requiredGate !== semantics.requiredGate) {
    throw new Error(`Mode plan requiredGate does not match ${mode}`);
  }
  assertPermissions(plan.appPermissions);
  const expectedPermissions = { ...semantics.appPermissions };
  if (mode === "review" && config?.review?.autoRepair === true)
    expectedPermissions.contents = "write";
  if (mode === "maintain" && config?.audit?.repair?.enabled === true) {
    expectedPermissions.contents = "write";
    expectedPermissions.pullRequests = "write";
  }
  for (const key of Object.keys(expectedPermissions)) {
    const expected = expectedPermissions[key];
    if (plan.appPermissions[key] !== expected) {
      throw new Error(`Mode plan ${key} permission does not match ${mode}`);
    }
  }
  if (
    plan.targetNumber !== null &&
    plan.targetNumber !== undefined &&
    (!Number.isSafeInteger(plan.targetNumber) || plan.targetNumber < 1)
  ) {
    throw new TypeError(
      "Mode plan targetNumber must be a positive integer or null",
    );
  }
  return Object.freeze({
    ...plan,
    resolvedMode: mode,
    appPermissions: Object.freeze({ ...plan.appPermissions }),
    orchestration: assertOrchestration(plan.orchestration, mode, config),
  });
}

export function modeAdapter(mode) {
  return ADAPTERS[canonicalMode(mode)];
}

export function canonicalAdapterMode(mode) {
  return canonicalMode(mode);
}
