import { LABELS } from "./label-ownership.mjs";
import {
  applyLabelCatalog,
  applyManagedLabelSets,
  applyOrchestrationDefaults,
  applyRepairDefaults,
  ISSUE_MANAGED_LABELS,
  LABEL_DEFINITIONS,
  LEGACY_ISSUE_MANAGED_LABELS,
  LEGACY_REQUIRED_LABELS,
  LEGACY_REVIEW_MANAGED_LABELS,
  REPAIR_ALLOWED_PATHS,
  REPAIR_LIMITS,
  REPAIR_PROTECTED_PATHS,
  REVIEW_MANAGED_LABELS,
  legacyLabelDefinition
} from "./policy-normalization.mjs";

export const POLICY_VERSION = 3;

const POLICY_AGENT_IDS = Object.freeze(["review", "audit", "issue", "fix"]);

export {
  ISSUE_MANAGED_LABELS,
  LABEL_DEFINITIONS,
  REPAIR_ALLOWED_PATHS,
  REPAIR_LIMITS,
  REPAIR_PROTECTED_PATHS,
  REVIEW_MANAGED_LABELS
};

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

function legacyLabelDefinitionForMigration(name) {
  const current = LEGACY_LABEL_NAMES[name];
  if (current && LABEL_DEFINITIONS[current]) return structuredClone(LABEL_DEFINITIONS[current]);
  return legacyLabelDefinition();
}

function migrateLabels(policy) {
  for (const [legacyName, currentName] of Object.entries(LEGACY_LABEL_NAMES)) {
    if (!Object.hasOwn(policy.labels, legacyName)) continue;
    if (currentName && !Object.hasOwn(policy.labels, currentName)) {
      policy.labels[currentName] = structuredClone(policy.labels[legacyName]);
    }
  }
  applyLabelCatalog(policy);
  for (const name of LEGACY_REQUIRED_LABELS) {
    policy.labels[name] ??= legacyLabelDefinitionForMigration(name);
  }
  applyManagedLabelSets(policy);
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
  applyOrchestrationDefaults(policy);
  return policy;
}
