import { InstallerError } from "./errors.mjs";

export const APP_PERMISSION_VALUES = Object.freeze(["read", "write"]);

function permissions(contents, issues, pullRequests) {
  return Object.freeze({ contents, issues, pullRequests });
}

const WORKFLOW_DEFAULTS = Object.freeze({
  assistant: permissions("write", "write", "write"),
  review: permissions("read", "write", "write"),
  maintain: permissions("read", "write", "read"),
  issues: permissions("read", "write", "read"),
  fix: permissions("write", "write", "write")
});

function capabilitySet(capabilities) {
  return new Set(
    Array.isArray(capabilities)
      ? capabilities
      : Object.entries(capabilities ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([id]) => id)
  );
}

export function workflowAppPermissions(mode, policy = null) {
  const defaults = WORKFLOW_DEFAULTS[mode];
  if (!defaults) throw new InstallerError(`Unknown mode: ${mode}`, { code: "PLAN_INVALID" });
  if (!policy) return defaults;
  if (mode === "review" && policy.review?.autoRepair === true) {
    return permissions("write", "write", "write");
  }
  if (mode === "maintain" && policy.audit?.repair?.enabled === true) {
    return permissions("write", "write", "write");
  }
  return defaults;
}

export function assistantAppPermissions(modes, policy = null) {
  const selected = new Set(modes);
  const ownerRequests = policy?.automation?.ownerRequests ?? true;
  if (ownerRequests !== true) return permissions("read", "read", "read");
  const dispatchable = ["review", "issues", "fix"].some((mode) => selected.has(mode));
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
