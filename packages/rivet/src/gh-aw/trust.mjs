import { createHash } from "node:crypto";

const MAINTENANCE_SHARED_SECRETS = [
  "COPILOT_GITHUB_TOKEN",
  "GH_AW_GITHUB_MCP_SERVER_TOKEN",
  "GH_AW_GITHUB_TOKEN",
  "GITHUB_TOKEN",
];
const MAINTENANCE_PROVIDER_SECRETS = Object.freeze({
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  claude: ["ANTHROPIC_API_KEY"],
  copilot: [],
  gemini: ["GEMINI_API_KEY"],
});

// These hashes bind the complete compiled shape produced by the pinned gh-aw
// release. They are intentionally not derived from the candidate authority.
export const RIVET_MAINTENANCE_ACTIONS_SHA256 =
  "ad7df34683b3ab83e39cb0fce683600ce04877c42d4d80778def9d58d25c1ad5";
export const RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256 =
  "dcb9f93ac56879b15276b6cb780245b284ea25590ee5e299f7174063a80c3291";
export const RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256 =
  "74b5d1f0163c93c16b6a7a44aee902ba4f529433bdc0a08748cfad74184771dc";

function sameValues(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function maintenanceActionInventory(authority) {
  return {
    actions: (authority.actions ?? []).map(
      ({ env, if: condition, job, uses, with: actionWith }) => ({
        env: env ?? {},
        if: condition ?? null,
        job,
        uses,
        with: actionWith ?? {},
      }),
    ),
    scripts: authority.scripts ?? [],
  };
}

function maintenanceJobAuthorityInventory(authority) {
  return {
    jobs: authority.jobAuthority ?? {},
    workflowEnv: authority.workflowEnv ?? {},
  };
}

function maintenanceSecrets(expectedEngine) {
  const provider = MAINTENANCE_PROVIDER_SECRETS[expectedEngine];
  if (!provider) return null;
  return [...new Set([...MAINTENANCE_SHARED_SECRETS, ...provider])].sort();
}

export function assessMaintenanceTrust({
  authority,
  expectedEngine,
  expectedImports = [],
  expectedModel,
  expectedTriggers = [],
  expectedActionsSha256 = RIVET_MAINTENANCE_ACTIONS_SHA256,
  expectedJobConditionsSha256 = RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256,
  expectedJobAuthoritySha256 = RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256,
  expectedSecrets,
  expectedLocalActions = [],
}) {
  const violations = [];
  if (!sameValues(authority.triggers, expectedTriggers)) {
    violations.push("maintenance trigger differs from the approved inventory");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  if (
    authority.metadata.agent_id !== expectedEngine ||
    authority.metadata.agent_model !== expectedModel
  ) {
    violations.push("maintenance model differs from the configured model");
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
  if (!sameValues(authority.safeOutputJobs, [])) {
    violations.push("maintenance cannot use a generic safe-output publisher");
  }
  if (JSON.stringify(authority.permissions) !== JSON.stringify({})) {
    violations.push("maintenance root permissions must remain empty");
  }
  const approvedSecrets = expectedSecrets ?? maintenanceSecrets(expectedEngine);
  if (
    !approvedSecrets ||
    !sameValues(authority.secrets, approvedSecrets) ||
    !sameValues(authority.manifestSecrets, approvedSecrets)
  ) {
    violations.push("maintenance secrets differ from the approved inventory");
  }
  if (
    authority.safeOutputConfig !== null ||
    authority.safeOutputSettings?.reportIncompleteCreateIssue !== "false" ||
    authority.safeOutputSettings?.failureReportAsIssue !== "false" ||
    authority.safeOutputSettings?.noopReportAsIssue !== "false" ||
    authority.safeOutputSettings?.missingDataReportAsFailure !== "true" ||
    authority.safeOutputSettings?.missingToolReportAsFailure !== "true"
  ) {
    violations.push(
      "maintenance safe outputs must disable missing data, missing tools, and issue reporting",
    );
  }
  if (authority.additionalRepositories.length > 0) {
    violations.push("additional repository checkouts are not allowed");
  }
  if (
    authority.checkouts.length === 0 ||
    authority.checkouts.some(
      ({ repository, ref, path, persistCredentials }) =>
        repository !== null ||
        (ref !== null &&
          ref !== "refs/heads/${{ github.event.repository.default_branch }}" &&
          ref !== "${{ github.sha }}") ||
        path !== null ||
        persistCredentials !== false,
    )
  ) {
    violations.push(
      "checkouts must use the default branch without persisted credentials",
    );
  }
  if (!issueWriteJobsOnly(authority.writeCapableJobs)) {
    violations.push(
      "only conclusion may use workflow write authority for cancellation",
    );
  }
  if (
    !expectedActionsSha256 ||
    digest(maintenanceActionInventory(authority)) !== expectedActionsSha256
  ) {
    violations.push("maintenance actions differ from the approved inventory");
  }
  if (
    !expectedJobConditionsSha256 ||
    digest(authority.jobConditions ?? {}) !== expectedJobConditionsSha256
  ) {
    violations.push(
      "maintenance job conditions differ from the approved inventory",
    );
  }
  if (
    !expectedJobAuthoritySha256 ||
    digest(maintenanceJobAuthorityInventory(authority)) !==
      expectedJobAuthoritySha256
  ) {
    violations.push(
      "maintenance runner, container, permissions, environment, or services differ from the approved inventory",
    );
  }
  return Object.freeze({
    trusted: violations.length === 0,
    baseContext: "maintenance default branch",
    violations: Object.freeze(violations),
  });
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
