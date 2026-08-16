export {
  PACKAGE_NAME,
  PACKAGE_SOURCE_REPOSITORY as SOURCE_REPOSITORY,
  PACKAGE_VERSION,
} from "./package-identity.mjs";
export const MINIMUM_NODE_MAJOR = 22;
export const SOURCE_COMMIT = "9389f6873ad279c39481cb5a2e39e1f85e06b3c7";
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
    workspaceProvider: "openai",
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
    workspaceProvider: "openai",
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
    workspaceProvider: null,
    target: ".github/workflows/codekeeper-issues.yml",
    asset: "workflows/issues.yml",
    trigger: "issue or issue comment"
  }),
  fix: Object.freeze({
    id: "fix",
    label: "Issue implementation and pull request repair",
    agentLabel: "Fixer",
    description: "Validates and implements ready issues or pull request repairs in one workspace pass.",
    policyAgent: "fix",
    workspaceProvider: "openai",
    target: ".github/workflows/codekeeper-fix.yml",
    asset: "workflows/fix.yml",
    trigger: "ready issue, owner command, or manual run"
  })
});

export const MODE_IDS = Object.freeze(Object.keys(MODES));
export const ASSISTANT_WORKFLOW = Object.freeze({
  id: "assistant",
  label: "Repository assistant",
  target: ".github/workflows/codekeeper-assistant.yml",
  asset: "workflows/assistant.yml",
  description: "Routes configured-owner requests to the installed role workflows."
});
export const PACKAGE_ACQUIRE_ACTION = Object.freeze({
  id: "acquire-package",
  label: "Package acquisition action",
  target: ".github/codekeeper/actions/acquire-package/action.yml",
  asset: "runtime-actions/acquire-package/action.yml",
  sourcePath: ".github/codekeeper/actions/acquire-package/action.yml",
  packagePath: "release/actions/acquire-package/action.yml",
  description: "Downloads and verifies the exact Codekeeper npm release inside each isolated runtime job."
});
export const RUNTIME_WORKFLOWS = Object.freeze(Object.fromEntries([
  ["assistant", "Repository assistant"],
  ...MODE_IDS.map((mode) => [mode, MODES[mode].label])
].map(([id, label]) => [id, Object.freeze({
  id,
  label: `${label} runtime`,
  target: `.github/workflows/codekeeper-runtime-${id}.yml`,
  asset: `runtime-workflows/${id}.yml`,
  sourcePath: `.github/workflows/codekeeper-${id}.yml`,
  packagePath: `release/workflows/codekeeper-${id}.yml`,
  description: `Runs the ${label.toLowerCase()} from the verified Codekeeper package.`
})])));
export const RUNTIME_WORKFLOW_IDS = Object.freeze(Object.keys(RUNTIME_WORKFLOWS));
export const RELEASE_PACKAGE_ASSETS = Object.freeze([
  PACKAGE_ACQUIRE_ACTION,
  ...RUNTIME_WORKFLOW_IDS.map((id) => RUNTIME_WORKFLOWS[id])
]);
export const AGENT_PROFILES = Object.freeze({
  "pr-reviewer": Object.freeze({
    id: "pr-reviewer",
    target: ".github/codekeeper/agents/pr-reviewer.md",
    asset: "agents/pr-reviewer.md",
    purpose: "Pull-request review judgment rules"
  }),
  "repository-auditor": Object.freeze({
    id: "repository-auditor",
    target: ".github/codekeeper/agents/repository-auditor.md",
    asset: "agents/repository-auditor.md",
    purpose: "Repository-audit judgment rules"
  }),
  "issue-triager": Object.freeze({
    id: "issue-triager",
    target: ".github/codekeeper/agents/issue-triager.md",
    asset: "agents/issue-triager.md",
    purpose: "Issue-triage judgment rules"
  }),
  fixer: Object.freeze({
    id: "fixer",
    target: ".github/codekeeper/agents/fixer.md",
    asset: "agents/fixer.md",
    purpose: "Implementation and repair rules"
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
    Object.freeze({ id: "luna-medium", provider: "openai", model: "gpt-5.6-luna", effort: "medium", label: "OpenAI · GPT-5.6 Luna · medium effort" }),
    Object.freeze({ id: "luna-max", provider: "openai", model: "gpt-5.6-luna", effort: "max", label: "OpenAI · GPT-5.6 Luna · max effort" }),
    Object.freeze({ id: "sol-high", provider: "openai", model: "gpt-5.6-sol", effort: "high", label: "OpenAI · GPT-5.6 Sol · high effort" }),
    Object.freeze({ id: "terra-high", provider: "openai", model: "gpt-5.6-terra", effort: "high", label: "OpenAI · GPT-5.6 Terra · high effort" }),
    Object.freeze({ id: "terra-medium", provider: "openai", model: "gpt-5.6-terra", effort: "medium", label: "OpenAI · GPT-5.6 Terra · medium effort" }),
    Object.freeze({ id: "gpt-5.5-medium", provider: "openai", model: "gpt-5.5", effort: "medium", label: "OpenAI · GPT-5.5 · medium effort" }),
    Object.freeze({ id: "gpt-5.5-pro-high", provider: "openai", model: "gpt-5.5-pro", effort: "high", label: "OpenAI · GPT-5.5 Pro · high effort" }),
    Object.freeze({ id: "gpt-5.4-medium", provider: "openai", model: "gpt-5.4", effort: "medium", label: "OpenAI · GPT-5.4 · medium effort" }),
    Object.freeze({ id: "gpt-5.4-mini-medium", provider: "openai", model: "gpt-5.4-mini", effort: "medium", label: "OpenAI · GPT-5.4 mini · medium effort" }),
    Object.freeze({ id: "gpt-5.4-nano-low", provider: "openai", model: "gpt-5.4-nano", effort: "low", label: "OpenAI · GPT-5.4 nano · low effort" }),
    Object.freeze({ id: "gpt-5.3-codex-high", provider: "openai", model: "gpt-5.3-codex", effort: "high", label: "OpenAI · GPT-5.3 Codex · high effort" })
  ]),
  deepseek: Object.freeze([
    Object.freeze({ id: "deepseek-v4-flash", provider: "deepseek", model: "deepseek-v4-flash", effort: "none", label: "DeepSeek · V4 Flash" }),
    Object.freeze({ id: "deepseek-v4-pro", provider: "deepseek", model: "deepseek-v4-pro", effort: "none", label: "DeepSeek · V4 Pro" })
  ]),
  openrouter: Object.freeze([
    Object.freeze({ id: "openrouter-sol", provider: "openrouter", model: "openai/gpt-5.6-sol", effort: "none", label: "OpenRouter · OpenAI GPT-5.6 Sol" })
  ])
});
export const ALL_MODEL_OPTIONS = Object.freeze(Object.values(MODEL_OPTIONS).flat());
export const POLICY_TARGET = ".github/codekeeper.json";
export const RELEASE_MANIFEST_TARGET = ".github/codekeeper-release.json";
export const APP_SECRET = "CODEKEEPER_APP_PRIVATE_KEY";
export const TRACE_SECRET = "OPENAI_TRACE_API_KEY";
export const OPENAI_SECRET = "OPENAI_API_KEY";
export const DEEPSEEK_SECRET = "DEEPSEEK_API_KEY";
export const OPENROUTER_SECRET = "OPENROUTER_API_KEY";
export const MODEL_PROVIDER_SECRETS = Object.freeze({
  openai: OPENAI_SECRET,
  deepseek: DEEPSEEK_SECRET,
  openrouter: OPENROUTER_SECRET
});
export const ENABLED_VARIABLE = "CODEKEEPER_ENABLED";
export const CLIENT_ID_VARIABLE = "CODEKEEPER_APP_CLIENT_ID";
export const BOT_LOGIN_VARIABLE = "CODEKEEPER_AUTOMATION_BOT_LOGIN";

export const SECRET_PURPOSES = Object.freeze({
  [OPENAI_SECRET]: "OpenAI Platform API key for model calls. A ChatGPT subscription does not include this key.",
  [DEEPSEEK_SECRET]: "DeepSeek API key for each role assigned to DeepSeek",
  [OPENROUTER_SECRET]: "OpenRouter API key for each role assigned to OpenRouter",
  [TRACE_SECRET]: "Separate OpenAI Platform API key for trace export. Do not reuse the model API key.",
  [APP_SECRET]: "downloaded GitHub App PEM private key used to mint App installation tokens"
});

export const CONSERVATIVE_BOUNDARIES = Object.freeze([
  "Agent profiles guide decisions. They cannot grant write access or change triggers, branches, or permissions.",
  "Every generated workflow pins an exact npm package version and SHA-512 integrity.",
  "Protected paths and git diff --check stay in place.",
  "The installer opens a setup pull request. It does not merge it or run a workflow."
]);
