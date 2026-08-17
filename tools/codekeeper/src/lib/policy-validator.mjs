import { isCodekeeperOwnedLabel } from "./label-ownership.mjs";

export const AGENT_MODES = Object.freeze(["review", "audit", "issue", "fix"]);
const PROVIDER_APIS = new Set(["responses", "chat_completions"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "max", "xhigh"]);
const CRON_MONTHS = new Map([["JAN", 1], ["FEB", 2], ["MAR", 3], ["APR", 4], ["MAY", 5], ["JUN", 6], ["JUL", 7], ["AUG", 8], ["SEP", 9], ["OCT", 10], ["NOV", 11], ["DEC", 12]]);
const CRON_WEEKDAYS = new Map([["SUN", 0], ["MON", 1], ["TUE", 2], ["WED", 3], ["THU", 4], ["FRI", 5], ["SAT", 6]]);
const CRON_FIELDS = Object.freeze([
  Object.freeze({ minimum: 0, maximum: 59 }),
  Object.freeze({ minimum: 0, maximum: 23 }),
  Object.freeze({ minimum: 1, maximum: 31 }),
  Object.freeze({ minimum: 1, maximum: 12, names: CRON_MONTHS }),
  Object.freeze({ minimum: 0, maximum: 6, names: CRON_WEEKDAYS })
]);
const LIMITS = Object.freeze({
  stringLength: 16_384,
  listEntries: 128,
  providerEntries: 16,
  labelEntries: 128,
  ownerLogins: 64,
  projectInvariants: 64,
  validationCommands: 16,
  modelSettingsNumberMagnitude: 1_000_000,
  maximumBlockingFindings: 20,
  maximumNonBlockingFindings: 20,
  maximumDiffBytes: 5 * 1024 * 1024,
  maximumChangedFiles: 1_000,
  maximumReasoningEscalationChangedLines: 1_000_000,
  maximumIssuesPerRun: 20,
  maximumRepairFiles: 100,
  maximumRepairChangedLines: 10_000,
  maximumPatchBytes: 5 * 1024 * 1024,
  maximumFileBytes: 1 * 1024 * 1024,
  maximumOpenIssueContext: 200,
  maximumMergeFiles: 50,
  maximumMergeChangedLines: 5_000
});

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid Codekeeper policy: ${message}`);
}

function plainObject(value, name) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value;
}

function fixedObject(value, name, keys) {
  plainObject(value, name);
  const allowedKeys = new Set(keys);
  for (const key of Object.keys(value)) {
    assert(allowedKeys.has(key), `${name} contains an unknown key ${key}`);
  }
  return value;
}

function dynamicObject(value, name, maximumEntries) {
  plainObject(value, name);
  const keys = Object.keys(value);
  assert(keys.length <= maximumEntries, `${name} must contain at most ${maximumEntries} entries`);
  for (const key of keys) {
    assert(key.length <= LIMITS.stringLength, `${name} contains an overlong key`);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, name, maximumLength = LIMITS.stringLength) {
  assert(typeof value === "string" && value.trim().length > 0, `${name} must be a non-empty string`);
  assert(value.length <= maximumLength, `${name} must be at most ${maximumLength} characters`);
  return value;
}

function stringArray(value, name, { maximumEntries = LIMITS.listEntries, maximumLength = LIMITS.stringLength } = {}) {
  assert(Array.isArray(value), `${name} must be an array`);
  assert(value.length <= maximumEntries, `${name} must contain at most ${maximumEntries} entries`);
  for (const item of value) {
    assert(typeof item === "string" && item.trim(), `${name} must contain strings`);
    assert(item.length <= maximumLength, `${name} must contain strings at most ${maximumLength} characters long`);
  }
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

function cappedPositiveInteger(value, name, maximum) {
  positiveInteger(value, name);
  assert(value <= maximum, `${name} must be at most ${maximum}`);
  return value;
}

function cappedNonNegativeInteger(value, name, maximum) {
  nonNegativeInteger(value, name);
  assert(value <= maximum, `${name} must be at most ${maximum}`);
  return value;
}

function boolean(value, name) {
  assert(typeof value === "boolean", `${name} must be a boolean`);
  return value;
}

function cronValue(value, { minimum, maximum, names }) {
  const named = names?.get(value.toUpperCase());
  if (named !== undefined) return named;
  if (!/^\d+$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

function validCronBase(value, field) {
  if (value === "*") return true;
  const range = value.split("-");
  if (range.length === 1) return cronValue(range[0], field) !== null;
  if (range.length !== 2) return false;
  const start = cronValue(range[0], field);
  const end = cronValue(range[1], field);
  return start !== null && end !== null && start <= end;
}

function validCronField(value, field) {
  if (!value || value.startsWith(",") || value.endsWith(",")) return false;
  return value.split(",").every((entry) => {
    const parts = entry.split("/");
    if (parts.length > 2 || !validCronBase(parts[0], field)) return false;
    if (parts.length === 1) return true;
    const step = Number(parts[1]);
    return /^\d+$/.test(parts[1])
      && Number.isSafeInteger(step)
      && step > 0
      && step <= field.maximum - field.minimum + 1;
  });
}

function validCronSchedule(value) {
  const fields = value.trim().split(/\s+/);
  return fields.length === CRON_FIELDS.length
    && fields.every((field, index) => validCronField(field, CRON_FIELDS[index]));
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function validateUrl(value, name) {
  nonEmptyString(value, name, 2_048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    assert(false, `${name} must be a valid URL`);
  }
  assert(
    parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)),
    `${name} must use HTTPS (HTTP is allowed only for explicit loopback development endpoints)`
  );
  assert(!parsed.username && !parsed.password, `${name} must not contain credentials`);
  assert(!parsed.hash, `${name} must not contain a fragment`);
  return value.replace(/\/$/, "");
}

function validateJsonValue(value, name, depth = 0) {
  assert(depth <= 20, `${name} is nested too deeply`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assert(value.length <= LIMITS.stringLength, `${name} must be at most ${LIMITS.stringLength} characters`);
    return;
  }
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${name} must contain finite numbers`);
    assert(Math.abs(value) <= LIMITS.modelSettingsNumberMagnitude, `${name} must have an absolute value at most ${LIMITS.modelSettingsNumberMagnitude}`);
    return;
  }
  if (Array.isArray(value)) {
    assert(value.length <= LIMITS.listEntries, `${name} must contain at most ${LIMITS.listEntries} entries`);
    for (let index = 0; index < value.length; index += 1) {
      validateJsonValue(value[index], `${name}[${index}]`, depth + 1);
    }
    return;
  }
  plainObject(value, name);
  const entries = Object.entries(value);
  assert(entries.length <= LIMITS.listEntries, `${name} must contain at most ${LIMITS.listEntries} entries`);
  for (const [key, item] of entries) {
    assert(!["__proto__", "constructor", "prototype"].includes(key), `${name} contains a forbidden key`);
    assert(key.length <= LIMITS.stringLength, `${name} contains an overlong key`);
    validateJsonValue(item, `${name}.${key}`, depth + 1);
  }
}

function normalizeLogin(value) {
  return String(value ?? "").trim().toLowerCase();
}

function validateAutomationBranchPrefix(value) {
  nonEmptyString(value, "repository.automationBranchPrefix", 160);
  assert(!value.startsWith("/"), "repository.automationBranchPrefix must be repository-relative");
  assert(value.endsWith("/"), "repository.automationBranchPrefix must end with /");
  const components = value.slice(0, -1).split("/");
  assert(
    components.every((component) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component)
      && !component.endsWith(".")
      && !component.toLowerCase().endsWith(".lock")
      && !component.includes("..")),
    "repository.automationBranchPrefix must be a safe Git ref prefix"
  );
  return value;
}

const REQUIRED_RUNTIME_LABELS = [
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
  "codekeeper:needs-tests",
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
];

const REVIEW_MANAGED_LABELS = [
  "codekeeper:reviewed",
  "codekeeper:blocked",
  "codekeeper:manual-review",
  "codekeeper:auto-merge",
  "codekeeper:needs-tests",
  "codekeeper:risk-low",
  "codekeeper:risk-medium",
  "codekeeper:risk-high"
];

const ISSUE_MANAGED_LABELS = [
  "codekeeper:maintenance",
  "codekeeper:ready",
  "codekeeper:manual-review",
  "codekeeper:duplicate-candidate",
  "codekeeper:deferred",
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
];

function validateWriteAuthorityValidationCommands(config) {
  const writeAuthority = config.review.autoRepair || config.audit.repair.enabled || config.issues.allowAiImplementation;
  if (!writeAuthority) return;

  const hasRepositorySpecificCommand = config.audit.repair.validationCommands.some(
    (command) => command.trim() !== "git diff --check"
  );
  assert(
    hasRepositorySpecificCommand,
    "write-authority capabilities require at least one repository-specific validation command beyond git diff --check"
  );
}

function validateAi(config) {
  fixedObject(config.ai, "ai", ["tracing", "providers", "agents"]);
  fixedObject(config.ai.tracing, "ai.tracing", ["enabled", "includeSensitiveData"]);
  boolean(config.ai.tracing.enabled, "ai.tracing.enabled");
  boolean(config.ai.tracing.includeSensitiveData, "ai.tracing.includeSensitiveData");
  if (config.ai.tracing.includeSensitiveData) {
    assert(config.ai.tracing.enabled, "ai.tracing.includeSensitiveData requires ai.tracing.enabled=true");
  }

  const providers = dynamicObject(config.ai.providers, "ai.providers", LIMITS.providerEntries);
  assert(Object.keys(providers).length > 0, "ai.providers must not be empty");
  for (const [name, provider] of Object.entries(providers)) {
    assert(/^[a-z][a-z0-9_-]{0,63}$/.test(name), `ai.providers.${name} has an invalid provider name`);
    fixedObject(provider, `ai.providers.${name}`, ["baseUrl", "api", "structuredOutputs", "supportsReasoningEffort"]);
    validateUrl(provider.baseUrl, `ai.providers.${name}.baseUrl`);
    assert(PROVIDER_APIS.has(provider.api), `ai.providers.${name}.api must be responses or chat_completions`);
    boolean(provider.structuredOutputs, `ai.providers.${name}.structuredOutputs`);
    boolean(provider.supportsReasoningEffort, `ai.providers.${name}.supportsReasoningEffort`);
  }

  const agents = fixedObject(config.ai.agents, "ai.agents", AGENT_MODES);
  for (const mode of AGENT_MODES) {
    const agent = fixedObject(agents[mode], `ai.agents.${mode}`, ["provider", "model", "effort", "maxTurns", "maximumAttempts", "modelSettings", "workspace"]);
    nonEmptyString(agent.provider, `ai.agents.${mode}.provider`, 64);
    assert(providers[agent.provider], `ai.agents.${mode}.provider references undefined provider ${agent.provider}`);
    nonEmptyString(agent.model, `ai.agents.${mode}.model`, 256);
    assert(REASONING_EFFORTS.has(agent.effort), `ai.agents.${mode}.effort is unsupported`);
    assert(
      agent.effort === "none" || providers[agent.provider].supportsReasoningEffort,
      `ai.agents.${mode}.effort requires ai.providers.${agent.provider}.supportsReasoningEffort=true`
    );
    positiveInteger(agent.maxTurns, `ai.agents.${mode}.maxTurns`);
    positiveInteger(agent.maximumAttempts, `ai.agents.${mode}.maximumAttempts`);
    assert(agent.maxTurns === 1, `ai.agents.${mode}.maxTurns must be 1; coordinators are single-turn adjudicators`);
    assert(agent.maximumAttempts <= 5, `ai.agents.${mode}.maximumAttempts must be at most 5`);
    if (agent.modelSettings !== undefined) {
      plainObject(agent.modelSettings, `ai.agents.${mode}.modelSettings`);
      validateJsonValue(agent.modelSettings, `ai.agents.${mode}.modelSettings`);
      if (
        isPlainObject(agent.modelSettings.reasoning)
        && Object.hasOwn(agent.modelSettings.reasoning, "effort")
      ) {
        throw new Error(
          `ai.agents.${mode}.modelSettings.reasoning.effort must not be set; use ai.agents.${mode}.effort`
        );
      }
    }

    const workspace = fixedObject(agent.workspace, `ai.agents.${mode}.workspace`, ["enabled", "allowWrites", "model", "effort"]);
    boolean(workspace.enabled, `ai.agents.${mode}.workspace.enabled`);
    boolean(workspace.allowWrites, `ai.agents.${mode}.workspace.allowWrites`);
    if (workspace.enabled) {
      nonEmptyString(workspace.model, `ai.agents.${mode}.workspace.model`, 256);
      assert(REASONING_EFFORTS.has(workspace.effort), `ai.agents.${mode}.workspace.effort is unsupported`);
    }
    if (mode === "review" || mode === "issue") {
      assert(!workspace.allowWrites, `ai.agents.${mode}.workspace.allowWrites must remain false`);
    }
  }
}
export function validatePolicy(config) {
  fixedObject(config, "policy", ["version", "repository", "projectInvariants", "automation", "ai", "labels", "review", "audit", "issues", "merge"]);
  assert(config.version === 3, "version must be 3");
  fixedObject(config.repository, "repository", ["displayName", "defaultBranch", "ownerLogins", "automationBranchPrefix"]);
  nonEmptyString(config.repository.displayName, "repository.displayName", 256);
  nonEmptyString(config.repository.defaultBranch, "repository.defaultBranch", 255);
  validateAutomationBranchPrefix(config.repository.automationBranchPrefix);
  stringArray(config.repository.ownerLogins, "repository.ownerLogins", { maximumEntries: LIMITS.ownerLogins, maximumLength: 256 });
  assert(config.repository.ownerLogins.length > 0, "repository.ownerLogins must not be empty");
  const normalizedOwnerLogins = config.repository.ownerLogins.map(normalizeLogin);
  assert(new Set(normalizedOwnerLogins).size === normalizedOwnerLogins.length, "repository.ownerLogins must not contain duplicates after normalization");
  config.repository.ownerLogins = normalizedOwnerLogins;
  stringArray(config.projectInvariants ?? [], "projectInvariants", { maximumEntries: LIMITS.projectInvariants, maximumLength: 4_096 });
  fixedObject(config.automation, "automation", ["automaticPrReview", "reviewFeedbackTriage", "issueTriage", "ownerRequests", "maintenanceSchedule"]);
  boolean(config.automation.automaticPrReview, "automation.automaticPrReview");
  boolean(config.automation.reviewFeedbackTriage, "automation.reviewFeedbackTriage");
  boolean(config.automation.issueTriage, "automation.issueTriage");
  boolean(config.automation.ownerRequests, "automation.ownerRequests");
  nonEmptyString(config.automation.maintenanceSchedule, "automation.maintenanceSchedule", 100);
  assert(validCronSchedule(config.automation.maintenanceSchedule), "automation.maintenanceSchedule must use supported GitHub Actions cron syntax");
  validateAi(config);

  dynamicObject(config.labels, "labels", LIMITS.labelEntries);
  for (const [name, definition] of Object.entries(config.labels)) {
    assert(name.length <= 256, `label ${name} has an overlong name`);
    fixedObject(definition, `label ${name}`, ["color", "description"]);
    assert(/^[0-9A-Fa-f]{6}$/.test(definition.color), `label ${name} has invalid color`);
    assert(typeof definition.description === "string", `label ${name} needs a description`);
    assert(definition.description.length <= 1_024, `label ${name} description must be at most 1024 characters`);
  }
  for (const label of REQUIRED_RUNTIME_LABELS) {
    assert(config.labels[label], `runtime requires undefined label ${label}`);
  }

  fixedObject(config.review, "review", ["autoRepair", "createDeferredIssues", "maximumBlockingFindings", "maximumNonBlockingFindings", "allowedLabels", "managedLabels", "maximumDiffBytes", "maximumChangedFiles", "includeDiffInAgentContext", "reasoningEscalation"]);
  boolean(config.review.autoRepair, "review.autoRepair");
  boolean(config.review.createDeferredIssues, "review.createDeferredIssues");
  cappedNonNegativeInteger(config.review.maximumBlockingFindings, "review.maximumBlockingFindings", LIMITS.maximumBlockingFindings);
  cappedNonNegativeInteger(config.review.maximumNonBlockingFindings, "review.maximumNonBlockingFindings", LIMITS.maximumNonBlockingFindings);
  cappedPositiveInteger(config.review.maximumDiffBytes, "review.maximumDiffBytes", LIMITS.maximumDiffBytes);
  cappedPositiveInteger(config.review.maximumChangedFiles, "review.maximumChangedFiles", LIMITS.maximumChangedFiles);
  boolean(config.review.includeDiffInAgentContext, "review.includeDiffInAgentContext");
  stringArray(config.review.allowedLabels, "review.allowedLabels", { maximumLength: 256 });
  stringArray(config.review.managedLabels, "review.managedLabels", { maximumLength: 256 });
  for (const label of [...config.review.allowedLabels, ...config.review.managedLabels]) {
    assert(config.labels[label], `review references undefined label ${label}`);
    assert(isCodekeeperOwnedLabel(label), `review may only emit Codekeeper-owned labels: ${label}`);
  }
  const managedReviewLabels = new Set(config.review.managedLabels);
  for (const label of [...REVIEW_MANAGED_LABELS, ...config.review.allowedLabels]) {
    assert(managedReviewLabels.has(label), `review must explicitly manage emitted label ${label}`);
  }
  const escalation = fixedObject(config.review.reasoningEscalation, "review.reasoningEscalation", ["enabled", "provider", "model", "effort", "labels", "pathPatterns", "minimumChangedLines", "minimumSingleFileChangedLines"]);
  boolean(escalation.enabled, "review.reasoningEscalation.enabled");
  nonEmptyString(escalation.provider, "review.reasoningEscalation.provider", 256);
  assert(config.ai.providers[escalation.provider], `review.reasoningEscalation.provider references undefined provider ${escalation.provider}`);
  nonEmptyString(escalation.model, "review.reasoningEscalation.model", 256);
  assert(REASONING_EFFORTS.has(escalation.effort), "review.reasoningEscalation.effort is unsupported");
  assert(
    escalation.effort === "none" || config.ai.providers[escalation.provider].supportsReasoningEffort,
    `review.reasoningEscalation.effort requires ai.providers.${escalation.provider}.supportsReasoningEffort=true`
  );
  stringArray(escalation.labels, "review.reasoningEscalation.labels", { maximumEntries: LIMITS.listEntries, maximumLength: 256 });
  stringArray(escalation.pathPatterns, "review.reasoningEscalation.pathPatterns", { maximumEntries: LIMITS.listEntries, maximumLength: 1_024 });
  assert(escalation.labels.length > 0, "review.reasoningEscalation.labels must not be empty");
  assert(escalation.pathPatterns.length > 0, "review.reasoningEscalation.pathPatterns must not be empty");
  for (const label of escalation.labels) {
    assert(config.labels[label], `review.reasoningEscalation references undefined label ${label}`);
  }
  cappedPositiveInteger(escalation.minimumChangedLines, "review.reasoningEscalation.minimumChangedLines", LIMITS.maximumReasoningEscalationChangedLines);
  cappedPositiveInteger(escalation.minimumSingleFileChangedLines, "review.reasoningEscalation.minimumSingleFileChangedLines", LIMITS.maximumReasoningEscalationChangedLines);

  fixedObject(config.audit, "audit", ["maximumIssuesPerRun", "repair"]);
  cappedPositiveInteger(config.audit.maximumIssuesPerRun, "audit.maximumIssuesPerRun", LIMITS.maximumIssuesPerRun);
  fixedObject(config.audit.repair, "audit.repair", ["enabled", "allowedPaths", "protectedPaths", "allowAdd", "maximumFiles", "maximumChangedLines", "maximumPatchBytes", "maximumFileBytes", "validationCommands"]);
  boolean(config.audit.repair.enabled, "audit.repair.enabled");
  stringArray(config.audit.repair.allowedPaths, "audit.repair.allowedPaths", { maximumLength: 1_024 });
  stringArray(config.audit.repair.protectedPaths, "audit.repair.protectedPaths", { maximumLength: 1_024 });
  stringArray(config.audit.repair.validationCommands, "audit.repair.validationCommands", { maximumEntries: LIMITS.validationCommands, maximumLength: 8_192 });
  boolean(config.audit.repair.allowAdd, "audit.repair.allowAdd");
  cappedPositiveInteger(config.audit.repair.maximumFiles, "audit.repair.maximumFiles", LIMITS.maximumRepairFiles);
  cappedPositiveInteger(config.audit.repair.maximumChangedLines, "audit.repair.maximumChangedLines", LIMITS.maximumRepairChangedLines);
  cappedPositiveInteger(config.audit.repair.maximumPatchBytes, "audit.repair.maximumPatchBytes", LIMITS.maximumPatchBytes);
  cappedPositiveInteger(config.audit.repair.maximumFileBytes, "audit.repair.maximumFileBytes", LIMITS.maximumFileBytes);

  fixedObject(config.issues, "issues", ["closeExactDuplicates", "closeResolvedIssues", "allowAiImplementation", "maximumOpenIssueContext", "managedLabels"]);
  boolean(config.issues.closeExactDuplicates, "issues.closeExactDuplicates");
  boolean(config.issues.closeResolvedIssues, "issues.closeResolvedIssues");
  boolean(config.issues.allowAiImplementation, "issues.allowAiImplementation");
  cappedPositiveInteger(config.issues.maximumOpenIssueContext, "issues.maximumOpenIssueContext", LIMITS.maximumOpenIssueContext);
  stringArray(config.issues.managedLabels, "issues.managedLabels", { maximumLength: 256 });
  for (const label of config.issues.managedLabels) {
    assert(config.labels[label], `issues references undefined label ${label}`);
    assert(isCodekeeperOwnedLabel(label), `issues may only manage Codekeeper-owned labels: ${label}`);
  }
  const managedIssueLabels = new Set(config.issues.managedLabels);
  for (const label of [...ISSUE_MANAGED_LABELS, ...config.review.allowedLabels]) {
    assert(managedIssueLabels.has(label), `issues must explicitly manage emitted label ${label}`);
  }
  validateWriteAuthorityValidationCommands(config);

  fixedObject(config.merge, "merge", ["enabled", "method", "allowAutomationPullRequests", "allowUserPullRequests", "allowedUserAuthors", "maximumFiles", "maximumChangedLines", "allowedPaths", "blockedPaths"]);
  boolean(config.merge.enabled, "merge.enabled");
  boolean(config.merge.allowAutomationPullRequests, "merge.allowAutomationPullRequests");
  boolean(config.merge.allowUserPullRequests, "merge.allowUserPullRequests");
  assert(!config.merge.allowUserPullRequests, "merge.allowUserPullRequests must remain false in version 3");
  assert(["MERGE", "SQUASH", "REBASE"].includes(config.merge.method), "merge.method must be MERGE, SQUASH, or REBASE");
  cappedPositiveInteger(config.merge.maximumFiles, "merge.maximumFiles", LIMITS.maximumMergeFiles);
  cappedPositiveInteger(config.merge.maximumChangedLines, "merge.maximumChangedLines", LIMITS.maximumMergeChangedLines);
  stringArray(config.merge.allowedPaths, "merge.allowedPaths", { maximumLength: 1_024 });
  stringArray(config.merge.blockedPaths, "merge.blockedPaths", { maximumLength: 1_024 });
  stringArray(config.merge.allowedUserAuthors, "merge.allowedUserAuthors", { maximumEntries: LIMITS.ownerLogins, maximumLength: 256 });
  return config;
}
