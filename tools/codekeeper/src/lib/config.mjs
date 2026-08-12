import { readFile } from "node:fs/promises";
import path from "node:path";
import { AGENT_MODES, validatePolicy } from "./policy-validator.mjs";

export { AGENT_MODES, validatePolicy };

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

export function getAgentRuntimeSettings(config, mode, { mutationAuthorized = true } = {}) {
  const { agent, provider } = getAgentConfig(config, mode);
  const mutationEnabled = mode === "audit"
    ? config.audit.repair.enabled && mutationAuthorized
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
