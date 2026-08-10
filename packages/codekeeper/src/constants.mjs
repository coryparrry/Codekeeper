export const PACKAGE_NAME = "codekeeper";
export const PACKAGE_VERSION = "0.2.0";
export const MINIMUM_NODE_MAJOR = 22;
export const SOURCE_REPOSITORY = "coryparrry/Codekeeper";
export const SOURCE_COMMIT = "5d87b00917a750344b4fc5dc78a1f6437439001c";
export const SETUP_BRANCH = "codekeeper/setup";
export const SETUP_COMMIT_MESSAGE = "chore(codekeeper): add disabled setup";
export const SETUP_PR_TITLE = "chore(codekeeper): add disabled setup";

export const MODES = Object.freeze({
  review: Object.freeze({
    id: "review",
    label: "Pull request review",
    description: "reviews same-repository pull requests with comments, labels, and a blocking result when enabled",
    policyAgent: "review",
    target: ".github/workflows/codekeeper-review.yml",
    asset: "workflows/review.yml",
    trigger: "same-repository pull request"
  }),
  maintain: Object.freeze({
    id: "maintain",
    label: "Repository maintenance",
    description: "runs repository audits manually or on schedule; start with a no-change dry run",
    policyAgent: "audit",
    target: ".github/workflows/codekeeper-maintain.yml",
    asset: "workflows/maintain.yml",
    trigger: "schedule or manual dry run"
  }),
  issues: Object.freeze({
    id: "issues",
    label: "Issue triage",
    description: "adds issue labels and comments on issue events when enabled; duplicate closure stays off",
    policyAgent: "issue",
    target: ".github/workflows/codekeeper-issues.yml",
    asset: "workflows/issues.yml",
    trigger: "issue or issue comment"
  }),
  fix: Object.freeze({
    id: "fix",
    label: "Owner-authorized issue fix",
    description: "advanced; can open a repair PR only after an owner command and separate policy opt-in; auto-merge stays off",
    policyAgent: "fix",
    target: ".github/workflows/codekeeper-fix.yml",
    asset: "workflows/fix.yml",
    trigger: "owner command or manual dry run"
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
    purpose: "Editable owner-commanded repair judgment rules"
  })
});
export const AGENT_PROFILE_IDS = Object.freeze(Object.keys(AGENT_PROFILES));
export const PRESET_IDS = Object.freeze(["mixed", "openai"]);
export const RECOMMENDED_MODES = Object.freeze(["review", "maintain"]);
export const RECOMMENDED_PRESET = "openai";
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
  [OPENAI_SECRET]: "OpenAI Platform API key for model calls after enablement; this is not a ChatGPT subscription",
  [DEEPSEEK_SECRET]: "DeepSeek API key for issue triage when the mixed preset is selected",
  [TRACE_SECRET]: "separate OpenAI Platform API key for trace export; do not reuse the model-provider key",
  [APP_SECRET]: "downloaded GitHub App PEM private key used to mint App installation tokens"
});

export const CONSERVATIVE_BOUNDARIES = Object.freeze([
  "Codekeeper is installed disabled; CODEKEEPER_ENABLED remains false.",
  "Repository repair, AI issue implementation, and automatic merge remain disabled.",
  "Editable Markdown profiles tune judgment only; they cannot grant writes, merge, branch, trigger, or authorization permissions.",
  "Generated workflows use an immutable full source commit SHA.",
  "Protected paths and git diff --check remain enforced.",
  "The installer never merges a pull request or dispatches a workflow."
]);
