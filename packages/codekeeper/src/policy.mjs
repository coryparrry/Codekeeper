export const POLICY_VERSION = 3;

export const AUTOMATION_DEFAULTS = Object.freeze({
  automaticPrReview: true,
  reviewFeedbackTriage: true,
  issueTriage: true,
  ownerRequests: true,
  maintenanceSchedule: "17 7 * * *"
});

export const OPENROUTER_PROVIDER = Object.freeze({
  baseUrl: "https://openrouter.ai/api/v1",
  api: "chat_completions",
  structuredOutputs: false,
  supportsReasoningEffort: false
});

export const DEFERRED_LABEL = Object.freeze({
  color: "C5DEF5",
  description: "Verified work deferred from a pull request"
});

export const REVIEW_REASONING_ESCALATION_DEFAULTS = Object.freeze({
  enabled: true,
  provider: "openai",
  model: "gpt-5.6-luna",
  effort: "max",
  labels: Object.freeze(["security", "risk high"]),
  pathPatterns: Object.freeze([
    ".github/actions/**",
    ".github/codekeeper.json",
    ".github/workflows/**",
    "SECURITY.md",
    "**/auth/**",
    "**/authentication/**",
    "**/authorization/**",
    "**/billing/**",
    "**/crypto/**",
    "**/migration/**",
    "**/migrations/**",
    "**/payments/**",
    "**/permissions/**",
    "**/release/**",
    "**/schema/**",
    "**/schemas/**",
    "**/secrets/**",
    "**/security/**",
    "**/*auth*.*",
    "**/*migration*.*",
    "**/*permission*.*"
  ]),
  minimumChangedLines: 5000,
  minimumSingleFileChangedLines: 1000
});

const LEGACY_LABEL_NAMES = Object.freeze({
  "codekeeper:reviewed": "reviewed",
  "codekeeper:maintenance": "maintenance",
  "codekeeper:ready": "ready",
  "codekeeper:blocked": "blocked",
  "codekeeper:manual-review": "manual review",
  "codekeeper:paused": "paused",
  "codekeeper:auto-repaired": "auto repaired",
  "codekeeper:auto-merge": "auto merge",
  "codekeeper:duplicate-candidate": "duplicate",
  "codekeeper:deferred": "deferred",
  "codekeeper:needs-tests": "needs tests",
  "codekeeper:priority-p1": "priority p1",
  "codekeeper:priority-p2": "priority p2",
  "codekeeper:priority-p3": "priority p3",
  "codekeeper:risk-low": "risk low",
  "codekeeper:risk-medium": "risk medium",
  "codekeeper:risk-high": "risk high",
  "codekeeper:type-bug": "bug",
  "codekeeper:type-enhancement": "enhancement",
  "codekeeper:type-documentation": "documentation",
  "codekeeper:type-question": "question",
  "codekeeper:type-maintenance": "maintenance",
  "codekeeper:type-security": "security",
  "codekeeper:type-testing": "testing"
});

const CLEAN_LABEL_DESCRIPTIONS = Object.freeze({
  reviewed: "Automated review complete",
  maintenance: "Repository maintenance",
  paused: "Automatic work is paused",
  "auto repaired": "Automatically repaired"
});

function cleanLabelName(name) {
  return LEGACY_LABEL_NAMES[name] ?? name;
}

function cleanLabelList(labels) {
  return [...new Set(labels.map(cleanLabelName))];
}

function migrateLegacyLabels(policy) {
  policy.labels = Object.fromEntries(
    Object.entries(policy.labels ?? {}).map(([name, definition]) => [cleanLabelName(name), definition])
  );
  for (const [name, description] of Object.entries(CLEAN_LABEL_DESCRIPTIONS)) {
    if (policy.labels[name]) policy.labels[name].description = description;
  }
  policy.review.allowedLabels = cleanLabelList(policy.review.allowedLabels);
  policy.review.managedLabels = cleanLabelList(policy.review.managedLabels);
  policy.issues.managedLabels = cleanLabelList(policy.issues.managedLabels);
}

export function upgradePolicy(input) {
  const policy = structuredClone(input);
  if (policy.version !== 2 && policy.version !== POLICY_VERSION) {
    throw new Error(`Unsupported Codekeeper policy version: ${policy.version}`);
  }
  if (policy.version === 2) {
    policy.version = POLICY_VERSION;
    policy.automation = { ...AUTOMATION_DEFAULTS };
    policy.review.createDeferredIssues ??= false;
    policy.ai.providers.openrouter ??= structuredClone(OPENROUTER_PROVIDER);
    policy.labels["deferred"] ??= structuredClone(DEFERRED_LABEL);
    if (!policy.issues.managedLabels.includes("deferred")) {
      policy.issues.managedLabels.push("deferred");
    }
  }
  migrateLegacyLabels(policy);
  policy.review.reasoningEscalation ??= structuredClone(REVIEW_REASONING_ESCALATION_DEFAULTS);
  policy.issues.closeResolvedIssues ??= true;
  return policy;
}
