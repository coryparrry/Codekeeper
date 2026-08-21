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

export function resolveModeAppPermissions(mode, policy = {}) {
  const defaults = Object.freeze({ ...mode.appPermissions });
  for (const rule of mode.rules.permissionEscalations) {
    if (policyValue(policy, rule.policyPath) === rule.value) {
      return Object.freeze({ ...rule.permissions });
    }
  }
  return defaults;
}
