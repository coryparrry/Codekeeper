export const PACKAGE_NAME = "codekeeper";
export const PACKAGE_VERSION = "0.1.0";
export const MINIMUM_NODE_MAJOR = 22;
export const SOURCE_REPOSITORY = "coryparrry/Codekeeper";
export const SOURCE_COMMIT = "1938cd9efc3930d61b78d9e42189d1db3e3e3e9c";
export const SETUP_BRANCH = "codekeeper/setup";
export const SETUP_COMMIT_MESSAGE = "chore(codekeeper): add disabled setup";
export const SETUP_PR_TITLE = "chore(codekeeper): add disabled setup";

export const MODES = Object.freeze({
  review: Object.freeze({
    id: "review",
    label: "Pull request review",
    policyAgent: "review",
    target: ".github/workflows/codekeeper-review.yml",
    asset: "workflows/review.yml",
    trigger: "same-repository pull request"
  }),
  maintain: Object.freeze({
    id: "maintain",
    label: "Repository maintenance",
    policyAgent: "audit",
    target: ".github/workflows/codekeeper-maintain.yml",
    asset: "workflows/maintain.yml",
    trigger: "schedule or manual dry run"
  }),
  issues: Object.freeze({
    id: "issues",
    label: "Issue triage",
    policyAgent: "issue",
    target: ".github/workflows/codekeeper-issues.yml",
    asset: "workflows/issues.yml",
    trigger: "issue or issue comment"
  }),
  fix: Object.freeze({
    id: "fix",
    label: "Owner-authorized issue fix",
    policyAgent: "fix",
    target: ".github/workflows/codekeeper-fix.yml",
    asset: "workflows/fix.yml",
    trigger: "owner command or manual dry run"
  })
});

export const MODE_IDS = Object.freeze(Object.keys(MODES));
export const PRESET_IDS = Object.freeze(["mixed", "openai"]);
export const POLICY_TARGET = ".github/codekeeper.json";
export const KNOWN_TARGETS = Object.freeze([
  POLICY_TARGET,
  ...MODE_IDS.map((mode) => MODES[mode].target)
]);
export const ASSET_KEYS = Object.freeze([
  "policies/mixed.json",
  "policies/openai.json",
  ...MODE_IDS.map((mode) => MODES[mode].asset)
].sort());

export const APP_SECRET = "CODEKEEPER_APP_PRIVATE_KEY";
export const TRACE_SECRET = "OPENAI_TRACE_API_KEY";
export const OPENAI_SECRET = "OPENAI_API_KEY";
export const DEEPSEEK_SECRET = "DEEPSEEK_API_KEY";
export const ENABLED_VARIABLE = "CODEKEEPER_ENABLED";
export const CLIENT_ID_VARIABLE = "CODEKEEPER_APP_CLIENT_ID";
export const BOT_LOGIN_VARIABLE = "CODEKEEPER_AUTOMATION_BOT_LOGIN";

export const CONSERVATIVE_BOUNDARIES = Object.freeze([
  "Codekeeper is installed disabled; CODEKEEPER_ENABLED remains false.",
  "Repository repair, AI issue implementation, and automatic merge remain disabled.",
  "Generated workflows use an immutable full source commit SHA.",
  "Protected paths and git diff --check remain enforced.",
  "The installer never merges a pull request or dispatches a workflow."
]);
