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

export const CODEKEEPER_OWNED_LABELS = Object.freeze(Object.values(LABELS));

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

const OWNED_LABELS = new Set([
  ...CODEKEEPER_OWNED_LABELS,
  ...LEGACY_CODEKEEPER_OWNED_LABELS
]);

export function isCodekeeperOwnedLabel(label) {
  return typeof label === "string" && OWNED_LABELS.has(label);
}
