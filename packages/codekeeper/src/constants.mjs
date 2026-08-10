export const PACKAGE_NAME = "codekeeper";
export const PACKAGE_VERSION = "0.2.0";
export const MINIMUM_NODE_MAJOR = 22;
export const SOURCE_REPOSITORY = "coryparrry/Codekeeper";
export const SOURCE_COMMIT = "46013ff941ee90b7a34feb82f921149c2535da39";
export const SETUP_BRANCH = "codekeeper/setup";
export const SETUP_COMMIT_MESSAGE = "chore(codekeeper): add setup";
export const SETUP_PR_TITLE = "chore(codekeeper): add setup";

export const MODES = Object.freeze({
  review: Object.freeze({
    id: "review",
    label: "Pull request review",
    agentLabel: "Pull request reviewer",
    description: "Reviews pull requests from this repository. Adds comments, labels, and a blocking result.",
    policyAgent: "review",
    target: ".github/workflows/codekeeper-review.yml",
    asset: "workflows/review.yml",
    trigger: "same-repository pull request"
  }),
  maintain: Object.freeze({
    id: "maintain",
    label: "Repository maintenance",
    agentLabel: "Repository auditor",
    description: "Runs repository audits manually or on a schedule. Live runs can repair the repository when repair is on.",
    policyAgent: "audit",
    target: ".github/workflows/codekeeper-maintain.yml",
    asset: "workflows/maintain.yml",
    trigger: "schedule or manual run"
  }),
  issues: Object.freeze({
    id: "issues",
    label: "Issue triage",
    agentLabel: "Issue triager",
    description: "Adds labels and comments to issues. Automatic duplicate closure stays off.",
    policyAgent: "issue",
    target: ".github/workflows/codekeeper-issues.yml",
    asset: "workflows/issues.yml",
    trigger: "issue or issue comment"
  }),
  fix: Object.freeze({
    id: "fix",
    label: "Issue implementation and pull request repair",
    agentLabel: "Maintenance planner",
    description: "Implements ready issues when issue implementation is on. Owners can also request a pull request repair.",
    policyAgent: "fix",
    target: ".github/workflows/codekeeper-fix.yml",
    asset: "workflows/fix.yml",
    trigger: "ready issue, owner command, or manual run"
  })
});

export const MODE_IDS = Object.freeze(Object.keys(MODES));
export const AGENT_PROFILES = Object.freeze({
  "pr-reviewer": Object.freeze({
    id: "pr-reviewer",
    target: ".github/codekeeper/agents/pr-reviewer.md",
    asset: "agents/pr-reviewer.md",
    purpose: "Editable pull-request review judgment rules"
  }),
  "repository-auditor": Object.freeze({
    id: "repository-auditor",
    target: ".github/codekeeper/agents/repository-auditor.md",
    asset: "agents/repository-auditor.md",
    purpose: "Editable repository-audit judgment rules"
  }),
  "issue-triager": Object.freeze({
    id: "issue-triager",
    target: ".github/codekeeper/agents/issue-triager.md",
    asset: "agents/issue-triager.md",
    purpose: "Editable issue-triage judgment rules"
  }),
  "maintenance-planner": Object.freeze({
    id: "maintenance-planner",
    target: ".github/codekeeper/agents/maintenance-planner.md",
    asset: "agents/maintenance-planner.md",
    purpose: "Editable implementation and repair rules"
  })
});
export const AGENT_PROFILE_IDS = Object.freeze(Object.keys(AGENT_PROFILES));
export const PRESET_IDS = Object.freeze(["mixed", "openai"]);
export const RECOMMENDED_MODES = Object.freeze(["review", "maintain"]);
export const RECOMMENDED_PRESET = "openai";
export const CAPABILITIES = Object.freeze({
  reviewRepair: Object.freeze({
    id: "reviewRepair",
    label: "Automatic review repair",
    description: "Allow one repair pass when a pull request review finds a blocking problem.",
    modes: Object.freeze(["review", "fix"])
  }),
  repair: Object.freeze({
    id: "repair",
    label: "Repository repair",
    description: "Allow live maintenance runs to create repair pull requests.",
    modes: Object.freeze(["maintain"])
  }),
  issueImplementation: Object.freeze({
    id: "issueImplementation",
    label: "Issue implementation",
    description: "Automatically implement issues that triage marks ready.",
    modes: Object.freeze(["fix"])
  }),
  duplicateClosure: Object.freeze({
    id: "duplicateClosure",
    label: "Automatic duplicate closure",
    description: "Allow issue triage to close an issue when it finds an exact duplicate.",
    modes: Object.freeze(["issues"])
  }),
  autoMerge: Object.freeze({
    id: "autoMerge",
    label: "Automatic merge",
    description: "Allow Codekeeper to merge validated repair pull requests within policy limits.",
    modes: Object.freeze(["maintain", "fix"])
  })
});
export const CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITIES));
export const MODEL_OPTIONS = Object.freeze({
  openai: Object.freeze([
    Object.freeze({ id: "luna-max", provider: "openai", model: "gpt-5.6-luna", effort: "max", label: "OpenAI · GPT-5.6 Luna · max effort" }),
    Object.freeze({ id: "sol-high", provider: "openai", model: "gpt-5.6-sol", effort: "high", label: "OpenAI · GPT-5.6 Sol · high effort" }),
    Object.freeze({ id: "terra-high", provider: "openai", model: "gpt-5.6-terra", effort: "high", label: "OpenAI · GPT-5.6 Terra · high effort" }),
    Object.freeze({ id: "terra-medium", provider: "openai", model: "gpt-5.6-terra", effort: "medium", label: "OpenAI · GPT-5.6 Terra · medium effort" })
  ]),
  deepseek: Object.freeze([
    Object.freeze({ id: "deepseek-v4-flash", provider: "deepseek", model: "deepseek-v4-flash", effort: "none", label: "DeepSeek · V4 Flash" })
  ])
});
export const ALL_MODEL_OPTIONS = Object.freeze(Object.values(MODEL_OPTIONS).flat());
export const POLICY_TARGET = ".github/codekeeper.json";
export const KNOWN_TARGETS = Object.freeze([
  POLICY_TARGET,
  ...AGENT_PROFILE_IDS.map((profile) => AGENT_PROFILES[profile].target),
  ...MODE_IDS.map((mode) => MODES[mode].target)
]);
export const ASSET_KEYS = Object.freeze([
  "policies/mixed.json",
  "policies/openai.json",
  ...AGENT_PROFILE_IDS.map((profile) => AGENT_PROFILES[profile].asset),
  ...MODE_IDS.map((mode) => MODES[mode].asset)
].sort());

export const APP_SECRET = "CODEKEEPER_APP_PRIVATE_KEY";
export const TRACE_SECRET = "OPENAI_TRACE_API_KEY";
export const OPENAI_SECRET = "OPENAI_API_KEY";
export const DEEPSEEK_SECRET = "DEEPSEEK_API_KEY";
export const ENABLED_VARIABLE = "CODEKEEPER_ENABLED";
export const CLIENT_ID_VARIABLE = "CODEKEEPER_APP_CLIENT_ID";
export const BOT_LOGIN_VARIABLE = "CODEKEEPER_AUTOMATION_BOT_LOGIN";

export const SECRET_PURPOSES = Object.freeze({
  [OPENAI_SECRET]: "OpenAI Platform API key for model calls. A ChatGPT subscription does not include this key.",
  [DEEPSEEK_SECRET]: "DeepSeek API key for each role assigned to DeepSeek",
  [TRACE_SECRET]: "Separate OpenAI Platform API key for trace export. Do not reuse the model API key.",
  [APP_SECRET]: "downloaded GitHub App PEM private key used to mint App installation tokens"
});

export const CONSERVATIVE_BOUNDARIES = Object.freeze([
  "Agent profiles guide decisions. They cannot grant write access or change triggers, branches, or permissions.",
  "Every generated workflow pins an exact source commit.",
  "Protected paths and git diff --check stay in place.",
  "The installer opens a setup pull request. It does not merge it or run a workflow."
]);
