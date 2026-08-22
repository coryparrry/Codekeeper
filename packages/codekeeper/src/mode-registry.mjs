import {
  assertExactKeys,
  assertPlainObject,
  AUTOMATIC_KEYS,
  CALLER_KEYS,
  CONCURRENCY_KEYS,
  MODE_KEYS,
  PERMISSION_RULE_KEYS,
  ROUTE_KEYS,
  RULES_KEYS,
  RUNTIME_KEYS,
  STAGE_KEYS,
  WORKSPACE_KEYS,
} from "./mode-registry-schema.mjs";
import {
  buildCommandModeLookup,
  validateCommandRoutes,
} from "./mode-command-routes.mjs";

const PERMISSION_KEYS = Object.freeze(["contents", "issues", "pullRequests"]);
const PERMISSION_VALUES = new Set(["read", "write"]);
const POLICY_AGENTS = new Set(["review", "audit", "issue", "fix"]);
const STAGE_VALIDATION_VALUES = new Set([
  "never",
  "always",
  "when-candidate-requires-validation",
]);
const STAGE_PUBLICATION_VALUES = new Set(["never", "always", "when-live"]);
const WORKSPACE_ACCESS_VALUES = new Set(["none", "read", "write"]);
const ISOLATION_VALUES = new Set(["none", "unprivileged-user"]);
const CONCURRENCY_SCOPES = new Set(["repository", "repository-target"]);
const CANONICAL_MODE_IDS = new Set(["review", "maintain", "issues", "fix"]);
const POLICY_PATH_SEGMENT_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
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
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const CALLER_TARGET = /^\.github\/workflows\/codekeeper-[a-z0-9-]+\.yml$/;
const CALLER_ASSET = /^workflows\/[a-z0-9-]+\.yml$/;
const RUNTIME_TARGET =
  /^\.github\/workflows\/codekeeper-runtime-[a-z0-9-]+\.yml$/;
const RUNTIME_ASSET = /^runtime-workflows\/[a-z0-9-]+\.yml$/;
const RUNTIME_PACKAGE = /^release\/workflows\/codekeeper-[a-z0-9-]+\.yml$/;
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const AGENT_PROFILE_DEFINITIONS = deepFreeze({
  "pr-reviewer": {
    id: "pr-reviewer",
    target: ".github/codekeeper/agents/pr-reviewer.md",
    asset: "agents/pr-reviewer.md",
    purpose: "Pull-request review judgment rules",
  },
  "repository-auditor": {
    id: "repository-auditor",
    target: ".github/codekeeper/agents/repository-auditor.md",
    asset: "agents/repository-auditor.md",
    purpose: "Repository-audit judgment rules",
  },
  "issue-triager": {
    id: "issue-triager",
    target: ".github/codekeeper/agents/issue-triager.md",
    asset: "agents/issue-triager.md",
    purpose: "Issue-triage judgment rules",
  },
  fixer: {
    id: "fixer",
    target: ".github/codekeeper/agents/fixer.md",
    asset: "agents/fixer.md",
    purpose: "Implementation and repair rules",
  },
});

const RAW_MODES = [
  {
    id: "review",
    label: "Pull request review",
    agentLabel: "Pull request reviewer",
    description:
      "Reviews pull requests from this repository. Adds comments, labels, and a blocking result.",
    policyAgent: "review",
    agentProfile: "pr-reviewer",
    workspaceProvider: "openai",
    workspace: {
      enabled: true,
      access: "read",
      isolation: "unprivileged-user",
    },
    stages: { compute: true, validation: "never", publication: "always" },
    publicationAdapter: "review",
    appPermissions: {
      contents: "read",
      issues: "write",
      pullRequests: "write",
    },
    automatic: {
      enabled: true,
      triggers: [
        "pull_request",
        "pull_request_target",
        "pull_request_review",
        "pull_request_review_comment",
      ],
      defaultRoute: "review",
      routes: [],
      commandOverrideTargets: ["issues", "fix"],
    },
    manual: true,
    concurrency: {
      scope: "repository-target",
      cancelAutomaticSupersededRuns: true,
    },
    supportedCommands: [
      {
        command: "review",
        surfaces: ["pull-request", "review-thread"],
      },
      {
        command: "triage",
        surfaces: ["pull-request", "review-thread"],
      },
      {
        command: "rerun",
        surfaces: ["pull-request", "review-thread"],
      },
      {
        command: "help",
        surfaces: ["pull-request", "review-thread"],
      },
      {
        command: "status",
        surfaces: ["pull-request", "review-thread"],
      },
      {
        command: "pause",
        surfaces: ["pull-request", "review-thread"],
      },
      {
        command: "stop",
        surfaces: ["pull-request", "review-thread"],
      },
    ],
    requiredGate: true,
    trigger: "same-repository pull request",
    target: ".github/workflows/codekeeper-review.yml",
    asset: "workflows/review.yml",
    caller: {
      target: ".github/workflows/codekeeper-review.yml",
      asset: "workflows/review.yml",
    },
    runtime: {
      target: ".github/workflows/codekeeper-runtime-review.yml",
      asset: "runtime-workflows/review.yml",
      sourcePath: ".github/workflows/codekeeper-review.yml",
      packagePath: "release/workflows/codekeeper-review.yml",
    },
    rules: {
      permissionEscalations: [
        {
          policyPath: ["review", "autoRepair"],
          value: true,
          permissions: {
            contents: "write",
            issues: "write",
            pullRequests: "write",
          },
        },
      ],
      assistantDispatch: true,
    },
  },
  {
    id: "maintain",
    label: "Repository maintenance",
    agentLabel: "Repository auditor",
    description:
      "Runs repository audits manually or on a schedule. Live runs can repair the repository when repair is on.",
    policyAgent: "audit",
    agentProfile: "repository-auditor",
    workspaceProvider: "openai",
    workspace: {
      enabled: true,
      access: "write",
      isolation: "unprivileged-user",
    },
    stages: {
      compute: true,
      validation: "when-candidate-requires-validation",
      publication: "when-live",
    },
    publicationAdapter: "audit",
    appPermissions: { contents: "read", issues: "write", pullRequests: "read" },
    automatic: {
      enabled: true,
      triggers: ["schedule"],
      defaultRoute: "maintain",
      routes: [],
      commandOverrideTargets: [],
    },
    manual: true,
    concurrency: { scope: "repository", cancelAutomaticSupersededRuns: false },
    supportedCommands: [],
    requiredGate: false,
    trigger: "schedule or manual run",
    target: ".github/workflows/codekeeper-maintain.yml",
    asset: "workflows/maintain.yml",
    caller: {
      target: ".github/workflows/codekeeper-maintain.yml",
      asset: "workflows/maintain.yml",
    },
    runtime: {
      target: ".github/workflows/codekeeper-runtime-maintain.yml",
      asset: "runtime-workflows/maintain.yml",
      sourcePath: ".github/workflows/codekeeper-maintain.yml",
      packagePath: "release/workflows/codekeeper-maintain.yml",
    },
    rules: {
      permissionEscalations: [
        {
          policyPath: ["audit", "repair", "enabled"],
          value: true,
          permissions: {
            contents: "write",
            issues: "write",
            pullRequests: "write",
          },
        },
      ],
      assistantDispatch: false,
    },
  },
  {
    id: "issues",
    label: "Issue triage",
    agentLabel: "Issue triager",
    description:
      "Adds labels and comments to issues. Automatic duplicate closure stays off.",
    policyAgent: "issue",
    agentProfile: "issue-triager",
    workspaceProvider: null,
    workspace: { enabled: false, access: "none", isolation: "none" },
    stages: { compute: true, validation: "never", publication: "always" },
    publicationAdapter: "issue",
    appPermissions: { contents: "read", issues: "write", pullRequests: "read" },
    automatic: {
      enabled: true,
      triggers: ["issues", "issue_comment"],
      defaultRoute: "issues",
      routes: [],
      commandOverrideTargets: ["review", "fix"],
    },
    manual: true,
    concurrency: {
      scope: "repository-target",
      cancelAutomaticSupersededRuns: true,
    },
    supportedCommands: [
      { command: "review", surfaces: ["issue"] },
      { command: "triage", surfaces: ["issue"] },
      { command: "defer", surfaces: ["review-thread"] },
      { command: "help", surfaces: ["issue"] },
      { command: "status", surfaces: ["issue"] },
      { command: "pause", surfaces: ["issue"] },
      { command: "stop", surfaces: ["issue"] },
    ],
    requiredGate: false,
    trigger: "issue or issue comment",
    target: ".github/workflows/codekeeper-issues.yml",
    asset: "workflows/issues.yml",
    caller: {
      target: ".github/workflows/codekeeper-issues.yml",
      asset: "workflows/issues.yml",
    },
    runtime: {
      target: ".github/workflows/codekeeper-runtime-issues.yml",
      asset: "runtime-workflows/issues.yml",
      sourcePath: ".github/workflows/codekeeper-issues.yml",
      packagePath: "release/workflows/codekeeper-issues.yml",
    },
    rules: {
      permissionEscalations: [],
      assistantDispatch: true,
    },
  },
  {
    id: "fix",
    label: "Issue implementation and pull request repair",
    agentLabel: "Fixer",
    description:
      "Validates and implements ready issues or pull request repairs in one workspace pass.",
    policyAgent: "fix",
    agentProfile: "fixer",
    workspaceProvider: "openai",
    workspace: {
      enabled: true,
      access: "write",
      isolation: "unprivileged-user",
    },
    stages: {
      compute: true,
      validation: "when-candidate-requires-validation",
      publication: "when-live",
    },
    publicationAdapter: "fix",
    appPermissions: {
      contents: "write",
      issues: "write",
      pullRequests: "write",
    },
    automatic: {
      enabled: true,
      triggers: ["repository_dispatch"],
      defaultRoute: "fix",
      routes: [
        {
          event: "issues",
          policyPath: ["readyLabelFix"],
          value: true,
        },
      ],
      commandOverrideTargets: [],
    },
    manual: true,
    concurrency: {
      scope: "repository-target",
      cancelAutomaticSupersededRuns: false,
    },
    supportedCommands: [
      { command: "implement", surfaces: ["issue"] },
      { command: "repair", surfaces: ["pull-request", "review-thread"] },
      { command: "fix", surfaces: ["pull-request", "review-thread"] },
    ],
    requiredGate: false,
    trigger: "ready issue, owner command, or manual run",
    target: ".github/workflows/codekeeper-fix.yml",
    asset: "workflows/fix.yml",
    caller: {
      target: ".github/workflows/codekeeper-fix.yml",
      asset: "workflows/fix.yml",
    },
    runtime: {
      target: ".github/workflows/codekeeper-runtime-fix.yml",
      asset: "runtime-workflows/fix.yml",
      sourcePath: ".github/workflows/codekeeper-fix.yml",
      packagePath: "release/workflows/codekeeper-fix.yml",
    },
    rules: {
      permissionEscalations: [],
      assistantDispatch: true,
    },
  },
];

function assertPermissionMap(permissions, label) {
  assertPlainObject(permissions, label);
  if (
    !permissions ||
    typeof permissions !== "object" ||
    Array.isArray(permissions) ||
    Object.keys(permissions).sort().join(",") !==
      PERMISSION_KEYS.slice().sort().join(",") ||
    PERMISSION_KEYS.some((key) => !PERMISSION_VALUES.has(permissions[key]))
  ) {
    throw new TypeError(`${label} has invalid App permissions.`);
  }
}

export function validateModeRegistry(
  registry = RAW_MODES,
  { profiles = AGENT_PROFILE_DEFINITIONS } = {},
) {
  const registryEntries = Array.isArray(registry)
    ? null
    : Object.entries(assertPlainObject(registry, "Mode registry"));
  const records = registryEntries
    ? registryEntries.map(([, mode]) => mode)
    : registry;
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError("Mode registry must contain at least one mode.");
  }
  if (
    registryEntries &&
    registryEntries.some(
      ([key, mode]) => !mode || typeof mode.id !== "string" || key !== mode.id,
    )
  ) {
    throw new TypeError("Mode registry keys must equal their mode IDs.");
  }
  const ids = new Set();
  const commandSurfaces = new Set();
  for (const mode of records) {
    if (
      !mode ||
      typeof mode !== "object" ||
      Array.isArray(mode) ||
      typeof mode.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(mode.id)
    ) {
      throw new TypeError("Mode registry contains an invalid mode ID.");
    }
    if (ids.has(mode.id))
      throw new TypeError(
        `Mode registry contains duplicate mode ID: ${mode.id}`,
      );
    ids.add(mode.id);
  }
  if (
    ids.size !== CANONICAL_MODE_IDS.size ||
    [...CANONICAL_MODE_IDS].some((id) => !ids.has(id))
  ) {
    throw new TypeError(
      "Mode registry must contain exactly the canonical mode IDs.",
    );
  }
  for (const mode of records) {
    assertPlainObject(mode, "Mode registry mode record");
    assertExactKeys(mode, MODE_KEYS, `Mode ${mode.id} record`);
    if (
      typeof mode.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(mode.id)
    ) {
      throw new TypeError("Mode registry contains an invalid mode ID.");
    }
    if (!POLICY_AGENTS.has(mode.policyAgent))
      throw new TypeError(
        `Mode ${mode.id} references an unknown policy agent.`,
      );
    if (!profiles || !Object.hasOwn(profiles, mode.agentProfile))
      throw new TypeError(
        `Mode ${mode.id} references an unknown agent profile.`,
      );
    assertExactKeys(
      mode.workspace,
      WORKSPACE_KEYS,
      `Mode ${mode.id} workspace`,
    );
    assertExactKeys(mode.stages, STAGE_KEYS, `Mode ${mode.id} stages`);
    assertExactKeys(
      mode.automatic,
      AUTOMATIC_KEYS,
      `Mode ${mode.id} automatic trigger policy`,
    );
    assertExactKeys(
      mode.concurrency,
      CONCURRENCY_KEYS,
      `Mode ${mode.id} concurrency policy`,
    );
    assertExactKeys(mode.caller, CALLER_KEYS, `Mode ${mode.id} caller`);
    assertExactKeys(mode.runtime, RUNTIME_KEYS, `Mode ${mode.id} runtime`);
    assertExactKeys(mode.rules, RULES_KEYS, `Mode ${mode.id} dynamic rules`);
    assertPlainObject(mode.workspace, `Mode ${mode.id} workspace`);
    assertPlainObject(mode.stages, `Mode ${mode.id} stages`);
    assertPlainObject(mode.appPermissions, `Mode ${mode.id} App permissions`);
    assertPlainObject(
      mode.automatic,
      `Mode ${mode.id} automatic trigger policy`,
    );
    assertPlainObject(mode.concurrency, `Mode ${mode.id} concurrency policy`);
    if (
      !mode.workspace ||
      !WORKSPACE_ACCESS_VALUES.has(mode.workspace.access) ||
      !ISOLATION_VALUES.has(mode.workspace.isolation) ||
      typeof mode.workspace.enabled !== "boolean"
    ) {
      throw new TypeError(`Mode ${mode.id} has invalid workspace access.`);
    }
    if (mode.workspace.access === "none" && mode.workspace.enabled) {
      throw new TypeError(
        `Mode ${mode.id} enables a workspace with no access.`,
      );
    }
    if (mode.workspace.access !== "none" && !mode.workspace.enabled) {
      throw new TypeError(`Mode ${mode.id} disables a workspace with access.`);
    }
    if (
      (mode.workspace.access === "none") !==
      (mode.workspace.isolation === "none")
    ) {
      throw new TypeError(
        `Mode ${mode.id} has an invalid workspace access and isolation pairing.`,
      );
    }
    if (
      mode.stages.compute !== true ||
      !STAGE_VALIDATION_VALUES.has(mode.stages.validation) ||
      !STAGE_PUBLICATION_VALUES.has(mode.stages.publication)
    ) {
      throw new TypeError(`Mode ${mode.id} has invalid stage topology.`);
    }
    if (
      mode.workspace.access === "write" &&
      mode.stages.validation === "never"
    ) {
      throw new TypeError(
        `Mode ${mode.id} is write-capable but has no validation stage.`,
      );
    }
    if (mode.requiredGate === true && mode.stages.publication === "never") {
      throw new TypeError(
        `Mode ${mode.id} requires a gate without a publication stage.`,
      );
    }
    if (
      mode.stages.publication !== "never" &&
      (typeof mode.publicationAdapter !== "string" || !mode.publicationAdapter)
    ) {
      throw new TypeError(`Mode ${mode.id} has publication but no adapter.`);
    }
    if (mode.publicationAdapter !== mode.policyAgent) {
      throw new TypeError(
        `Mode ${mode.id} has an unknown or incorrect publication adapter.`,
      );
    }
    assertPermissionMap(mode.appPermissions, `Mode ${mode.id}`);
    if (
      !mode.concurrency ||
      typeof mode.concurrency.scope !== "string" ||
      typeof mode.concurrency.cancelAutomaticSupersededRuns !== "boolean"
    ) {
      throw new TypeError(`Mode ${mode.id} has invalid concurrency policy.`);
    }
    if (!CONCURRENCY_SCOPES.has(mode.concurrency.scope)) {
      throw new TypeError(`Mode ${mode.id} has an unknown concurrency scope.`);
    }
    if (
      mode.workspace.access === "write" &&
      mode.concurrency.cancelAutomaticSupersededRuns === true
    ) {
      throw new TypeError(
        `Mode ${mode.id} cannot automatically cancel mutation-authorized runs.`,
      );
    }
    validateCommandRoutes(mode.supportedCommands, mode.id, commandSurfaces);
    if (
      typeof mode.label !== "string" ||
      !mode.label.trim() ||
      typeof mode.agentLabel !== "string" ||
      !mode.agentLabel.trim() ||
      typeof mode.description !== "string" ||
      !mode.description.trim() ||
      typeof mode.trigger !== "string" ||
      !mode.trigger.trim()
    ) {
      throw new TypeError(
        `Mode ${mode.id} is missing a label, description, or trigger.`,
      );
    }
    if (
      typeof mode.requiredGate !== "boolean" ||
      typeof mode.manual !== "boolean"
    ) {
      throw new TypeError(
        `Mode ${mode.id} has invalid gate or manual trigger flags.`,
      );
    }
    if (
      typeof mode.automatic.enabled !== "boolean" ||
      !Array.isArray(mode.automatic.triggers) ||
      mode.automatic.triggers.some(
        (trigger) =>
          typeof trigger !== "string" || !EVENT_NAME_PATTERN.test(trigger),
      ) ||
      new Set(mode.automatic.triggers).size !==
        mode.automatic.triggers.length ||
      (mode.automatic.enabled && mode.automatic.triggers.length === 0) ||
      (!mode.automatic.enabled && mode.automatic.triggers.length !== 0) ||
      (mode.automatic.enabled && mode.automatic.defaultRoute !== mode.id) ||
      (!mode.automatic.enabled && mode.automatic.defaultRoute !== null) ||
      !Array.isArray(mode.automatic.routes) ||
      !Array.isArray(mode.automatic.commandOverrideTargets) ||
      mode.automatic.commandOverrideTargets.some(
        (target) => !CANONICAL_MODE_IDS.has(target),
      )
    ) {
      throw new TypeError(
        `Mode ${mode.id} has invalid automatic trigger policy.`,
      );
    }
    for (const route of mode.automatic.routes) {
      assertExactKeys(route, ROUTE_KEYS, `Mode ${mode.id} automatic route`);
      if (
        typeof route.event !== "string" ||
        !SUPPORTED_EVENT_NAMES.has(route.event) ||
        !Array.isArray(route.policyPath) ||
        route.policyPath.length === 0 ||
        route.policyPath.some(
          (segment) =>
            typeof segment !== "string" ||
            !POLICY_PATH_SEGMENT_PATTERN.test(segment),
        ) ||
        typeof route.value !== "boolean"
      ) {
        throw new TypeError(`Mode ${mode.id} has invalid automatic route.`);
      }
    }
    if (!Array.isArray(mode.rules.permissionEscalations)) {
      throw new TypeError(`Mode ${mode.id} has invalid permission rules.`);
    }
    if (typeof mode.rules.assistantDispatch !== "boolean") {
      throw new TypeError(
        `Mode ${mode.id} has invalid assistant dispatch rule.`,
      );
    }
    for (const rule of mode.rules.permissionEscalations) {
      assertExactKeys(
        rule,
        PERMISSION_RULE_KEYS,
        `Mode ${mode.id} permission rule`,
      );
      if (
        !Array.isArray(rule.policyPath) ||
        rule.policyPath.length === 0 ||
        rule.policyPath.some(
          (segment) =>
            typeof segment !== "string" ||
            !POLICY_PATH_SEGMENT_PATTERN.test(segment),
        ) ||
        typeof rule.value !== "boolean"
      ) {
        throw new TypeError(`Mode ${mode.id} has invalid permission rule.`);
      }
      assertPermissionMap(rule.permissions, `Mode ${mode.id} permission rule`);
    }
    if (
      !mode.runtime ||
      typeof mode.runtime !== "object" ||
      typeof mode.runtime.target !== "string" ||
      typeof mode.runtime.asset !== "string" ||
      typeof mode.runtime.sourcePath !== "string" ||
      typeof mode.runtime.packagePath !== "string" ||
      !CALLER_TARGET.test(mode.target) ||
      !CALLER_ASSET.test(mode.asset) ||
      !RUNTIME_TARGET.test(mode.runtime.target) ||
      !RUNTIME_ASSET.test(mode.runtime.asset) ||
      !SAFE_PATH.test(mode.runtime.sourcePath) ||
      !RUNTIME_PACKAGE.test(mode.runtime.packagePath) ||
      mode.caller.target !== mode.target ||
      mode.caller.asset !== mode.asset ||
      mode.runtime.sourcePath !== mode.target ||
      mode.target !== `.github/workflows/codekeeper-${mode.id}.yml` ||
      mode.asset !== `workflows/${mode.id}.yml` ||
      mode.runtime.target !==
        `.github/workflows/codekeeper-runtime-${mode.id}.yml` ||
      mode.runtime.asset !== `runtime-workflows/${mode.id}.yml` ||
      mode.runtime.packagePath !== `release/workflows/codekeeper-${mode.id}.yml`
    ) {
      throw new TypeError(
        `Mode ${mode.id} is missing runtime artifact references.`,
      );
    }
    assertPlainObject(
      mode.runtime,
      `Mode ${mode.id} runtime artifact references`,
    );
  }
  if (
    ids.size !== CANONICAL_MODE_IDS.size ||
    [...CANONICAL_MODE_IDS].some((id) => !ids.has(id))
  ) {
    throw new TypeError(
      "Mode registry must contain exactly the canonical mode IDs.",
    );
  }
  return true;
}

validateModeRegistry();

function freezeMode(mode) {
  return deepFreeze({
    ...mode,
    workspace: { ...mode.workspace },
    stages: { ...mode.stages },
    appPermissions: { ...mode.appPermissions },
    automatic: {
      ...mode.automatic,
      triggers: [...mode.automatic.triggers],
      routes: mode.automatic.routes.map((route) => ({
        ...route,
        policyPath: [...route.policyPath],
      })),
    },
    concurrency: { ...mode.concurrency },
    supportedCommands: mode.supportedCommands.map((route) => ({
      ...route,
      surfaces: [...route.surfaces],
    })),
    caller: { ...mode.caller },
    rules: {
      ...mode.rules,
      permissionEscalations: mode.rules.permissionEscalations.map((rule) => ({
        ...rule,
        policyPath: [...rule.policyPath],
        permissions: { ...rule.permissions },
      })),
    },
    runtime: { ...mode.runtime },
  });
}

export const MODES = deepFreeze(
  Object.fromEntries(RAW_MODES.map((mode) => [mode.id, freezeMode(mode)])),
);
export const MODE_IDS = Object.freeze(Object.keys(MODES));
export const MODE_REGISTRY = MODES;
export const POLICY_AGENT_TO_MODE = Object.freeze(
  Object.fromEntries(MODE_IDS.map((id) => [MODES[id].policyAgent, id])),
);
export const COMMAND_MODE_MAP = deepFreeze(
  buildCommandModeLookup(Object.values(MODES)),
);
export function commandModeForSurface(command, surface) {
  if (!Object.hasOwn(COMMAND_MODE_MAP, command)) return null;
  const routes = COMMAND_MODE_MAP[command];
  return Object.hasOwn(routes, surface) ? routes[surface] : null;
}

export function commandExists(command) {
  return Object.hasOwn(COMMAND_MODE_MAP, command);
}
export const AGENT_PROFILE_IDS = Object.freeze(
  Object.keys(AGENT_PROFILE_DEFINITIONS),
);
export const AGENT_PROFILES = AGENT_PROFILE_DEFINITIONS;

export const ASSISTANT_WORKFLOW = deepFreeze({
  id: "assistant",
  label: "Repository assistant",
  target: ".github/workflows/codekeeper-assistant.yml",
  asset: "workflows/assistant.yml",
  description:
    "Routes configured-owner requests to the installed role workflows.",
});

export const RUNTIME_WORKFLOWS = deepFreeze({
  assistant: {
    id: "assistant",
    label: "Repository assistant runtime",
    target: ".github/workflows/codekeeper-runtime-assistant.yml",
    asset: "runtime-workflows/assistant.yml",
    sourcePath: ASSISTANT_WORKFLOW.target,
    packagePath: "release/workflows/codekeeper-assistant.yml",
    description:
      "Runs the repository assistant from the verified Codekeeper package.",
  },
  ...Object.fromEntries(
    MODE_IDS.map((id) => [
      id,
      {
        id,
        label: `${MODES[id].label} runtime`,
        target: MODES[id].runtime.target,
        asset: MODES[id].runtime.asset,
        sourcePath: MODES[id].runtime.sourcePath,
        packagePath: MODES[id].runtime.packagePath,
        description: `Runs the ${MODES[id].label.toLowerCase()} from the verified Codekeeper package.`,
      },
    ]),
  ),
});
export const RUNTIME_WORKFLOW_IDS = Object.freeze(
  Object.keys(RUNTIME_WORKFLOWS),
);

export function modeForId(mode) {
  const normalized = String(mode ?? "")
    .trim()
    .toLowerCase();
  const resolved = Object.hasOwn(POLICY_AGENT_TO_MODE, normalized)
    ? POLICY_AGENT_TO_MODE[normalized]
    : normalized;
  return Object.hasOwn(MODES, resolved) ? MODES[resolved] : null;
}
