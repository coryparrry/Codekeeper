export const LABELS = Object.freeze({
  AUTOMATED_MAINTENANCE: "automated maintenance",
  READY_FOR_FIX: "ready for fix",
  CHANGES_REQUIRED: "changes required",
  REVIEW_NEEDED: "review needed",
  PAUSED: "paused",
  MERGE_READY: "merge ready",
  POSSIBLE_DUPLICATE: "possible duplicate",
  DEFERRED: "deferred",
  NEEDS_INFORMATION: "needs information",
  NEEDS_TESTS: "needs tests",
  ISSUE_NEEDS_TESTS: "issue needs tests",
  URGENT: "urgent",
  HIGH_PRIORITY: "high priority",
  BUG: "bug",
  ENHANCEMENT: "enhancement",
  DOCUMENTATION: "documentation",
  QUESTION: "question",
  MAINTENANCE: "maintenance",
  SECURITY: "security",
  TESTING: "testing"
});

// Semantic labels belong to one publication mode. Lifecycle labels are the
// small set of deterministic state markers that either mode may preserve or
// reconcile without taking ownership of the other mode's semantics.
export const PR_SEMANTIC_LABELS = Object.freeze([
  LABELS.CHANGES_REQUIRED,
  LABELS.MERGE_READY,
  LABELS.NEEDS_TESTS
]);

export const ISSUE_SEMANTIC_LABELS = Object.freeze([
  LABELS.READY_FOR_FIX,
  LABELS.POSSIBLE_DUPLICATE,
  LABELS.NEEDS_INFORMATION,
  LABELS.ISSUE_NEEDS_TESTS,
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

export const LIFECYCLE_LABELS = Object.freeze([
  LABELS.AUTOMATED_MAINTENANCE,
  LABELS.REVIEW_NEEDED,
  LABELS.DEFERRED,
  LABELS.PAUSED
]);

export const LEGACY_CODEKEEPER_OWNED_LABELS = Object.freeze([
  "codekeeper:reviewed",
  "codekeeper:maintenance",
  "codekeeper:ready",
  "codekeeper:blocked",
  "codekeeper:manual-review",
  "codekeeper:paused",
  "codekeeper:auto-repaired",
  "codekeeper:auto-merge",
  "codekeeper:duplicate-candidate",
  "codekeeper:deferred",
  "codekeeper:needs-information",
  "codekeeper:needs-tests",
  "codekeeper:priority-p1",
  "codekeeper:priority-p2",
  "codekeeper:priority-p3",
  "codekeeper:risk-low",
  "codekeeper:risk-medium",
  "codekeeper:risk-high",
  "codekeeper:type-bug",
  "codekeeper:type-enhancement",
  "codekeeper:type-documentation",
  "codekeeper:type-question",
  "codekeeper:type-maintenance",
  "codekeeper:type-security",
  "codekeeper:type-testing"
]);

export const LEGACY_PR_LABELS = Object.freeze([
  "codekeeper:reviewed",
  "codekeeper:blocked",
  "codekeeper:manual-review",
  "codekeeper:auto-merge",
  "codekeeper:risk-low",
  "codekeeper:risk-medium",
  "codekeeper:risk-high"
]);

export const LEGACY_ISSUE_LABELS = Object.freeze([
  "codekeeper:maintenance",
  "codekeeper:ready",
  "codekeeper:duplicate-candidate",
  "codekeeper:needs-information",
  "codekeeper:priority-p1",
  "codekeeper:priority-p2",
  "codekeeper:priority-p3",
  "codekeeper:type-bug",
  "codekeeper:type-documentation",
  "codekeeper:type-enhancement",
  "codekeeper:type-maintenance",
  "codekeeper:type-question",
  "codekeeper:type-security",
  "codekeeper:type-testing"
]);

export const LEGACY_LIFECYCLE_LABELS = Object.freeze([
  "codekeeper:paused",
  "codekeeper:auto-repaired",
  "codekeeper:needs-tests",
  "codekeeper:deferred"
]);

export const CODEKEEPER_OWNED_LABELS = Object.freeze([
  ...new Set([
    ...PR_SEMANTIC_LABELS,
    ...ISSUE_SEMANTIC_LABELS,
    ...LIFECYCLE_LABELS,
    ...LEGACY_CODEKEEPER_OWNED_LABELS
  ])
]);

export const PR_MANAGED_LABELS = Object.freeze([
  ...new Set([
    ...PR_SEMANTIC_LABELS,
    ...LEGACY_PR_LABELS
  ])
]);

export const ISSUE_MANAGED_LABELS = Object.freeze([
  ...new Set([
    ...ISSUE_SEMANTIC_LABELS,
    ...LEGACY_ISSUE_LABELS
  ])
]);

export const LIFECYCLE_MANAGED_LABELS = Object.freeze([
  ...new Set([
    ...LIFECYCLE_LABELS,
    ...LEGACY_LIFECYCLE_LABELS
  ])
]);

const OWNED_LABELS = new Set(CODEKEEPER_OWNED_LABELS);
const PR_MANAGED_SET = new Set(PR_MANAGED_LABELS);
const ISSUE_MANAGED_SET = new Set(ISSUE_MANAGED_LABELS);
const LIFECYCLE_MANAGED_SET = new Set(LIFECYCLE_MANAGED_LABELS);

export function isCodekeeperOwnedLabel(label) {
  return typeof label === "string" && OWNED_LABELS.has(label);
}

export function isCodekeeperPullRequestLabel(label) {
  return typeof label === "string" && PR_MANAGED_SET.has(label);
}

export function isCodekeeperIssueLabel(label) {
  return typeof label === "string" && ISSUE_MANAGED_SET.has(label);
}

export function isCodekeeperLifecycleLabel(label) {
  return typeof label === "string" && LIFECYCLE_MANAGED_SET.has(label);
}
