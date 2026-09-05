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
export const RIVET_REVIEW_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "ded327801ea4d3fed88097f5be98cba6f909ca76c221a8d7584d3635f8a35513",
  codex: "aaa4fcdf83be07e28a17c9a7e224cdd1011f7d27b89f9b39363c9a580eeb5950",
  copilot: "751e0275bededfdc2f944a6865456bb81149c419a52c379c442bafd9fe7a69c9",
  gemini: "b4907cb48c03ae60fa065c87e2ff4b0e9d5debbf40b0742945cc745ed6d4bf45",
});
export const RIVET_REVIEW_DISABLED_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "72f162b4c4eac607afbc2cf8c6454634c8734abd9f28ab110248305bd596a1e9",
  codex: "64aae4de32eec7c86f624b3a640b1bf9588851c6208933fbcdaf3e1d1aea3d70",
  copilot: "5017dae024c0e0ff3bb81c6bec2d1d4984d988635adba22dfd589e4b3ef32ed3",
  gemini: "daf0b1e8f1ed7636cdb548a48e6cf7afac10893051f49c56c5b6906c315bdcd0",
});
export const RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "f1ac491b665080316eb9ae1c0b9762b58d39e416c09677dd28a6e54d5ccf5ea4",
  codex: "9fbb8d8e217a3dae414e85208674a68421494111d2d21425ee7ad8f89a76c011",
  copilot: "ee0dc306c0fbf944d077f1637edee60d1fe30d989db0a75da961d23aa4015ffb",
  gemini: "4a55ecdcb1d007d048e7816d1209c91bbc20fe4e1358fe6b77484454fa813238",
});

function sameValues(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExactlyKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
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
    scripts: (authority.scripts ?? []).map(
      ({ env, if: condition, job, name, run, shell }) => ({
        job,
        name,
        if: condition,
        run,
        shell,
        env,
      }),
    ),
  };
}

function maintenanceJobAuthorityInventory(authority) {
  return {
    jobs: Object.fromEntries(
      Object.entries(authority.jobAuthority ?? {}).map(
        ([
          job,
          { container, env, environment, permissions, runsOn, services },
        ]) => [
          job,
          { container, env, environment, permissions, runsOn, services },
        ],
      ),
    ),
    workflowEnv: authority.workflowEnv ?? {},
  };
}

function normalizedSafeOutputConfig(config) {
  if (!config) return "";
  const normalized = structuredClone(config);
  normalized.create_issue = "<ISSUE_TRIAGE>";
  normalized.create_pull_request_review_comment = "<INLINE_FINDINGS>";
  if (normalized.submit_pull_request_review) {
    normalized.submit_pull_request_review.allowed_events = "<REVIEW_EVENTS>";
  }
  return JSON.stringify(normalized);
}

function normalizeReviewEnv(env, authority) {
  const model = authority.metadata?.agent_model;
  const config = authority.safeOutputConfig
    ? JSON.stringify(authority.safeOutputConfig)
    : "";
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      value === model
        ? "<MODEL>"
        : name === "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG" && value === config
          ? normalizedSafeOutputConfig(authority.safeOutputConfig)
          : value,
    ]),
  );
}

function reviewAuthorityInventory(authority) {
  const publicationJobs = new Set(["conclusion", "safe_outputs"]);
  const actions = (authority.actions ?? []).map((originalAction) => {
    const action = {
      ...originalAction,
      env: normalizeReviewEnv(originalAction.env, authority),
    };
    return publicationJobs.has(action.job) &&
      action.action === "actions/create-github-app-token"
      ? {
          ...action,
          with: {
            ...action.with,
            "permission-issues": "<ISSUES_PERMISSION>",
          },
        }
      : action;
  });
  const jobAuthority = Object.fromEntries(
    Object.entries(authority.jobAuthority ?? {}).map(([job, value]) => {
      const normalizedValue = value
        ? { ...value, env: normalizeReviewEnv(value.env, authority) }
        : value;
      return [
        job,
        normalizedValue && publicationJobs.has(job)
          ? {
              ...normalizedValue,
              permissions: {
                ...normalizedValue.permissions,
                issues: "<ISSUES_PERMISSION>",
              },
            }
          : normalizedValue,
      ];
    }),
  );
  return {
    actions,
    containers: authority.containers ?? [],
    jobAuthority,
    jobConditions: authority.jobConditions ?? {},
    jobIds: Object.keys(authority.jobAuthority ?? {}).sort(),
    permissions: authority.permissions ?? {},
    scripts: (authority.scripts ?? []).map((script) => ({
      ...script,
      env: normalizeReviewEnv(script.env, authority),
    })),
    triggerConfig: authority.triggerConfig ?? {},
    workflowConcurrency: authority.concurrency ?? null,
    workflowDefaults: authority.workflowDefaults ?? null,
    workflowEnv: normalizeReviewEnv(authority.workflowEnv, authority),
  };
}

function issueTriageAuthorityInventory(authority) {
  const normalize = (value) => normalizeReviewEnv(value, authority);
  return {
    actions: (authority.actions ?? []).map((action) => ({
      ...action,
      env: normalize(action.env),
    })),
    containers: authority.containers ?? [],
    jobAuthority: Object.fromEntries(
      Object.entries(authority.jobAuthority ?? {}).map(([job, value]) => [
        job,
        value ? { ...value, env: normalize(value.env) } : value,
      ]),
    ),
    jobConditions: authority.jobConditions ?? {},
    jobIds: Object.keys(authority.jobAuthority ?? {}).sort(),
    permissions: authority.permissions ?? {},
    scripts: (authority.scripts ?? []).map((script) => ({
      ...script,
      env: normalize(script.env),
    })),
    triggerConfig: authority.triggerConfig ?? {},
    workflowConcurrency: authority.concurrency ?? null,
    workflowDefaults: authority.workflowDefaults ?? null,
    workflowEnv: normalize(authority.workflowEnv),
  };
}

function reviewWriteAuthorityIsNarrow(authority) {
  const writeJobs = authority.writeCapableJobs ?? [];
  if (
    writeJobs.length !== 2 ||
    !sameValues(writeJobs.map(({ job }) => job).sort(), [
      "conclusion",
      "safe_outputs",
    ])
  ) {
    return false;
  }
  for (const { permissions } of writeJobs) {
    if (
      permissions["pull-requests"] !== "write" ||
      (permissions.issues !== undefined && permissions.issues !== "write") ||
      Object.keys(permissions).some(
        (permission) =>
          permission !== "issues" && permission !== "pull-requests",
      )
    ) {
      return false;
    }
  }
  for (const job of ["agent", "conclusion", "safe_outputs"]) {
    const jobAuthority = authority.jobAuthority?.[job];
    if (
      !jobAuthority ||
      jobAuthority.container !== null ||
      jobAuthority.environment !== null ||
      jobAuthority.services !== null
    ) {
      return false;
    }
  }
  return (
    authority.jobAuthority.agent.runsOn === "ubuntu-latest" &&
    JSON.stringify(authority.jobAuthority.agent.permissions) ===
      JSON.stringify({ contents: "read", "pull-requests": "read" }) &&
    authority.jobAuthority.conclusion.runsOn === "ubuntu-slim" &&
    authority.jobAuthority.safe_outputs.runsOn === "ubuntu-slim"
  );
}

function reviewSafeOutputsAreBounded(authority, expectedIssueTriage) {
  const config = authority.safeOutputConfig;
  if (!config || typeof config !== "object" || Array.isArray(config))
    return false;
  const allowed = new Set([
    "create_issue",
    "create_pull_request_review_comment",
    "missing_data",
    "missing_tool",
    "noop",
    "report_incomplete",
    "submit_pull_request_review",
  ]);
  if (Object.keys(config).some((name) => !allowed.has(name))) return false;
  const inline = config.create_pull_request_review_comment;
  const issue = config.create_issue;
  const review = config.submit_pull_request_review;
  const expectedIssuePermission = issue ? "write" : undefined;
  const publicationJobs = new Set(["conclusion", "safe_outputs"]);
  const appTokens = (authority.actions ?? []).filter(
    ({ action, job }) =>
      publicationJobs.has(job) && action === "actions/create-github-app-token",
  );
  return (
    Boolean(issue) === (expectedIssueTriage === "automatic") &&
    sameValues(authority.safeOutputJobs, ["safe_outputs"]) &&
    appTokens.length === 2 &&
    appTokens.every(
      ({ with: actionWith }) =>
        actionWith?.["permission-issues"] === expectedIssuePermission,
    ) &&
    [...publicationJobs].every(
      (job) =>
        authority.jobAuthority?.[job]?.permissions?.issues ===
        expectedIssuePermission,
    ) &&
    (!inline ||
      (hasExactlyKeys(inline, ["max", "side"]) &&
        Number.isInteger(inline.max) &&
        inline.max >= 1 &&
        inline.max <= 20 &&
        inline.side === "RIGHT")) &&
    (!issue ||
      (hasExactlyKeys(issue, ["deduplicate_by_title", "max", "title_prefix"]) &&
        issue.deduplicate_by_title === true &&
        issue.max === 1 &&
        issue.title_prefix === "[rivet] ")) &&
    hasExactlyKeys(review, ["allowed_events", "max"]) &&
    review.max === 1 &&
    (sameValues(review.allowed_events, ["COMMENT"]) ||
      sameValues(review.allowed_events, ["COMMENT", "REQUEST_CHANGES"])) &&
    config.noop?.max === 1 &&
    config.noop?.["report-as-issue"] === "false" &&
    authority.safeOutputSettings?.failureReportAsIssue === "false" &&
    authority.safeOutputSettings?.missingDataReportAsFailure === "true" &&
    authority.safeOutputSettings?.missingToolReportAsFailure === "true" &&
    authority.safeOutputSettings?.noopReportAsIssue === "false" &&
    authority.safeOutputSettings?.reportIncompleteCreateIssue === "false"
  );
}

function maintenanceSecrets(expectedEngine) {
  const provider = MAINTENANCE_PROVIDER_SECRETS[expectedEngine];
  if (!provider) return null;
  return [...new Set([...MAINTENANCE_SHARED_SECRETS, ...provider])].sort();
}

function issueTriageSecrets(expectedEngine) {
  const provider = MAINTENANCE_PROVIDER_SECRETS[expectedEngine];
  if (!provider) return null;
  return [
    ...new Set([
      ...MAINTENANCE_SHARED_SECRETS,
      ...provider,
      "RIVET_APP_PRIVATE_KEY",
    ]),
  ].sort();
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
  expectedLocalActions = [],
  expectedModel,
  expectedPublisherScript,
  expectedSecrets,
  expectedAuthoritySha256,
}) {
  const violations = [];
  if (!sameValues(authority.triggers, ["issue_comment", "issues"])) {
    violations.push("workflow must use only issues and issue_comment");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  const authoritySha256 =
    expectedAuthoritySha256 ??
    RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE[expectedEngine];
  if (
    !authoritySha256 ||
    digest(issueTriageAuthorityInventory(authority)) !== authoritySha256
  ) {
    violations.push(
      "issue triage workflow differs from the approved authority inventory",
    );
  }
  if (JSON.stringify(authority.workflowEnv ?? {}) !== JSON.stringify({})) {
    violations.push("issue triage workflow environment must remain empty");
  }
  const approvedSecrets = expectedSecrets ?? issueTriageSecrets(expectedEngine);
  if (
    !approvedSecrets ||
    !sameValues(authority.secrets, approvedSecrets) ||
    !sameValues(authority.manifestSecrets, approvedSecrets)
  ) {
    violations.push("issue triage secrets differ from the approved inventory");
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
  if (!sameValues(authority.localActions, expectedLocalActions)) {
    violations.push("local actions differ from the approved inventory");
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
  expectedEngine,
  expectedImports = [],
  expectedLocalActions = [],
  expectedModel,
  expectedIssueTriage = "automatic",
  expectedReviewAuthoritySha256,
}) {
  const violations = [];
  if (!["automatic", "disabled"].includes(expectedIssueTriage)) {
    violations.push("expected issue triage mode must be automatic or disabled");
  }
  const compiledModel = expectedModel;
  if (!sameValues(authority.triggers, ["pull_request_target"])) {
    violations.push("workflow must use only pull_request_target");
  }
  if (authority.metadata.strict !== true) {
    violations.push("compiler strict mode is required");
  }
  if (authority.manifest.has_pull_request_target !== true) {
    violations.push("compiler manifest must record pull_request_target");
  }
  if (
    authority.metadata.agent_id !== expectedEngine ||
    authority.metadata.agent_model !== compiledModel
  ) {
    violations.push("review model differs from the configured model");
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
  const reviewAuthoritySha256 =
    expectedReviewAuthoritySha256 ??
    (expectedIssueTriage === "automatic"
      ? RIVET_REVIEW_AUTHORITY_SHA256_BY_ENGINE[expectedEngine]
      : expectedIssueTriage === "disabled"
        ? RIVET_REVIEW_DISABLED_AUTHORITY_SHA256_BY_ENGINE[expectedEngine]
        : undefined);
  if (
    !reviewAuthoritySha256 ||
    digest(reviewAuthorityInventory(authority)) !== reviewAuthoritySha256 ||
    !reviewWriteAuthorityIsNarrow(authority) ||
    !reviewSafeOutputsAreBounded(authority, expectedIssueTriage)
  ) {
    violations.push("review workflow differs from the approved inventory");
  }
  if (
    authority.githubMcpEnabled ||
    (expectedEngine === "codex" && authority.shellToolDisabled !== true)
  ) {
    violations.push("model-driven repository reads must be disabled");
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
