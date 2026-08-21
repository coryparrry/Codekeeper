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
const PUBLICATION_ADAPTERS = Object.freeze({
  review: "review",
  maintain: "audit",
  issues: "issue",
  fix: "fix",
});
const CANONICAL_MODE_IDS = new Set(Object.keys(PUBLICATION_ADAPTERS));
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_COMMAND_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
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

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must use a plain object prototype.`);
  }
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
    candidateValidation: "never",
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
        "pull_request_review",
        "pull_request_review_comment",
      ],
    },
    manual: true,
    concurrency: {
      scope: "repository-target",
      cancelAutomaticSupersededRuns: true,
    },
    supportedCommands: { review: "review", rerun: "review" },
    requiredGate: true,
    trigger: "same-repository pull request",
    target: ".github/workflows/codekeeper-review.yml",
    asset: "workflows/review.yml",
    runtime: {
      target: ".github/workflows/codekeeper-runtime-review.yml",
      asset: "runtime-workflows/review.yml",
      sourcePath: ".github/workflows/codekeeper-review.yml",
      packagePath: "release/workflows/codekeeper-review.yml",
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
    candidateValidation: "when-candidate-requires-validation",
    publicationAdapter: "audit",
    appPermissions: { contents: "read", issues: "write", pullRequests: "read" },
    automatic: { enabled: true, triggers: ["schedule"] },
    manual: true,
    concurrency: { scope: "repository", cancelAutomaticSupersededRuns: false },
    supportedCommands: {},
    requiredGate: false,
    trigger: "schedule or manual run",
    target: ".github/workflows/codekeeper-maintain.yml",
    asset: "workflows/maintain.yml",
    runtime: {
      target: ".github/workflows/codekeeper-runtime-maintain.yml",
      asset: "runtime-workflows/maintain.yml",
      sourcePath: ".github/workflows/codekeeper-maintain.yml",
      packagePath: "release/workflows/codekeeper-maintain.yml",
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
    candidateValidation: "never",
    publicationAdapter: "issue",
    appPermissions: { contents: "read", issues: "write", pullRequests: "read" },
    automatic: { enabled: true, triggers: ["issues", "issue_comment"] },
    manual: true,
    concurrency: {
      scope: "repository-target",
      cancelAutomaticSupersededRuns: true,
    },
    supportedCommands: { triage: "issues" },
    requiredGate: false,
    trigger: "issue or issue comment",
    target: ".github/workflows/codekeeper-issues.yml",
    asset: "workflows/issues.yml",
    runtime: {
      target: ".github/workflows/codekeeper-runtime-issues.yml",
      asset: "runtime-workflows/issues.yml",
      sourcePath: ".github/workflows/codekeeper-issues.yml",
      packagePath: "release/workflows/codekeeper-issues.yml",
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
    candidateValidation: "when-candidate-requires-validation",
    publicationAdapter: "fix",
    appPermissions: {
      contents: "write",
      issues: "write",
      pullRequests: "write",
    },
    automatic: {
      enabled: true,
      triggers: ["issues", "issue_comment", "repository_dispatch"],
    },
    manual: true,
    concurrency: {
      scope: "repository-target",
      cancelAutomaticSupersededRuns: false,
    },
    supportedCommands: { implement: "fix", repair: "fix", fix: "fix" },
    requiredGate: false,
    trigger: "ready issue, owner command, or manual run",
    target: ".github/workflows/codekeeper-fix.yml",
    asset: "workflows/fix.yml",
    runtime: {
      target: ".github/workflows/codekeeper-runtime-fix.yml",
      asset: "runtime-workflows/fix.yml",
      sourcePath: ".github/workflows/codekeeper-fix.yml",
      packagePath: "release/workflows/codekeeper-fix.yml",
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
  const records = Array.isArray(registry)
    ? registry
    : Object.values(assertPlainObject(registry, "Mode registry"));
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError("Mode registry must contain at least one mode.");
  }
  const ids = new Set();
  const commands = new Set();
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
      !mode.stages?.compute ||
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
    if (mode.candidateValidation !== mode.stages.validation) {
      throw new TypeError(
        `Mode ${mode.id} candidate validation diverges from its validation stage.`,
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
    if (
      !Object.hasOwn(PUBLICATION_ADAPTERS, mode.id) ||
      PUBLICATION_ADAPTERS[mode.id] !== mode.publicationAdapter
    ) {
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
    const commandRoutes = mode.supportedCommands;
    if (
      !commandRoutes ||
      typeof commandRoutes !== "object" ||
      Array.isArray(commandRoutes)
    ) {
      throw new TypeError(`Mode ${mode.id} has invalid command routing.`);
    }
    assertPlainObject(commandRoutes, `Mode ${mode.id} command routing`);
    const supportedCommands = Array.isArray(commandRoutes)
      ? commandRoutes.map((command) => [command, mode.id])
      : commandRoutes &&
          typeof commandRoutes === "object" &&
          !Array.isArray(commandRoutes)
        ? Object.entries(commandRoutes)
        : null;
    if (
      !supportedCommands ||
      supportedCommands.some(([command]) => !COMMAND_PATTERN.test(command))
    ) {
      throw new TypeError(`Mode ${mode.id} has invalid command routing.`);
    }
    for (const [command, target] of supportedCommands) {
      if (RESERVED_COMMAND_NAMES.has(command)) {
        throw new TypeError(`Mode ${mode.id} uses a reserved command name.`);
      }
      if (target !== mode.id)
        throw new TypeError(
          `Command ${command} targets an unknown mode: ${target}`,
        );
      if (commands.has(command))
        throw new TypeError(
          `Mode registry contains duplicate command routing: ${command}`,
        );
      commands.add(command);
    }
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
      !mode.automatic ||
      typeof mode.automatic.enabled !== "boolean" ||
      !Array.isArray(mode.automatic.triggers) ||
      mode.automatic.triggers.length === 0 ||
      mode.automatic.triggers.some(
        (trigger) => !EVENT_NAME_PATTERN.test(trigger),
      )
    ) {
      throw new TypeError(
        `Mode ${mode.id} has invalid automatic trigger policy.`,
      );
    }
    if (
      typeof mode.candidateValidation !== "string" ||
      !STAGE_VALIDATION_VALUES.has(mode.candidateValidation)
    ) {
      throw new TypeError(
        `Mode ${mode.id} has invalid candidate validation policy.`,
      );
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
  const commandRoutes = mode.supportedCommands ?? mode.commands ?? [];
  const supportedCommands = Array.isArray(commandRoutes)
    ? Object.fromEntries(commandRoutes.map((command) => [command, mode.id]))
    : Object.fromEntries(Object.entries(commandRoutes));
  return deepFreeze({
    ...mode,
    workspace: { ...mode.workspace },
    stages: { ...mode.stages },
    appPermissions: { ...mode.appPermissions },
    automatic: { ...mode.automatic, triggers: [...mode.automatic.triggers] },
    concurrency: { ...mode.concurrency },
    supportedCommands,
    commands: Object.keys(supportedCommands),
    caller: { target: mode.target, asset: mode.asset },
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
const COMMAND_MODE_LOOKUP = Object.create(null);
for (const id of MODE_IDS) {
  for (const [command, target] of Object.entries(MODES[id].supportedCommands)) {
    COMMAND_MODE_LOOKUP[command] = target;
  }
}
export const COMMAND_MODE_MAP = deepFreeze(COMMAND_MODE_LOOKUP);
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
