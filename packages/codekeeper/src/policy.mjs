import { LABELS } from "./label-ownership.mjs";

export const POLICY_VERSION = 3;

const POLICY_AGENT_IDS = Object.freeze(["review", "audit", "issue", "fix"]);

export const REPAIR_ALLOWED_PATHS = Object.freeze(["**"]);

export const REPAIR_PROTECTED_PATHS = Object.freeze([
  ".github/actions/**",
  ".github/codekeeper.json",
  ".github/codekeeper/**",
  ".github/workflows/**",
  ".codex/**",
  ".claude/**",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "tools/codekeeper/**",
  "packages/codekeeper/**"
]);

export const REPAIR_LIMITS = Object.freeze({
  maximumFiles: 50,
  maximumChangedLines: 5_000,
  maximumPatchBytes: 5 * 1024 * 1024,
  maximumFileBytes: 1024 * 1024
});

export const REVIEW_MANAGED_LABELS = Object.freeze([
  LABELS.CHANGES_REQUIRED,
  LABELS.REVIEW_NEEDED,
  LABELS.MERGE_READY,
  LABELS.NEEDS_TESTS
]);

export const ISSUE_MANAGED_LABELS = Object.freeze([
  LABELS.AUTOMATED_MAINTENANCE,
  LABELS.READY_FOR_FIX,
  LABELS.REVIEW_NEEDED,
  LABELS.POSSIBLE_DUPLICATE,
  LABELS.DEFERRED,
  LABELS.NEEDS_INFORMATION,
  LABELS.NEEDS_TESTS,
  LABELS.URGENT,
  LABELS.HIGH_PRIORITY,
  LABELS.BUG,
  LABELS.ENHANCEMENT,
  LABELS.DOCUMENTATION,
  LABELS.QUESTION,
  LABELS.MAINTENANCE,
  LABELS.SECURITY,
  LABELS.TESTING
]);

const LEGACY_REVIEW_MANAGED_LABELS = Object.freeze([
  "codekeeper:reviewed",
  "codekeeper:blocked",
  "codekeeper:manual-review",
  "codekeeper:auto-merge",
  "codekeeper:needs-tests",
  "codekeeper:risk-low",
  "codekeeper:risk-medium",
  "codekeeper:risk-high"
]);

const LEGACY_ISSUE_MANAGED_LABELS = Object.freeze([
  "codekeeper:maintenance",
  "codekeeper:ready",
  "codekeeper:manual-review",
  "codekeeper:duplicate-candidate",
  "codekeeper:deferred",
  "codekeeper:needs-information",
  "codekeeper:priority-p1",
  "codekeeper:priority-p2",
  "codekeeper:priority-p3",
  "codekeeper:risk-low",
  "codekeeper:risk-medium",
  "codekeeper:risk-high",
  "codekeeper:type-bug",
  "codekeeper:type-documentation",
  "codekeeper:type-enhancement",
  "codekeeper:type-maintenance",
  "codekeeper:type-question",
  "codekeeper:type-security",
  "codekeeper:type-testing"
]);

const LEGACY_REQUIRED_LABELS = Object.freeze([
  ...new Set([
    ...LEGACY_REVIEW_MANAGED_LABELS,
    ...LEGACY_ISSUE_MANAGED_LABELS,
    "codekeeper:paused",
    "codekeeper:auto-repaired"
  ])
]);

export const LABEL_DEFINITIONS = Object.freeze({
  [LABELS.AUTOMATED_MAINTENANCE]: Object.freeze({ color: "0E8A16", description: "Created from an automated repository maintenance finding" }),
  [LABELS.READY_FOR_FIX]: Object.freeze({ color: "1D76DB", description: "Clear and bounded enough for implementation" }),
  [LABELS.CHANGES_REQUIRED]: Object.freeze({ color: "B60205", description: "Verified changes are required before merge" }),
  [LABELS.REVIEW_NEEDED]: Object.freeze({ color: "FBCA04", description: "Human review or judgment is required" }),
  [LABELS.PAUSED]: Object.freeze({ color: "FBCA04", description: "Automatic work is paused" }),
  [LABELS.MERGE_READY]: Object.freeze({ color: "0E8A16", description: "Meets the configured merge policy" }),
  [LABELS.POSSIBLE_DUPLICATE]: Object.freeze({ color: "CFD3D7", description: "Likely duplicate requiring confirmation" }),
  [LABELS.DEFERRED]: Object.freeze({ color: "C5DEF5", description: "Verified work deferred from a pull request" }),
  [LABELS.NEEDS_INFORMATION]: Object.freeze({ color: "FBCA04", description: "More information is required before work can begin" }),
  [LABELS.NEEDS_TESTS]: Object.freeze({ color: "D4C5F9", description: "Deterministic test coverage is missing" }),
  [LABELS.URGENT]: Object.freeze({ color: "B60205", description: "Urgent priority" }),
  [LABELS.HIGH_PRIORITY]: Object.freeze({ color: "FBCA04", description: "High priority" }),
  [LABELS.BUG]: Object.freeze({ color: "D73A4A", description: "Correctness defect" }),
  [LABELS.ENHANCEMENT]: Object.freeze({ color: "A2EEEF", description: "Feature or product enhancement" }),
  [LABELS.DOCUMENTATION]: Object.freeze({ color: "0075CA", description: "Documentation work" }),
  [LABELS.QUESTION]: Object.freeze({ color: "D876E3", description: "Question or clarification" }),
  [LABELS.MAINTENANCE]: Object.freeze({ color: "C5DEF5", description: "Repository maintenance" }),
  [LABELS.SECURITY]: Object.freeze({ color: "B60205", description: "Security-sensitive work" }),
  [LABELS.TESTING]: Object.freeze({ color: "BFDADC", description: "Test coverage or test infrastructure" })
});

const LEGACY_LABEL_NAMES = Object.freeze({
  "codekeeper:reviewed": null,
  "codekeeper:maintenance": LABELS.AUTOMATED_MAINTENANCE,
  "codekeeper:ready": LABELS.READY_FOR_FIX,
  "codekeeper:blocked": LABELS.CHANGES_REQUIRED,
  "codekeeper:manual-review": LABELS.REVIEW_NEEDED,
  "codekeeper:paused": LABELS.PAUSED,
  "codekeeper:auto-repaired": null,
  "codekeeper:auto-merge": LABELS.MERGE_READY,
  "codekeeper:duplicate-candidate": LABELS.POSSIBLE_DUPLICATE,
  "codekeeper:deferred": LABELS.DEFERRED,
  "codekeeper:needs-information": LABELS.NEEDS_INFORMATION,
  "codekeeper:needs-tests": LABELS.NEEDS_TESTS,
  "codekeeper:priority-p1": LABELS.URGENT,
  "codekeeper:priority-p2": LABELS.HIGH_PRIORITY,
  "codekeeper:priority-p3": null,
  "codekeeper:risk-low": null,
  "codekeeper:risk-medium": null,
  "codekeeper:risk-high": null,
  "codekeeper:type-bug": LABELS.BUG,
  "codekeeper:type-enhancement": LABELS.ENHANCEMENT,
  "codekeeper:type-documentation": LABELS.DOCUMENTATION,
  "codekeeper:type-question": LABELS.QUESTION,
  "codekeeper:type-maintenance": LABELS.MAINTENANCE,
  "codekeeper:type-security": LABELS.SECURITY,
  "codekeeper:type-testing": LABELS.TESTING,
  reviewed: null,
  ready: LABELS.READY_FOR_FIX,
  blocked: LABELS.CHANGES_REQUIRED,
  "manual review": LABELS.REVIEW_NEEDED,
  "auto repaired": null,
  "auto merge": LABELS.MERGE_READY,
  duplicate: LABELS.POSSIBLE_DUPLICATE,
  "priority p1": LABELS.URGENT,
  "priority p2": LABELS.HIGH_PRIORITY,
  "priority p3": null,
  "risk low": null,
  "risk medium": null
});

export const RELEASE_OWNED_POLICY_PATHS = Object.freeze([
  "repository.automationBranchPrefix",
  "ai.providers",
  "ai.tracing.includeSensitiveData",
  "audit.repair.allowedPaths",
  "audit.repair.protectedPaths",
  "audit.repair.allowAdd",
  "audit.repair.maximumFiles",
  "audit.repair.maximumChangedLines",
  "audit.repair.maximumPatchBytes",
  "audit.repair.maximumFileBytes",
  "review.allowedLabels",
  "review.managedLabels",
  "issues.managedLabels",
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

export const REVIEW_REASONING_ESCALATION_DEFAULTS = Object.freeze({
  enabled: true,
  provider: "openai",
  model: "gpt-5.6-luna",
  effort: "max",
  labels: Object.freeze([LABELS.SECURITY, "risk high"]),
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

function migrateLabelList(labels) {
  return [...new Set(labels
    .map((name) => Object.hasOwn(LEGACY_LABEL_NAMES, name) ? LEGACY_LABEL_NAMES[name] : name)
    .filter(Boolean))];
}

function legacyLabelDefinition(name) {
  const current = LEGACY_LABEL_NAMES[name];
  if (current && LABEL_DEFINITIONS[current]) return structuredClone(LABEL_DEFINITIONS[current]);
  return {
    color: "CFD3D7",
    description: "Legacy Codekeeper label retained only for automatic cleanup"
  };
}

function migrateLabels(policy) {
  policy.labels ??= {};
  for (const [legacyName, currentName] of Object.entries(LEGACY_LABEL_NAMES)) {
    if (!Object.hasOwn(policy.labels, legacyName)) continue;
    if (currentName && !Object.hasOwn(policy.labels, currentName)) {
      policy.labels[currentName] = structuredClone(policy.labels[legacyName]);
    }
  }
  for (const [name, definition] of Object.entries(LABEL_DEFINITIONS)) {
    policy.labels[name] = structuredClone(definition);
  }
  for (const name of LEGACY_REQUIRED_LABELS) {
    policy.labels[name] ??= legacyLabelDefinition(name);
  }
  policy.labels["risk high"] ??= {
    color: "B60205",
    description: "Repository-owned high-risk routing label"
  };
  policy.review.allowedLabels = [];
  policy.review.managedLabels = [...new Set([
    ...REVIEW_MANAGED_LABELS,
    ...LEGACY_REVIEW_MANAGED_LABELS
  ])];
  policy.issues.managedLabels = [...new Set([
    ...ISSUE_MANAGED_LABELS,
    ...LEGACY_ISSUE_MANAGED_LABELS
  ])];
}

function applyRepairDefaults(policy) {
  const repair = policy.audit.repair;
  repair.allowedPaths = [...REPAIR_ALLOWED_PATHS];
  repair.protectedPaths = [...REPAIR_PROTECTED_PATHS];
  repair.allowAdd = true;
  Object.assign(repair, REPAIR_LIMITS);
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
  }
  policy.review.reasoningEscalation ??= structuredClone(REVIEW_REASONING_ESCALATION_DEFAULTS);
  policy.issues.closeResolvedIssues ??= true;
  policy.review.allowedLabels = migrateLabelList(policy.review.allowedLabels ?? []);
  policy.review.managedLabels = migrateLabelList(policy.review.managedLabels ?? []);
  policy.issues.managedLabels = migrateLabelList(policy.issues.managedLabels ?? []);
  migrateLabels(policy);
  applyRepairDefaults(policy);
  return policy;
}
