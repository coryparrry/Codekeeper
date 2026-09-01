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
  claude: "3f1f72a4fdb62247c7ab81cb150ce5f7e0ed06d9d8e9703f57b7de84a4af0623",
  codex: "484f7e0c35a557d6d7fbd566cefc114db7a0cb3908ffd069006ca4e9711895a9",
  copilot: "44c4826cdc8d55ea5a5e0458b1bd80cf394c269ed7721a9fa4d5be667cf93d62",
  gemini: "2f16442f63d2e955c085491513e0dc24c42a258bcaca181c9306faa938130311",
});
export const RIVET_REVIEW_DISABLED_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "1657997280ba81d1725737ff367e072170370eb7f68e4d9b08bb69fbd9980da3",
  codex: "ca9cf1cdb4e9b3d1c93a2e445c05c20601e6520a2d8bbd64cc58ce6757c111d3",
  copilot: "4f22d4bfc3cf356e78d4d8cf3adcfdcb51b2214aae78ffd3a94f2cea9a12c553",
  gemini: "11a0fd1a832a6d0a844ccf915611e2ee4a0966b5b68abb373d2592d343ada201",
});
export const RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE = Object.freeze({
  claude: "a21906bcc1caf7275288f14527eeea25bd2e5e04b19703795942c1e0bb707282",
  codex: "312e5a386599d4076bdcbaf75767b8505adfad7c03f0f31508f33d39dcaa6663",
  copilot: "c721efb9884ee4651238b69c64a78ecf146905838796a74adb6689b05f3fd362",
  gemini: "740e7807ec0397efdc4b1a518d5330fe58ba6aec1a6761f0e2e7ed06131ce117",
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
