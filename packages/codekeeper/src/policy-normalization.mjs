import { LABELS, LEGACY_CODEKEEPER_OWNED_LABELS } from "./label-ownership.mjs";

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

export const AGENT_EMITTABLE_LABELS = Object.freeze([
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

export const LEGACY_REVIEW_MANAGED_LABELS = Object.freeze([
  "codekeeper:reviewed",
  "codekeeper:blocked",
  "codekeeper:manual-review",
  "codekeeper:auto-merge",
  "codekeeper:needs-tests",
  "codekeeper:risk-low",
  "codekeeper:risk-medium",
  "codekeeper:risk-high"
]);

export const LEGACY_ISSUE_MANAGED_LABELS = Object.freeze([
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

export const LEGACY_REQUIRED_LABELS = Object.freeze([
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

export const REQUIRED_RUNTIME_LABELS = Object.freeze([
  ...new Set([
    ...Object.keys(LABEL_DEFINITIONS),
    ...LEGACY_CODEKEEPER_OWNED_LABELS,
    "risk high"
  ])
]);

export function legacyLabelDefinition() {
  return {
    color: "CFD3D7",
    description: "Legacy Codekeeper label retained only for automatic cleanup"
  };
}

export function applyRepairDefaults(policy) {
  const repair = policy.audit.repair;
  repair.allowedPaths = [...REPAIR_ALLOWED_PATHS];
  repair.protectedPaths = [...REPAIR_PROTECTED_PATHS];
  repair.allowAdd = true;
  Object.assign(repair, REPAIR_LIMITS);
}

export function applyLabelCatalog(policy) {
  policy.labels ??= {};
  for (const [name, definition] of Object.entries(LABEL_DEFINITIONS)) {
    policy.labels[name] = structuredClone(definition);
  }
  for (const name of LEGACY_CODEKEEPER_OWNED_LABELS) {
    policy.labels[name] ??= legacyLabelDefinition();
  }
  policy.labels["risk high"] ??= {
    color: "B60205",
    description: "Repository-owned high-risk routing label"
  };
}

export function applyManagedLabelSets(policy) {
  policy.review.allowedLabels = [...AGENT_EMITTABLE_LABELS];
  policy.review.managedLabels = [...new Set([
    ...REVIEW_MANAGED_LABELS,
    ...LEGACY_REVIEW_MANAGED_LABELS
  ])];
  policy.issues.managedLabels = [...new Set([
    ...ISSUE_MANAGED_LABELS,
    ...LEGACY_ISSUE_MANAGED_LABELS
  ])];
}

export function normalizeLivePolicy(input) {
  const config = structuredClone(input);
  applyLabelCatalog(config);
  applyManagedLabelSets(config);
  applyRepairDefaults(config);
  return config;
}
