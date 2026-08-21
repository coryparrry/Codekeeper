import {
  ALL_MODEL_OPTIONS,
  APP_SECRET,
  MODEL_PROVIDER_SECRETS,
  OPENAI_SECRET,
  RECOMMENDED_PRESET,
  TRACE_SECRET
} from "../constants.mjs";
import { MODE_REGISTRY } from "../mode-registry.mjs";
import { InstallerError } from "../errors.mjs";
import { upgradePolicy } from "../policy.mjs";
import { normalizeModes } from "./normalization.mjs";

export function modelAssignments(modes) {
  return normalizeModes(modes).map((mode) => ({
    key: mode,
    agent: MODE_REGISTRY[mode].policyAgent,
    label: MODE_REGISTRY[mode].agentLabel,
    workflow: MODE_REGISTRY[mode].label
  }));
}

export function requiredSecretNames({ modes, models, preset = RECOMMENDED_PRESET, tracing = true, policy = null }) {
  const selected = normalizeModes(modes);
  const names = [];
  const providers = new Set(modelAssignments(selected).map(({ key, agent }) => models?.[key]?.provider ?? policy?.ai?.agents?.[agent]?.provider ?? (preset === "mixed" && key === "issues" ? "deepseek" : "openai")));
  for (const mode of selected) {
    const agent = policy?.ai?.agents?.[MODE_REGISTRY[mode].policyAgent];
    if (MODE_REGISTRY[mode].workspaceProvider && (!policy || agent?.workspace?.enabled === true)) {
      providers.add(MODE_REGISTRY[mode].workspaceProvider);
    }
  }
  for (const [provider, secret] of Object.entries(MODEL_PROVIDER_SECRETS)) {
    if (providers.has(provider)) names.push(secret);
  }
  if (policy && modelAssignments(selected).some(({ agent }) => policy.ai.agents[agent]?.workspace?.enabled)) names.push(OPENAI_SECRET);
  if (tracing) names.push(TRACE_SECRET);
  names.push(APP_SECRET);
  return Object.freeze([...new Set(names)]);
}

export function existingSecretNames(installation) {
  const providers = new Set(modelAssignments(installation.modes).map(({ agent }) => installation.policy.ai.agents[agent].provider));
  for (const mode of installation.modes) {
    const agent = installation.policy.ai.agents[MODE_REGISTRY[mode].policyAgent];
    if (agent.workspace?.enabled && MODE_REGISTRY[mode].workspaceProvider) providers.add(MODE_REGISTRY[mode].workspaceProvider);
  }
  return new Set([
    ...Object.entries(MODEL_PROVIDER_SECRETS)
      .filter(([provider]) => providers.has(provider))
      .map(([, secret]) => secret),
    ...(modelAssignments(installation.modes).some(({ agent }) => installation.policy.ai.agents[agent]?.workspace?.enabled) ? [OPENAI_SECRET] : []),
    ...(installation.policy.ai.tracing.enabled ? [TRACE_SECRET] : []),
    APP_SECRET
  ]);
}

export function normalizeModelChoices({ modes, preset, bundle, choices = {}, policySource = bundle.contents[`policies/${preset}.json`] }) {
  const selected = normalizeModes(modes);
  const policy = upgradePolicy(JSON.parse(policySource));
  const normalized = {};
  for (const assignment of modelAssignments(selected)) {
    const { key, agent: agentId, workflow } = assignment;
    const agent = policy.ai.agents[agentId];
    const defaultOption = ALL_MODEL_OPTIONS.find((option) => option.provider === agent.provider && option.model === agent.model && option.effort === agent.effort);
    const requested = choices[key] ?? defaultOption?.id;
    const choice = typeof requested === "string" ? ALL_MODEL_OPTIONS.find((option) => option.id === requested) : requested;
    if (!choice || typeof choice !== "object")
      throw new InstallerError(`Model choice is invalid for ${workflow}.`, {
        code: "PLAN_INVALID"
      });
    const provider = String(choice.provider ?? "").trim();
    const model = String(choice.model ?? "").trim();
    const effort = String(choice.effort ?? "none").trim();
    if (!Object.hasOwn(MODEL_PROVIDER_SECRETS, provider) || !policy.ai.providers[provider] || !model || model.length > 256 || /[\s\u0000-\u001f\u007f]/.test(model) || !["none", "minimal", "low", "medium", "high", "max", "xhigh"].includes(effort) || (effort !== "none" && !policy.ai.providers[provider]?.supportsReasoningEffort)) {
      throw new InstallerError(`Model choice is invalid for ${workflow}.`, {
        code: "PLAN_INVALID"
      });
    }
    const preservesCurrentSettings = provider === agent.provider
      && model === agent.model
      && effort === agent.effort;
    normalized[key] = Object.freeze({
      provider,
      model,
      effort,
      choice: typeof requested === "string" ? choice.id : null,
      ...(preservesCurrentSettings ? { modelSettings: structuredClone(agent.modelSettings) } : {})
    });
  }
  const assignmentKeys = new Set(modelAssignments(selected).map(({ key }) => key));
  if (Object.keys(choices).some((key) => !assignmentKeys.has(key))) {
    throw new InstallerError("Model choices do not match the selected workflows.", { code: "PLAN_INVALID" });
  }
  return Object.freeze(normalized);
}

export function modelSummary(modes, effectivePolicy) {
  return Object.freeze(
    Object.fromEntries(
      modes.map((mode) => {
        const agent = effectivePolicy.ai.agents[MODE_REGISTRY[mode].policyAgent];
        return [
          mode,
          Object.freeze({
            coordinator: Object.freeze({
              provider: agent.provider,
              model: agent.model,
              effort: agent.effort
            }),
            workspace: Object.freeze({
              provider: MODE_REGISTRY[mode].workspaceProvider,
              enabled: agent.workspace?.enabled === true,
              model: agent.workspace?.model ?? "",
              effort: agent.workspace?.effort ?? "none",
              allowWrites: agent.workspace?.allowWrites === true
            })
          })
        ];
      })
    )
  );
}
