import { readFile } from "node:fs/promises";
import path from "node:path";
import { matchesAny } from "./glob.mjs";
import { AGENT_MODES, validatePolicy } from "./policy-validator.mjs";

export { AGENT_MODES, validatePolicy };

export function reviewReasoningEscalation(config, context) {
  const routing = config.review.reasoningEscalation;
  const base = {
    escalated: false,
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
    model: routing.model,
    effort: routing.effort,
    reason
  };
}

export function getAgentConfig(config, mode, { context } = {}) {
  if (!AGENT_MODES.includes(mode)) throw new Error(`Unknown Codekeeper agent mode: ${mode}`);
  const configuredAgent = config.ai.agents[mode];
  const escalation = mode === "review" ? reviewReasoningEscalation(config, context) : null;
  const agent = escalation?.escalated
    ? {
        ...configuredAgent,
        model: escalation.model,
        effort: escalation.effort,
        workspace: {
          ...configuredAgent.workspace,
          model: escalation.model,
          effort: escalation.effort
        }
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
  let config;
  try {
    config = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${resolved}: ${error.message}`);
    throw error;
  }
  validatePolicy(config);
  return { config, path: resolved };
}
