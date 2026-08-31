function sameValues(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function issueWriteJobsOnly(writeCapableJobs) {
  return (
    writeCapableJobs.length === 1 &&
    writeCapableJobs[0].job === "conclusion" &&
    JSON.stringify(writeCapableJobs[0].permissions) ===
      JSON.stringify({ actions: "write" })
  );
}

function issuePublisherOnly(actions, expectedScript) {
  const publisher = actions.filter(
    ({ job }) => job === "publish_triage_comment",
  );
  const token = publisher.find(
    ({ action }) => action === "actions/create-github-app-token",
  );
  const script = publisher.find(
    ({ action }) => action === "actions/github-script",
  );
  const tokenWith = token?.with ?? {};
  const scriptWith = script?.with ?? {};
  return (
    publisher.length === 3 &&
    sameValues(
      publisher.map(({ uses }) => uses),
      [
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
        "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
        "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3",
      ],
    ) &&
    Object.keys(tokenWith).length === 5 &&
    tokenWith["app-id"] === "${{ vars.RIVET_APP_CLIENT_ID }}" &&
    tokenWith["private-key"] === "${{ secrets.RIVET_APP_PRIVATE_KEY }}" &&
    tokenWith.owner === "${{ github.repository_owner }}" &&
    tokenWith.repositories === "${{ github.event.repository.name }}" &&
    tokenWith["permission-issues"] === "write" &&
    Object.keys(scriptWith).length === 2 &&
    scriptWith["github-token"] === "${{ steps.issue-token.outputs.token }}" &&
    scriptWith.script === `${expectedScript}\n`
  );
}

export function assessIssueTriageTrust({
  authority,
  expectedEngine,
  expectedImports = [],
  expectedModel,
  expectedPublisherScript,
}) {
  const violations = [];
  if (!sameValues(authority.triggers, ["issues"])) {
    violations.push("workflow must use only issues");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  if (
    authority.metadata.agent_id !== expectedEngine ||
    authority.metadata.agent_model !== expectedModel
  ) {
    violations.push("issue triage model differs from the configured model");
  }
  if (!authority.inlinedImports) {
    violations.push("issue triager import must be inlined");
  }
  if (!sameValues(authority.resolvedImports, expectedImports)) {
    violations.push("resolved native imports must contain only issue-triager");
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
  if (authority.localActions.length > 0) {
    violations.push("local actions are not allowed");
  }
  if (authority.additionalRepositories.length > 0) {
    violations.push("additional repository checkouts are not allowed");
  }
  if (
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
  if (!issueWriteJobsOnly(authority.writeCapableJobs)) {
    violations.push(
      "only conclusion may use workflow write authority for cancellation",
    );
  }
  if (!issuePublisherOnly(authority.actions, expectedPublisherScript)) {
    violations.push(
      "issue triage publisher must target only the triggering repository and issue",
    );
  }
  if (!sameValues(authority.safeOutputJobs, ["safe_outputs"])) {
    violations.push("issue triage must use only the safe_outputs publisher");
  }
  return Object.freeze({
    trusted: violations.length === 0,
    baseContext: "issues event default branch",
    violations: Object.freeze(violations),
  });
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
