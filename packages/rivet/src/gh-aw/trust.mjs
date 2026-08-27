function sameValues(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function assessPullRequestTargetTrust({
  authority,
  expectedImports = [],
  expectedLocalActions = [],
}) {
  const violations = [];
  if (!sameValues(authority.triggers, ["pull_request_target"])) {
    violations.push("workflow must use only pull_request_target");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  if (authority.manifest.has_pull_request_target !== true) {
    violations.push("compiler manifest must record pull_request_target");
  }
  if (!authority.inlinedImports) {
    violations.push("workflow and native imports must be inlined");
  }
  if (!sameValues(authority.resolvedImports, expectedImports)) {
    violations.push(
      "resolved native imports differ from the approved inventory",
    );
  }
  if (authority.runtimeImports.length > 0) {
    violations.push("runtime prompt imports are not allowed");
  }
  if (authority.unpinnedActions.length > 0) {
    violations.push("all actions must use immutable commit pins");
  }
  if (authority.unpinnedContainers.length > 0) {
    violations.push("all containers must use immutable digest pins");
  }
  if (!sameValues(authority.localActions, expectedLocalActions)) {
    violations.push("local actions differ from the approved inventory");
  }
  if (authority.additionalRepositories.length > 0) {
    violations.push("additional repository checkouts are not allowed");
  }
  if (
    authority.checkouts.length === 0 ||
    authority.checkouts.some(
      ({ repository, ref, path, persistCredentials }) =>
        repository !== null ||
        ref !== null ||
        path !== null ||
        persistCredentials !== false,
    )
  ) {
    violations.push(
      "checkouts must use the base context without persisted credentials",
    );
  }
  return Object.freeze({
    trusted: violations.length === 0,
    baseContext: "pull_request_target default branch",
    violations: Object.freeze(violations),
  });
}
