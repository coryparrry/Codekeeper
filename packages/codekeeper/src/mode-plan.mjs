import {
  commandExists,
  commandModeForSurface,
  MODES,
  modeForId,
  POLICY_AGENT_TO_MODE,
} from "./mode-registry.mjs";
import {
  assertExactKeys,
  COMMAND_SURFACE_VALUES,
} from "./mode-registry-schema.mjs";
import { resolveModeAppPermissions } from "./mode-permissions.mjs";

const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SUPPORTED_EVENT_NAMES = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "schedule",
  "workflow_dispatch",
  "repository_dispatch",
]);
const PULL_REQUEST_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);
const ISSUE_EVENTS = new Set(["issues", "issue_comment"]);
const OWNER_COMMAND_SURFACES_BY_EVENT = Object.freeze({
  issues: new Set(["issue"]),
  issue_comment: new Set(["issue", "pull-request", "review-thread"]),
  pull_request: new Set(["pull-request"]),
  pull_request_review: new Set(["pull-request"]),
  pull_request_review_comment: new Set(["review-thread"]),
  schedule: new Set(),
  workflow_dispatch: new Set(),
  repository_dispatch: new Set(),
});
const EVENT_CONTEXT_KEYS = new Set([
  "eventName",
  "command",
  "surface",
  "action",
  "targetNumber",
  "dryRun",
]);
const POLICY_CONTEXT_KEYS = new Set([
  "candidateRequiresValidation",
  "publicationEnabled",
  "dryRun",
  "readyLabelFix",
  "review",
  "audit",
]);
const REVIEW_POLICY_KEYS = new Set(["autoRepair"]);
const AUDIT_POLICY_KEYS = new Set(["repair"]);
const REPAIR_POLICY_KEYS = new Set(["enabled"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain object prototype.`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const dangerous = unknown.find((key) => DANGEROUS_KEYS.has(key));
  if (dangerous)
    throw new TypeError(`${label} contains forbidden property: ${dangerous}`);
  if (unknown.length)
    throw new TypeError(
      `${label} contains unknown properties: ${unknown.join(", ")}`,
    );
}

function validTargetNumber(value) {
  if (value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(
        "Mode-plan target number must be a positive safe integer.",
      );
    }
    return value;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(
      "Mode-plan target number must be a canonical positive decimal.",
    );
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(
      "Mode-plan target number must be a positive safe integer.",
    );
  }
  return number;
}

function optionalString(value, label) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value ?? "";
}

function validateEventContext(event) {
  rejectUnknownKeys(event, EVENT_CONTEXT_KEYS, "Mode-plan event context");
  const eventName = optionalString(event.eventName, "Mode-plan event name")
    .trim()
    .toLowerCase();
  if (
    !eventName ||
    !EVENT_NAME_PATTERN.test(eventName) ||
    !SUPPORTED_EVENT_NAMES.has(eventName)
  )
    throw new TypeError("Mode-plan event name is invalid.");
  const command = optionalString(event.command, "Mode-plan command")
    .trim()
    .toLowerCase();
  if (command && !COMMAND_PATTERN.test(command))
    throw new TypeError("Mode-plan command is invalid.");
  const surface = event.surface;
  if (
    command &&
    (typeof surface !== "string" || !COMMAND_SURFACE_VALUES.has(surface))
  ) {
    throw new TypeError(
      "Mode-plan owner commands require a valid event surface.",
    );
  }
  if (command && !OWNER_COMMAND_SURFACES_BY_EVENT[eventName].has(surface)) {
    throw new TypeError(
      `Mode-plan owner command surface ${surface} is not valid for event ${eventName}.`,
    );
  }
  if (!command && surface !== undefined) {
    throw new TypeError("Mode-plan event surface requires an owner command.");
  }
  const trigger = triggerForEvent(eventName, command);
  const action = optionalString(event.action, "Mode-plan event action")
    .trim()
    .toLowerCase();
  if (event.dryRun !== undefined && typeof event.dryRun !== "boolean") {
    throw new TypeError("Mode-plan event dry-run flag must be boolean.");
  }
  return Object.freeze({
    eventName,
    command,
    surface,
    action,
    trigger,
    targetNumber: validTargetNumber(event.targetNumber),
    dryRun: event.dryRun === true,
  });
}

function validatePolicyContext(policy) {
  rejectUnknownKeys(policy, POLICY_CONTEXT_KEYS, "Mode-plan policy context");
  if (
    policy.candidateRequiresValidation !== undefined &&
    typeof policy.candidateRequiresValidation !== "boolean"
  ) {
    throw new TypeError(
      "Mode-plan candidate validation policy must be boolean.",
    );
  }
  if (
    policy.publicationEnabled !== undefined &&
    typeof policy.publicationEnabled !== "boolean"
  ) {
    throw new TypeError("Mode-plan publication policy must be boolean.");
  }
  if (policy.dryRun !== undefined && typeof policy.dryRun !== "boolean") {
    throw new TypeError("Mode-plan dry-run policy must be boolean.");
  }
  if (
    policy.readyLabelFix !== undefined &&
    typeof policy.readyLabelFix !== "boolean"
  ) {
    throw new TypeError("Mode-plan ready-label fix policy must be boolean.");
  }
  if (policy.review !== undefined) {
    assertExactKeys(
      policy.review,
      REVIEW_POLICY_KEYS,
      "Mode-plan review policy",
    );
    if (typeof policy.review.autoRepair !== "boolean") {
      throw new TypeError(
        "Mode-plan review auto-repair policy must be boolean.",
      );
    }
  }
  if (policy.audit !== undefined) {
    assertExactKeys(policy.audit, AUDIT_POLICY_KEYS, "Mode-plan audit policy");
    assertExactKeys(
      policy.audit.repair,
      REPAIR_POLICY_KEYS,
      "Mode-plan audit repair policy",
    );
    if (typeof policy.audit.repair.enabled !== "boolean") {
      throw new TypeError("Mode-plan audit repair policy must be boolean.");
    }
  }
  return Object.freeze({
    candidateRequiresValidation: policy.candidateRequiresValidation,
    publicationEnabled: policy.publicationEnabled,
    dryRun: policy.dryRun === true,
    readyLabelFix: policy.readyLabelFix === true,
    review:
      policy.review === undefined
        ? undefined
        : Object.freeze({ autoRepair: policy.review.autoRepair }),
    audit:
      policy.audit === undefined
        ? undefined
        : Object.freeze({
            repair: Object.freeze({ enabled: policy.audit.repair.enabled }),
          }),
  });
}

function triggerForEvent(eventName, command) {
  if (command) return "owner-command";
  if (PULL_REQUEST_EVENTS.has(eventName)) return "pull-request";
  if (ISSUE_EVENTS.has(eventName)) return "issue";
  if (eventName === "schedule") return "schedule";
  if (eventName === "workflow_dispatch" || eventName === "repository_dispatch")
    return "manual";
  throw new TypeError(`Unsupported automatic event: ${eventName}`);
}

function policyValue(policy, path) {
  let current = policy;
  for (const segment of path) {
    if (
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function matchingRoutes(event, policy) {
  return Object.values(MODES).filter((mode) =>
    mode.automatic.routes.some(
      (route) =>
        route.event === event.eventName &&
        policyValue(policy, route.policyPath) === route.value,
    ),
  );
}

function defaultRoutes(event) {
  return Object.values(MODES).filter(
    (mode) =>
      mode.automatic.enabled &&
      mode.automatic.triggers.includes(event.eventName) &&
      mode.automatic.defaultRoute === mode.id,
  );
}

function commandMode(event) {
  if (event.command) {
    if (!commandExists(event.command)) {
      throw new TypeError(`Unknown mode command: ${event.command}`);
    }
    const resolved = commandModeForSurface(event.command, event.surface);
    if (!resolved) {
      throw new TypeError(
        `Command ${event.command} is unavailable on surface ${event.surface}.`,
      );
    }
    const defaults = defaultRoutes(event);
    if (
      defaults.length === 1 &&
      defaults[0].id !== resolved &&
      !defaults[0].automatic.commandOverrideTargets.includes(resolved)
    ) {
      throw new TypeError(
        `Command ${event.command} has an ambiguous event route.`,
      );
    }
    return resolved;
  }
  return null;
}

function automaticMode(event, policy) {
  const routedCommand = commandMode(event);
  if (routedCommand) return routedCommand;
  const routes = matchingRoutes(event, policy);
  if (routes.length > 1) {
    throw new TypeError("Auto mode has ambiguous registry event routes.");
  }
  if (routes.length === 1) return routes[0].id;
  const defaults = defaultRoutes(event);
  if (defaults.length > 1) {
    throw new TypeError("Auto mode has ambiguous registry default routes.");
  }
  if (defaults.length === 1) return defaults[0].id;
  throw new TypeError(
    "Auto mode requires an unambiguous validated mode route.",
  );
}

function modeAuthorizesEvent(mode, event, policy) {
  if (event.command)
    return commandModeForSurface(event.command, event.surface) === mode.id;
  if (event.eventName === "workflow_dispatch") return mode.manual === true;
  const routes = matchingRoutes(event, policy);
  if (routes.length > 1) {
    throw new TypeError("Mode-plan event has ambiguous registry routes.");
  }
  if (routes.length === 1) return routes[0].id === mode.id;
  const defaults = defaultRoutes(event);
  return defaults.length === 1 && defaults[0].id === mode.id;
}

function normalizeRequestedMode(requestedMode) {
  const normalized = String(requestedMode ?? "auto")
    .trim()
    .toLowerCase();
  if (normalized === "auto") return normalized;
  if (!modeForId(normalized))
    throw new TypeError(`Unknown mode: ${requestedMode}`);
  return normalized;
}

export function resolveModePlan(input = {}) {
  rejectUnknownKeys(
    input,
    new Set(["requestedMode", "event", "policy"]),
    "Mode-plan input",
  );
  const { requestedMode = "auto", event = {}, policy = {} } = input;
  if (typeof requestedMode !== "string") {
    throw new TypeError("Mode-plan requested mode must be a string.");
  }
  const eventContext = validateEventContext(event);
  const policyContext = validatePolicyContext(policy);
  const normalizedRequestedMode = normalizeRequestedMode(requestedMode);
  const resolvedMode =
    normalizedRequestedMode === "auto"
      ? automaticMode(eventContext, policyContext)
      : Object.hasOwn(POLICY_AGENT_TO_MODE, normalizedRequestedMode)
        ? POLICY_AGENT_TO_MODE[normalizedRequestedMode]
        : normalizedRequestedMode;
  const mode = MODES[resolvedMode];
  if (eventContext.command && !commandExists(eventContext.command)) {
    throw new TypeError(`Unknown mode command: ${eventContext.command}`);
  }
  if (
    eventContext.command &&
    !commandModeForSurface(eventContext.command, eventContext.surface)
  ) {
    throw new TypeError(
      `Command ${eventContext.command} is unavailable on surface ${eventContext.surface}.`,
    );
  }
  if (
    normalizedRequestedMode !== "auto" &&
    eventContext.command &&
    commandModeForSurface(eventContext.command, eventContext.surface) !==
      resolvedMode
  ) {
    throw new TypeError(
      `Command ${eventContext.command} does not target mode ${resolvedMode}.`,
    );
  }
  if (!modeAuthorizesEvent(mode, eventContext, policyContext)) {
    throw new TypeError(
      `Mode ${resolvedMode} is not authorized for event ${eventContext.eventName}.`,
    );
  }
  const validationRequired =
    mode.stages.validation === "always" ||
    (mode.stages.validation === "when-candidate-requires-validation" &&
      (policyContext.candidateRequiresValidation ??
        mode.workspace.access === "write"));
  const publicationRequired =
    mode.stages.publication === "always" ||
    (mode.stages.publication === "when-live" &&
      !eventContext.dryRun &&
      !policyContext.dryRun &&
      policyContext.publicationEnabled !== false);
  return deepFreeze({
    schemaVersion: 1,
    requestedMode: normalizedRequestedMode,
    resolvedMode,
    trigger: eventContext.trigger,
    targetNumber: eventContext.targetNumber,
    workspaceAccess: mode.workspace.access,
    validationRequired,
    publicationRequired,
    requiredGate: mode.requiredGate,
    publicationAdapter: mode.publicationAdapter,
    appPermissions: resolveModeAppPermissions(mode, policyContext),
  });
}

export const MODE_PLAN_KEYS = Object.freeze([
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
]);
