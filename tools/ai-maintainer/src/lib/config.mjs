import path from "node:path";
import { readJson } from "./io.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid AI maintainer policy: ${message}`);
}

function nonEmptyString(value, name) {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be a non-empty string`);
  return value;
}

function stringArray(value, name) {
  assert(Array.isArray(value), `${name} must be an array`);
  for (const item of value) assert(typeof item === "string" && item.trim(), `${name} must contain strings`);
  assert(new Set(value).size === value.length, `${name} must not contain duplicates`);
  return value;
}

function positiveInteger(value, name) {
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, name) {
  assert(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative integer`);
  return value;
}

function boolean(value, name) {
  assert(typeof value === "boolean", `${name} must be a boolean`);
  return value;
}

const REQUIRED_RUNTIME_LABELS = [
  "ai-maintainer:reviewed",
  "ai-maintainer:maintenance",
  "ai-maintainer:ready",
  "ai-maintainer:blocked",
  "ai-maintainer:manual-review",
  "ai-maintainer:auto-merge",
  "ai-maintainer:duplicate-candidate",
  "ai-maintainer:needs-tests",
  "ai-maintainer:priority-p1",
  "ai-maintainer:priority-p2",
  "ai-maintainer:priority-p3",
  "ai-maintainer:risk-low",
  "ai-maintainer:risk-medium",
  "ai-maintainer:risk-high",
  "ai-maintainer:type-bug",
  "ai-maintainer:type-documentation",
  "ai-maintainer:type-enhancement",
  "ai-maintainer:type-maintenance",
  "ai-maintainer:type-question",
  "ai-maintainer:type-security",
  "ai-maintainer:type-testing"
];

const REVIEW_MANAGED_LABELS = [
  "ai-maintainer:reviewed",
  "ai-maintainer:blocked",
  "ai-maintainer:manual-review",
  "ai-maintainer:auto-merge",
  "ai-maintainer:needs-tests",
  "ai-maintainer:risk-low",
  "ai-maintainer:risk-medium",
  "ai-maintainer:risk-high"
];

const ISSUE_MANAGED_LABELS = [
  "ai-maintainer:maintenance",
  "ai-maintainer:ready",
  "ai-maintainer:manual-review",
  "ai-maintainer:duplicate-candidate",
  "ai-maintainer:priority-p1",
  "ai-maintainer:priority-p2",
  "ai-maintainer:priority-p3",
  "ai-maintainer:risk-low",
  "ai-maintainer:risk-medium",
  "ai-maintainer:risk-high",
  "ai-maintainer:type-bug",
  "ai-maintainer:type-documentation",
  "ai-maintainer:type-enhancement",
  "ai-maintainer:type-maintenance",
  "ai-maintainer:type-question",
  "ai-maintainer:type-security",
  "ai-maintainer:type-testing"
];

export async function loadConfig(configPath = ".github/ai-maintainer.json") {
  const resolved = path.resolve(configPath);
  const config = await readJson(resolved);
  assert(config.version === 1, "version must be 1");
  assert(config.repository && typeof config.repository === "object", "repository is required");
  nonEmptyString(config.repository.displayName, "repository.displayName");
  nonEmptyString(config.repository.defaultBranch, "repository.defaultBranch");
  nonEmptyString(config.repository.automationBranchPrefix, "repository.automationBranchPrefix");
  assert(!config.repository.automationBranchPrefix.startsWith("/"), "repository.automationBranchPrefix must be repository-relative");
  assert(config.repository.automationBranchPrefix.endsWith("/"), "repository.automationBranchPrefix must end with /");
  assert(config.repository.automationBranchPrefix.length <= 160, "repository.automationBranchPrefix must be at most 160 characters");
  stringArray(config.repository.ownerLogins, "repository.ownerLogins");
  assert(config.repository.ownerLogins.length > 0, "repository.ownerLogins must not be empty");
  stringArray(config.projectInvariants ?? [], "projectInvariants");
  assert(config.ai && typeof config.ai === "object", "ai is required");
  for (const mode of ["review", "audit", "issue", "fix"]) {
    nonEmptyString(config.ai[mode]?.model, `ai.${mode}.model`);
    nonEmptyString(config.ai[mode]?.effort, `ai.${mode}.effort`);
  }
  assert(config.labels && typeof config.labels === "object", "labels are required");
  for (const [name, definition] of Object.entries(config.labels)) {
    assert(definition && typeof definition === "object", `label ${name} must be an object`);
    assert(/^[0-9A-Fa-f]{6}$/.test(definition.color), `label ${name} has invalid color`);
    assert(typeof definition.description === "string", `label ${name} needs a description`);
  }
  for (const label of REQUIRED_RUNTIME_LABELS) {
    assert(config.labels[label], `runtime requires undefined label ${label}`);
  }
  assert(config.review && typeof config.review === "object", "review is required");
  nonNegativeInteger(config.review.maximumBlockingFindings, "review.maximumBlockingFindings");
  nonNegativeInteger(config.review.maximumNonBlockingFindings, "review.maximumNonBlockingFindings");
  stringArray(config.review.allowedLabels, "review.allowedLabels");
  stringArray(config.review.managedLabels, "review.managedLabels");
  for (const label of [...config.review.allowedLabels, ...config.review.managedLabels]) {
    assert(config.labels[label], `review references undefined label ${label}`);
  }
  const managedReviewLabels = new Set(config.review.managedLabels);
  for (const label of [...REVIEW_MANAGED_LABELS, ...config.review.allowedLabels]) {
    assert(managedReviewLabels.has(label), `review must explicitly manage emitted label ${label}`);
  }

  assert(config.audit && typeof config.audit === "object", "audit is required");
  positiveInteger(config.audit.maximumIssuesPerRun, "audit.maximumIssuesPerRun");
  assert(config.audit.repair && typeof config.audit.repair === "object", "audit.repair is required");
  stringArray(config.audit.repair.allowedPaths, "audit.repair.allowedPaths");
  stringArray(config.audit.repair.protectedPaths, "audit.repair.protectedPaths");
  stringArray(config.audit.repair.validationCommands, "audit.repair.validationCommands");
  boolean(config.audit.repair.allowAdd, "audit.repair.allowAdd");
  positiveInteger(config.audit.repair.maximumFiles, "audit.repair.maximumFiles");
  positiveInteger(config.audit.repair.maximumChangedLines, "audit.repair.maximumChangedLines");
  positiveInteger(config.audit.repair.maximumPatchBytes, "audit.repair.maximumPatchBytes");
  positiveInteger(config.audit.repair.maximumFileBytes, "audit.repair.maximumFileBytes");

  assert(config.issues && typeof config.issues === "object", "issues is required");
  boolean(config.issues.closeExactDuplicates, "issues.closeExactDuplicates");
  positiveInteger(config.issues.maximumOpenIssueContext, "issues.maximumOpenIssueContext");
  stringArray(config.issues.managedLabels, "issues.managedLabels");
  for (const label of config.issues.managedLabels) {
    assert(config.labels[label], `issues references undefined label ${label}`);
  }
  const managedIssueLabels = new Set(config.issues.managedLabels);
  for (const label of [...ISSUE_MANAGED_LABELS, ...config.review.allowedLabels]) {
    assert(managedIssueLabels.has(label), `issues must explicitly manage emitted label ${label}`);
  }

  assert(config.merge && typeof config.merge === "object", "merge is required");
  boolean(config.merge.enabled, "merge.enabled");
  boolean(config.merge.allowAutomationPullRequests, "merge.allowAutomationPullRequests");
  boolean(config.merge.allowUserPullRequests, "merge.allowUserPullRequests");
  assert(["MERGE", "SQUASH", "REBASE"].includes(config.merge.method), "merge.method must be MERGE, SQUASH, or REBASE");
  positiveInteger(config.merge.maximumFiles, "merge.maximumFiles");
  positiveInteger(config.merge.maximumChangedLines, "merge.maximumChangedLines");
  stringArray(config.merge.allowedPaths, "merge.allowedPaths");
  stringArray(config.merge.blockedPaths, "merge.blockedPaths");
  stringArray(config.merge.allowedUserAuthors, "merge.allowedUserAuthors");
  return { config, path: resolved };
}
