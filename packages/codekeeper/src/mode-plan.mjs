import {
  COMMAND_MODE_MAP,
  MODES,
  modeForId,
  POLICY_AGENT_TO_MODE,
} from "./mode-registry.mjs";

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
const EVENT_CONTEXT_KEYS = new Set([
  "eventName",
  "command",
  "action",
  "targetNumber",
  "dryRun",
]);
const POLICY_CONTEXT_KEYS = new Set([
  "candidateRequiresValidation",
  "publicationEnabled",
  "dryRun",
  "readyLabelFix",
]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function copy(value) {
  return Array.isArray(value) ? [...value] : { ...value };
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
  return Object.freeze({
    candidateRequiresValidation: policy.candidateRequiresValidation,
    publicationEnabled: policy.publicationEnabled,
    dryRun: policy.dryRun === true,
    readyLabelFix: policy.readyLabelFix === true,
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
    if (!Object.hasOwn(COMMAND_MODE_MAP, event.command)) {
      throw new TypeError(`Unknown mode command: ${event.command}`);
    }
    const resolved = COMMAND_MODE_MAP[event.command];
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
    return (
      Object.hasOwn(COMMAND_MODE_MAP, event.command) &&
      COMMAND_MODE_MAP[event.command] === mode.id
    );
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
  if (
    eventContext.command &&
    !Object.hasOwn(COMMAND_MODE_MAP, eventContext.command)
  ) {
    throw new TypeError(`Unknown mode command: ${eventContext.command}`);
  }
  if (
    normalizedRequestedMode !== "auto" &&
    eventContext.command &&
    COMMAND_MODE_MAP[eventContext.command] !== resolvedMode
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
    appPermissions: copy(mode.appPermissions),
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
