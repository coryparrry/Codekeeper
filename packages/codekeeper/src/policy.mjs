export const POLICY_VERSION = 3;

const POLICY_AGENT_IDS = Object.freeze(["review", "audit", "issue", "fix"]);

export const RELEASE_OWNED_POLICY_PATHS = Object.freeze([
  "repository.automationBranchPrefix",
  "ai.providers",
  "ai.tracing.includeSensitiveData",
  "audit.repair.protectedPaths",
  "merge.allowUserPullRequests",
  "merge.blockedPaths",
  ...POLICY_AGENT_IDS.flatMap((agentId) => [
    `ai.agents.${agentId}.maxTurns`,
    `ai.agents.${agentId}.workspace.allowWrites`
  ])
]);

function policyPathParts(policyPath) {
  return policyPath.split(".");
}

function policyValue(policy, policyPath) {
  return policyPathParts(policyPath).reduce((value, key) => value?.[key], policy);
}

function setPolicyValue(policy, policyPath, value) {
  const parts = policyPathParts(policyPath);
  const leaf = parts.pop();
  const parent = parts.reduce((current, key) => current[key], policy);
  parent[leaf] = structuredClone(value);
}

export function isReleaseOwnedPolicyPath(policyPath) {
  return RELEASE_OWNED_POLICY_PATHS.some((ownedPath) =>
    policyPath === ownedPath || (ownedPath === "ai.providers" && policyPath.startsWith("ai.providers."))
  );
}

export function applyReleasePolicyBoundaries(policy, requiredPolicy) {
  for (const policyPath of RELEASE_OWNED_POLICY_PATHS) {
    setPolicyValue(policy, policyPath, policyValue(requiredPolicy, policyPath));
  }
  return policy;
}

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
  reviewed: "codekeeper:reviewed",
  ready: "codekeeper:ready",
  blocked: "codekeeper:blocked",
  "manual review": "codekeeper:manual-review",
  paused: "codekeeper:paused",
  "auto repaired": "codekeeper:auto-repaired",
  "auto merge": "codekeeper:auto-merge",
  duplicate: "codekeeper:duplicate-candidate",
  deferred: "codekeeper:deferred",
  "needs tests": "codekeeper:needs-tests",
  "priority p1": "codekeeper:priority-p1",
  "priority p2": "codekeeper:priority-p2",
  "priority p3": "codekeeper:priority-p3",
  "risk low": "codekeeper:risk-low",
  "risk medium": "codekeeper:risk-medium",
  "risk high": "codekeeper:risk-high",
  bug: "codekeeper:type-bug",
  enhancement: "codekeeper:type-enhancement",
  documentation: "codekeeper:type-documentation",
  question: "codekeeper:type-question",
  maintenance: "codekeeper:type-maintenance",
  security: "codekeeper:type-security",
  testing: "codekeeper:type-testing"
});

const OWNED_LABEL_DESCRIPTIONS = Object.freeze({
  "codekeeper:reviewed": "Reviewed by Codekeeper",
  "codekeeper:maintenance": "Created or managed by Codekeeper",
  "codekeeper:paused": "Automatic work is paused",
  "codekeeper:auto-repaired": "Automatically repaired by Codekeeper",
  "codekeeper:type-maintenance": "Repository maintenance"
});

function ownedLabelName(name) {
  return LEGACY_LABEL_NAMES[name] ?? name;
}

function ownedLabelList(labels) {
  return [...new Set(labels.map(ownedLabelName))];
}

function migrateLegacyLabels(policy) {
  policy.labels ??= {};
  for (const [legacyName, ownedName] of Object.entries(LEGACY_LABEL_NAMES)) {
    if (policy.labels[legacyName] && !policy.labels[ownedName]) {
      policy.labels[ownedName] = structuredClone(policy.labels[legacyName]);
    }
  }
  if (policy.labels.maintenance && !policy.labels["codekeeper:maintenance"]) {
    policy.labels["codekeeper:maintenance"] = structuredClone(policy.labels.maintenance);
  }
  for (const [name, description] of Object.entries(OWNED_LABEL_DESCRIPTIONS)) {
    if (policy.labels[name]) policy.labels[name].description = description;
  }
  const legacyIssueMaintenance = policy.issues.managedLabels.includes("maintenance");
  policy.review.allowedLabels = ownedLabelList(policy.review.allowedLabels);
  policy.review.managedLabels = ownedLabelList(policy.review.managedLabels);
  policy.issues.managedLabels = ownedLabelList(policy.issues.managedLabels);
  if (legacyIssueMaintenance && !policy.issues.managedLabels.includes("codekeeper:maintenance")) {
    policy.issues.managedLabels.unshift("codekeeper:maintenance");
  }
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
