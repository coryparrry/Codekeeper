import {
  ISSUE_SEMANTIC_LABELS,
  LABELS,
  LEGACY_CODEKEEPER_OWNED_LABELS,
  LEGACY_ISSUE_LABELS,
  LEGACY_LIFECYCLE_LABELS,
  LEGACY_PR_LABELS,
  PR_SEMANTIC_LABELS
} from "./label-ownership.mjs";

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

// OA-01 reserves the orchestration policy surface without granting it any
// execution authority. These defaults are applied to older adopter policies
// before validation so adding the closed object is backwards compatible.
export const ORCHESTRATION_DEFAULTS = Object.freeze({
  enabled: false,
  modes: Object.freeze({
    review: false,
    issues: false,
    fix: false,
    maintain: false
  }),
  maximumSpecialists: 4,
  maximumConcurrency: 3,
  maximumToolCalls: 6,
  maximumTokensPerAgent: 32_000,
  maximumTotalTokens: 96_000,
  maximumOutputBytes: 262_144,
  maximumAutomaticRepairRounds: 1,
  providerMultiAgent: false
});

export const REVIEW_MANAGED_LABELS = Object.freeze([...PR_SEMANTIC_LABELS]);

export const ISSUE_NEEDS_TESTS_LABEL = LABELS.ISSUE_NEEDS_TESTS ?? "issue needs tests";

export const AGENT_EMITTABLE_LABELS = Object.freeze([
  LABELS.NEEDS_TESTS
]);

// Model-proposed labels are mode inputs, not a shared ownership pool. Review
// output currently only needs the deterministic test-coverage signal; issue
// triage retains the older type labels plus that signal for compatibility.
export const REVIEW_ALLOWED_LABELS = Object.freeze([
  ...AGENT_EMITTABLE_LABELS
]);

export const ISSUE_ALLOWED_LABELS = Object.freeze([
  LABELS.BUG,
  LABELS.ENHANCEMENT,
  LABELS.DOCUMENTATION,
  LABELS.QUESTION,
  LABELS.SECURITY,
  LABELS.MAINTENANCE,
  LABELS.TESTING,
  ISSUE_NEEDS_TESTS_LABEL
]);

export const ISSUE_MANAGED_LABELS = Object.freeze([...ISSUE_SEMANTIC_LABELS]);

export const LEGACY_REVIEW_MANAGED_LABELS = Object.freeze([...LEGACY_PR_LABELS]);

export const LEGACY_ISSUE_MANAGED_LABELS = Object.freeze([...LEGACY_ISSUE_LABELS]);

export const LEGACY_REQUIRED_LABELS = Object.freeze([
  ...new Set([
    ...LEGACY_REVIEW_MANAGED_LABELS,
    ...LEGACY_ISSUE_MANAGED_LABELS,
    ...LEGACY_LIFECYCLE_LABELS
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
  [LABELS.TESTING]: Object.freeze({ color: "BFDADC", description: "Test coverage or test infrastructure" }),
  [ISSUE_NEEDS_TESTS_LABEL]: Object.freeze({ color: "D4C5F9", description: "Issue triage needs test coverage" })
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

export function applyOrchestrationDefaults(policy) {
  const existing = policy.ai.orchestration;
  if (existing === undefined) {
    policy.ai.orchestration = structuredClone(ORCHESTRATION_DEFAULTS);
  } else if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    policy.ai.orchestration = {
      ...structuredClone(ORCHESTRATION_DEFAULTS),
      ...existing,
      ...(existing.modes && typeof existing.modes === "object" && !Array.isArray(existing.modes)
        ? { modes: { ...ORCHESTRATION_DEFAULTS.modes, ...existing.modes } }
        : {})
    };
  }
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

const LEGACY_ISSUE_ALLOWLIST_MIGRATIONS = Object.freeze({
  "codekeeper:type-bug": LABELS.BUG,
  "codekeeper:type-enhancement": LABELS.ENHANCEMENT,
  "codekeeper:type-documentation": LABELS.DOCUMENTATION,
  "codekeeper:type-question": LABELS.QUESTION,
  "codekeeper:type-maintenance": LABELS.MAINTENANCE,
  "codekeeper:type-security": LABELS.SECURITY,
  "codekeeper:type-testing": LABELS.TESTING,
  "codekeeper:needs-tests": ISSUE_NEEDS_TESTS_LABEL,
  [LABELS.NEEDS_TESTS]: ISSUE_NEEDS_TESTS_LABEL
});

function migrateIssueAllowedLabels(labels, { filter = false, migrateNeedsTests = false } = {}) {
  const migrated = [...new Set((labels ?? []).map((label) => {
    if (!migrateNeedsTests && (label === "codekeeper:needs-tests" || label === LABELS.NEEDS_TESTS)) return label;
    return LEGACY_ISSUE_ALLOWLIST_MIGRATIONS[label] ?? label;
  }))];
  return filter ? migrated.filter((label) => ISSUE_ALLOWED_LABELS.includes(label)) : migrated;
}

export function applyManagedLabelSets(policy) {
  const legacySharedAllowlist = !Object.hasOwn(policy.issues ?? {}, "allowedLabels");
  const configuredIssueLabels = policy.issues?.allowedLabels;
  const configuredReviewLabels = policy.review?.allowedLabels;

  // Policies written before OA-04 used review.allowedLabels for both model
  // modes. Preserve those values for issue triage while resetting review to
  // its narrow, deterministic allowlist. Once the new field exists, keep both
  // mode-specific inputs intact for policy validation.
  if (legacySharedAllowlist) {
    policy.issues.allowedLabels = Array.isArray(configuredReviewLabels) && configuredReviewLabels.length > 0
      ? migrateIssueAllowedLabels(configuredReviewLabels, { filter: true, migrateNeedsTests: true })
      : [...ISSUE_ALLOWED_LABELS];
  } else if (Array.isArray(configuredIssueLabels)) {
    policy.issues.allowedLabels = migrateIssueAllowedLabels(configuredIssueLabels);
  } else if (!Array.isArray(configuredIssueLabels)) {
    policy.issues.allowedLabels = [...ISSUE_ALLOWED_LABELS];
  }

  policy.review.allowedLabels = legacySharedAllowlist
    ? [...REVIEW_ALLOWED_LABELS]
    : Array.isArray(configuredReviewLabels)
      ? [...new Set(configuredReviewLabels)]
      : [...REVIEW_ALLOWED_LABELS];
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
  try {
    const config = structuredClone(input);
    applyLabelCatalog(config);
    applyManagedLabelSets(config);
    applyRepairDefaults(config);
    applyOrchestrationDefaults(config);
    return config;
  } catch (error) {
    throw new Error(`Invalid Codekeeper policy: ${error.message}`, { cause: error });
  }
}
