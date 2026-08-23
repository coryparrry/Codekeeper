import { readFile } from "node:fs/promises";
import path from "node:path";
import { matchesAny } from "./glob.mjs";
import { LABELS, LEGACY_CODEKEEPER_OWNED_LABELS } from "./label-ownership.mjs";
import { AGENT_MODES, validatePolicy } from "./policy-validator.mjs";

export { AGENT_MODES, validatePolicy };

const REPAIR_PROTECTED_PATHS = Object.freeze([
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

const REVIEW_MANAGED_LABELS = Object.freeze([
  LABELS.CHANGES_REQUIRED,
  LABELS.REVIEW_NEEDED,
  LABELS.MERGE_READY,
  LABELS.NEEDS_TESTS,
  "codekeeper:reviewed",
  "codekeeper:blocked",
  "codekeeper:manual-review",
  "codekeeper:auto-merge",
  "codekeeper:needs-tests",
  "codekeeper:risk-low",
  "codekeeper:risk-medium",
  "codekeeper:risk-high"
]);

const ISSUE_MANAGED_LABELS = Object.freeze([
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
  LABELS.TESTING,
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

const LABEL_DEFINITIONS = Object.freeze({
  [LABELS.AUTOMATED_MAINTENANCE]: Object.freeze({ color: "0E8A16", description: "Created from an automated repository maintenance finding" }),
  [LABELS.READY_FOR_FIX]: Object.freeze({ color: "1D76DB", description: "Clear and bounded enough for implementation" }),
  [LABELS.CHANGES_REQUIRED]: Object.freeze({ color: "B60205", description: "Verified changes are required before merge" }),
  [LABELS.REVIEW_NEEDED]: Object.freeze({ color: "FBCA04", description: "Human review or judgment is required" }),
  [LABELS.PAUSED]: Object.freeze({ color: "FBCA04", description: "Automatic Codekeeper work is paused" }),
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

function legacyLabelDefinition() {
  return {
    color: "CFD3D7",
    description: "Legacy Codekeeper label retained only for automatic cleanup"
  };
}

function normalizeRuntimePolicy(input) {
  const config = structuredClone(input);
  config.labels ??= {};
  for (const [name, definition] of Object.entries(LABEL_DEFINITIONS)) {
    config.labels[name] = structuredClone(definition);
  }
  for (const name of LEGACY_CODEKEEPER_OWNED_LABELS) {
    config.labels[name] ??= legacyLabelDefinition();
  }
  config.labels["risk high"] ??= {
    color: "B60205",
    description: "Repository-owned high-risk routing label"
  };

  config.review.allowedLabels = [];
  config.review.managedLabels = [...new Set(REVIEW_MANAGED_LABELS)];
  config.issues.managedLabels = [...new Set(ISSUE_MANAGED_LABELS)];

  const repair = config.audit.repair;
  repair.allowedPaths = ["**"];
  repair.protectedPaths = [...REPAIR_PROTECTED_PATHS];
  repair.allowAdd = true;
  repair.maximumFiles = 50;
  repair.maximumChangedLines = 5_000;
  repair.maximumPatchBytes = 5 * 1024 * 1024;
  repair.maximumFileBytes = 1024 * 1024;
  return config;
}

export function reviewReasoningEscalation(config, context) {
  const routing = config.review.reasoningEscalation;
  const base = {
    escalated: false,
    provider: config.ai.agents.review.provider,
    model: config.ai.agents.review.model,
    effort: config.ai.agents.review.effort,
    reason: "standard review"
  };
  if (!routing?.enabled || context?.mode !== "review") return base;

  const pullRequest = context.pullRequest ?? {};
  const labels = new Set((pullRequest.labels ?? []).map((label) => String(label).trim().toLowerCase()));
  const matchedLabel = routing.labels.find((label) => labels.has(label.toLowerCase()));
  const matchedPath = (pullRequest.changedFiles ?? []).find((file) => matchesAny(file, routing.pathPatterns));
  const changedLines = Number(pullRequest.changeSummary?.changedLines ?? 0);
  const largestFileChangedLines = Number(pullRequest.changeSummary?.largestFileChangedLines ?? 0);
  let reason = "";
  if (matchedLabel) reason = `label:${matchedLabel}`;
  else if (matchedPath) reason = `path:${matchedPath}`;
  else if (changedLines >= routing.minimumChangedLines) reason = `changed-lines:${changedLines}`;
  else if (largestFileChangedLines >= routing.minimumSingleFileChangedLines) {
    reason = `single-file-changed-lines:${largestFileChangedLines}`;
  }
  if (!reason) return base;
  return {
    escalated: true,
    provider: routing.provider,
    model: routing.model,
    effort: routing.effort,
    reason
  };
}

export function getAgentConfig(config, mode, { context } = {}) {
  if (!AGENT_MODES.includes(mode)) throw new Error(`Unknown Codekeeper agent mode: ${mode}`);
  const configuredAgent = config.ai.agents[mode];
  const escalation = mode === "review" ? reviewReasoningEscalation(config, context) : null;
  const escalationPolicy = config.review?.reasoningEscalation;
  const agent = escalation?.escalated
    ? {
        ...configuredAgent,
        provider: escalation.provider,
        model: escalation.model,
        effort: escalation.effort,
        modelSettings: structuredClone(escalationPolicy?.modelSettings ?? {}),
        workspace: escalationPolicy?.workspace
          ? { ...configuredAgent.workspace, ...escalationPolicy.workspace }
          : configuredAgent.workspace
      }
    : configuredAgent;
  return {
    mode,
    agent,
    provider: config.ai.providers[agent.provider],
    tracing: config.ai.tracing,
    escalation
  };
}

export function getAgentRuntimeSettings(config, mode, { mutationAuthorized = false, context } = {}) {
  const { agent, provider, escalation } = getAgentConfig(config, mode, { context });
  const mutationEnabled = mode === "audit"
    ? config.audit.repair.enabled && mutationAuthorized
    : mode === "fix"
      ? mutationAuthorized
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
    reasoningEscalation: escalation,
    workspaceSandbox: workspaceEnabled
      ? (agent.workspace.allowWrites && mutationEnabled ? "workspace-write" : "read-only")
      : ""
  };
}

export async function loadConfig(configPath = ".github/codekeeper.json") {
  const resolved = path.resolve(configPath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${resolved}: ${error.message}`);
    throw error;
  }
  const config = normalizeRuntimePolicy(parsed);
  validatePolicy(config);
  return { config, path: resolved };
}
