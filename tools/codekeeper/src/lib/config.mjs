import path from "node:path";
import { readJson } from "./io.mjs";

export const AGENT_MODES = Object.freeze(["review", "audit", "issue", "fix"]);
const PROVIDER_APIS = new Set(["responses", "chat_completions"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "max", "xhigh"]);

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid Codekeeper policy: ${message}`);
}

function plainObject(value, name) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function validateUrl(value, name) {
  nonEmptyString(value, name);
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
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${name} must contain finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJsonValue(value[index], `${name}[${index}]`, depth + 1);
    }
    return;
  }
  plainObject(value, name);
  for (const [key, item] of Object.entries(value)) {
    assert(!["__proto__", "constructor", "prototype"].includes(key), `${name} contains a forbidden key`);
    validateJsonValue(item, `${name}.${key}`, depth + 1);
  }
}

const REQUIRED_RUNTIME_LABELS = [
  "codekeeper:reviewed",
  "codekeeper:maintenance",
  "codekeeper:ready",
  "codekeeper:blocked",
  "codekeeper:manual-review",
  "codekeeper:auto-merge",
  "codekeeper:duplicate-candidate",
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

function validateAi(config) {
  plainObject(config.ai, "ai");
  plainObject(config.ai.tracing, "ai.tracing");
  boolean(config.ai.tracing.enabled, "ai.tracing.enabled");
  boolean(config.ai.tracing.includeSensitiveData, "ai.tracing.includeSensitiveData");
  if (config.ai.tracing.includeSensitiveData) {
    assert(config.ai.tracing.enabled, "ai.tracing.includeSensitiveData requires ai.tracing.enabled=true");
  }

  const providers = plainObject(config.ai.providers, "ai.providers");
  assert(Object.keys(providers).length > 0, "ai.providers must not be empty");
  for (const [name, provider] of Object.entries(providers)) {
    assert(/^[a-z][a-z0-9_-]{0,63}$/.test(name), `ai.providers.${name} has an invalid provider name`);
    plainObject(provider, `ai.providers.${name}`);
    validateUrl(provider.baseUrl, `ai.providers.${name}.baseUrl`);
    assert(PROVIDER_APIS.has(provider.api), `ai.providers.${name}.api must be responses or chat_completions`);
    boolean(provider.structuredOutputs, `ai.providers.${name}.structuredOutputs`);
    boolean(provider.supportsReasoningEffort, `ai.providers.${name}.supportsReasoningEffort`);
  }

  const agents = plainObject(config.ai.agents, "ai.agents");
  for (const mode of AGENT_MODES) {
    const agent = plainObject(agents[mode], `ai.agents.${mode}`);
    nonEmptyString(agent.provider, `ai.agents.${mode}.provider`);
    assert(providers[agent.provider], `ai.agents.${mode}.provider references undefined provider ${agent.provider}`);
    nonEmptyString(agent.model, `ai.agents.${mode}.model`);
    assert(REASONING_EFFORTS.has(agent.effort), `ai.agents.${mode}.effort is unsupported`);
    assert(
      agent.effort === "none" || providers[agent.provider].supportsReasoningEffort,
      `ai.agents.${mode}.effort requires ai.providers.${agent.provider}.supportsReasoningEffort=true`
    );
    positiveInteger(agent.maxTurns, `ai.agents.${mode}.maxTurns`);
    positiveInteger(agent.maximumAttempts, `ai.agents.${mode}.maximumAttempts`);
    assert(agent.maxTurns <= 20, `ai.agents.${mode}.maxTurns must be at most 20`);
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

    const workspace = plainObject(agent.workspace, `ai.agents.${mode}.workspace`);
    boolean(workspace.enabled, `ai.agents.${mode}.workspace.enabled`);
    boolean(workspace.allowWrites, `ai.agents.${mode}.workspace.allowWrites`);
    if (workspace.enabled) {
      nonEmptyString(workspace.model, `ai.agents.${mode}.workspace.model`);
      assert(REASONING_EFFORTS.has(workspace.effort), `ai.agents.${mode}.workspace.effort is unsupported`);
    }
    if (mode === "review" || mode === "issue") {
      assert(!workspace.allowWrites, `ai.agents.${mode}.workspace.allowWrites must remain false`);
    }
  }
}

export function getAgentConfig(config, mode) {
  if (!AGENT_MODES.includes(mode)) throw new Error(`Unknown Codekeeper agent mode: ${mode}`);
  const agent = config.ai.agents[mode];
  return {
    mode,
    agent,
    provider: config.ai.providers[agent.provider],
    tracing: config.ai.tracing
  };
}

export function getAgentRuntimeSettings(config, mode) {
  const { agent, provider } = getAgentConfig(config, mode);
  const mutationEnabled = mode === "audit"
    ? config.audit.repair.enabled
    : mode === "fix"
      ? config.issues.allowAiImplementation
      : false;
  const workspaceEnabled = agent.workspace.enabled;
  return {
    mode,
    provider: agent.provider,
    providerApi: provider.api,
    model: agent.model,
    effort: agent.effort,
    maxTurns: agent.maxTurns,
    maximumAttempts: agent.maximumAttempts,
    workspaceEnabled,
    workspaceModel: workspaceEnabled ? agent.workspace.model : "",
    workspaceEffort: workspaceEnabled ? agent.workspace.effort : "",
    workspaceSandbox: workspaceEnabled
      ? (agent.workspace.allowWrites && mutationEnabled ? "workspace-write" : "read-only")
      : ""
  };
}

export async function loadConfig(configPath = ".github/codekeeper.json") {
  const resolved = path.resolve(configPath);
  const config = await readJson(resolved);
  assert(config.version === 2, "version must be 2");
  plainObject(config.repository, "repository");
  nonEmptyString(config.repository.displayName, "repository.displayName");
  nonEmptyString(config.repository.defaultBranch, "repository.defaultBranch");
  nonEmptyString(config.repository.automationBranchPrefix, "repository.automationBranchPrefix");
  assert(!config.repository.automationBranchPrefix.startsWith("/"), "repository.automationBranchPrefix must be repository-relative");
  assert(config.repository.automationBranchPrefix.endsWith("/"), "repository.automationBranchPrefix must end with /");
  assert(config.repository.automationBranchPrefix.length <= 160, "repository.automationBranchPrefix must be at most 160 characters");
  stringArray(config.repository.ownerLogins, "repository.ownerLogins");
  assert(config.repository.ownerLogins.length > 0, "repository.ownerLogins must not be empty");
  stringArray(config.projectInvariants ?? [], "projectInvariants");
  validateAi(config);

  plainObject(config.labels, "labels");
  for (const [name, definition] of Object.entries(config.labels)) {
    plainObject(definition, `label ${name}`);
    assert(/^[0-9A-Fa-f]{6}$/.test(definition.color), `label ${name} has invalid color`);
    assert(typeof definition.description === "string", `label ${name} needs a description`);
  }
  for (const label of REQUIRED_RUNTIME_LABELS) {
    assert(config.labels[label], `runtime requires undefined label ${label}`);
  }

  plainObject(config.review, "review");
  nonNegativeInteger(config.review.maximumBlockingFindings, "review.maximumBlockingFindings");
  nonNegativeInteger(config.review.maximumNonBlockingFindings, "review.maximumNonBlockingFindings");
  positiveInteger(config.review.maximumDiffBytes, "review.maximumDiffBytes");
  positiveInteger(config.review.maximumChangedFiles, "review.maximumChangedFiles");
  boolean(config.review.includeDiffInAgentContext, "review.includeDiffInAgentContext");
  stringArray(config.review.allowedLabels, "review.allowedLabels");
  stringArray(config.review.managedLabels, "review.managedLabels");
  for (const label of [...config.review.allowedLabels, ...config.review.managedLabels]) {
    assert(config.labels[label], `review references undefined label ${label}`);
  }
  const managedReviewLabels = new Set(config.review.managedLabels);
  for (const label of [...REVIEW_MANAGED_LABELS, ...config.review.allowedLabels]) {
    assert(managedReviewLabels.has(label), `review must explicitly manage emitted label ${label}`);
  }

  plainObject(config.audit, "audit");
  positiveInteger(config.audit.maximumIssuesPerRun, "audit.maximumIssuesPerRun");
  plainObject(config.audit.repair, "audit.repair");
  boolean(config.audit.repair.enabled, "audit.repair.enabled");
  stringArray(config.audit.repair.allowedPaths, "audit.repair.allowedPaths");
  stringArray(config.audit.repair.protectedPaths, "audit.repair.protectedPaths");
  stringArray(config.audit.repair.validationCommands, "audit.repair.validationCommands");
  boolean(config.audit.repair.allowAdd, "audit.repair.allowAdd");
  positiveInteger(config.audit.repair.maximumFiles, "audit.repair.maximumFiles");
  positiveInteger(config.audit.repair.maximumChangedLines, "audit.repair.maximumChangedLines");
  positiveInteger(config.audit.repair.maximumPatchBytes, "audit.repair.maximumPatchBytes");
  positiveInteger(config.audit.repair.maximumFileBytes, "audit.repair.maximumFileBytes");

  plainObject(config.issues, "issues");
  boolean(config.issues.closeExactDuplicates, "issues.closeExactDuplicates");
  boolean(config.issues.allowAiImplementation, "issues.allowAiImplementation");
  positiveInteger(config.issues.maximumOpenIssueContext, "issues.maximumOpenIssueContext");
  stringArray(config.issues.managedLabels, "issues.managedLabels");
  for (const label of config.issues.managedLabels) {
    assert(config.labels[label], `issues references undefined label ${label}`);
  }
  const managedIssueLabels = new Set(config.issues.managedLabels);
  for (const label of [...ISSUE_MANAGED_LABELS, ...config.review.allowedLabels]) {
    assert(managedIssueLabels.has(label), `issues must explicitly manage emitted label ${label}`);
  }

  plainObject(config.merge, "merge");
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
