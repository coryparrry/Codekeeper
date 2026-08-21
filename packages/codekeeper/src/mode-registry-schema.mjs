export const MODE_KEYS = new Set([
  "id",
  "label",
  "agentLabel",
  "description",
  "policyAgent",
  "agentProfile",
  "workspaceProvider",
  "workspace",
  "stages",
  "publicationAdapter",
  "appPermissions",
  "automatic",
  "manual",
  "concurrency",
  "supportedCommands",
  "requiredGate",
  "trigger",
  "target",
  "asset",
  "caller",
  "runtime",
  "rules",
]);
export const WORKSPACE_KEYS = new Set(["enabled", "access", "isolation"]);
export const STAGE_KEYS = new Set(["compute", "validation", "publication"]);
export const AUTOMATIC_KEYS = new Set([
  "enabled",
  "triggers",
  "defaultRoute",
  "routes",
  "commandOverrideTargets",
]);
export const ROUTE_KEYS = new Set(["event", "policyPath", "value"]);
export const CONCURRENCY_KEYS = new Set([
  "scope",
  "cancelAutomaticSupersededRuns",
]);
export const RULES_KEYS = new Set([
  "permissionEscalations",
  "assistantDispatch",
]);
export const PERMISSION_RULE_KEYS = new Set([
  "policyPath",
  "value",
  "permissions",
]);
export const CALLER_KEYS = new Set(["target", "asset"]);
export const RUNTIME_KEYS = new Set([
  "target",
  "asset",
  "sourcePath",
  "packagePath",
]);

export function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain object prototype.`);
  }
  return value;
}

export function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new TypeError(`${label} has an invalid key set.`);
  }
}
