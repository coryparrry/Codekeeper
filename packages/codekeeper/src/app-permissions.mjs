import { InstallerError } from "./errors.mjs";
import { MODE_REGISTRY, modeForId } from "./mode-registry.mjs";

export const APP_PERMISSION_VALUES = Object.freeze(["read", "write"]);

function permissions(contents, issues, pullRequests) {
  return Object.freeze({ contents, issues, pullRequests });
}

const WORKFLOW_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(MODE_REGISTRY).map(([mode, definition]) => [mode, permissions(
  definition.appPermissions.contents,
  definition.appPermissions.issues,
  definition.appPermissions.pullRequests
)])));

function capabilitySet(capabilities) {
  return new Set(
    Array.isArray(capabilities)
      ? capabilities
      : Object.entries(capabilities ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([id]) => id)
  );
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

export function workflowAppPermissions(mode, policy = null) {
  const normalizedMode = modeForId(mode)?.id;
  const defaults = normalizedMode ? WORKFLOW_DEFAULTS[normalizedMode] : null;
  if (!defaults) throw new InstallerError(`Unknown mode: ${mode}`, { code: "PLAN_INVALID" });
  if (!policy) return defaults;
  const definition = MODE_REGISTRY[normalizedMode];
  for (const rule of definition.rules.permissionEscalations) {
    if (policyValue(policy, rule.policyPath) === rule.value) {
      return permissions(
        rule.permissions.contents,
        rule.permissions.issues,
        rule.permissions.pullRequests,
      );
    }
  }
  return defaults;
}

export function assistantAppPermissions(modes, policy = null) {
  const selected = new Set(modes.map((mode) => modeForId(mode)?.id ?? mode));
  const ownerRequests = policy?.automation?.ownerRequests ?? true;
  if (ownerRequests !== true) return permissions("read", "read", "read");
  const dispatchable = [...selected].some(
    (mode) => MODE_REGISTRY[mode]?.rules.assistantDispatch === true,
  );
  return permissions(dispatchable ? "write" : "read", "write", "write");
}

export function registrationAppPermissions({ modes, capabilities, ownerRequests = true }) {
  const enabled = capabilitySet(capabilities);
  const selected = new Set(modes);
  const grants = [...selected].map((mode) => workflowAppPermissions(mode, {
    audit: { repair: { enabled: enabled.has("repair") } },
    review: { autoRepair: enabled.has("reviewRepair") }
  }));
  grants.push(assistantAppPermissions(modes, {
    automation: { ownerRequests }
  }));

  // Preserve fail-closed registration authority for inconsistent direct API
  // calls. Normal installer plans permit these capabilities only with Fixer.
  if (enabled.has("reviewRepair") || enabled.has("issueImplementation")) {
    grants.push(permissions("write", "read", "write"));
  }
  if (enabled.has("autoMerge")) grants.push(permissions("read", "read", "write"));

  const union = (name) => grants.some((grant) => grant[name] === "write") ? "write" : "read";
  return Object.freeze({
    contents: union("contents"),
    issues: union("issues"),
    pullRequests: union("pullRequests"),
    metadata: "read"
  });
}
