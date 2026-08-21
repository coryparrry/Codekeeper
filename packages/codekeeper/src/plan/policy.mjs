import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  PRESET_IDS
} from "../constants.mjs";
import { MODE_REGISTRY } from "../mode-registry.mjs";
import { InstallerError } from "../errors.mjs";
import { upgradePolicy } from "../policy.mjs";
import { createEditableSettings } from "../settings.mjs";

export function assertSupportedPreset(preset) {
  if (!PRESET_IDS.includes(preset))
    throw new InstallerError(`Unsupported preset: ${preset}`, {
      code: "PLAN_INVALID"
    });
}

export function loadBaselinePolicy(policySource) {
  return upgradePolicy(JSON.parse(policySource));
}

export function createValidationBaselinePolicy({
  releaseUpdate,
  baselinePolicy,
  bundle,
  preset,
  defaultBranch
}) {
  const validationBaselinePolicy = releaseUpdate
    ? upgradePolicy(JSON.parse(bundle.contents[`policies/${preset}.json`]))
    : baselinePolicy;
  validationBaselinePolicy.repository.defaultBranch = defaultBranch;
  return validationBaselinePolicy;
}

export function createInputPolicy({
  answers,
  baselinePolicy,
  modes,
  maintenanceScheduled,
  snapshot,
  installation,
  effectiveProfiles,
  packagedProfileDefaults
}) {
  return structuredClone(
    answers.policy ??
    createEditableSettings({
      policy: baselinePolicy,
      modes,
      enabled: answers.enabled !== false,
      maintenanceScheduled,
      validationCommandCandidate: snapshot.validationCommandCandidate,
      validationCommand: answers.validationCommand,
      profiles: answers.profiles ?? effectiveProfiles,
      profileDefaults: packagedProfileDefaults,
      profileSources: answers.profileSources,
      profileOverrides: installation ? AGENT_PROFILE_IDS.filter((id) => Object.hasOwn(installation.contents, AGENT_PROFILES[id].target)) : []
    }).policy
  );
}

export function resolveValidationCommand(answers, snapshot) {
  return answers.validationCommand === snapshot.validationCommandCandidate
    ? answers.validationCommand
    : null;
}

export function assertCodeChangingRequirements(capabilities, validationCommand, snapshot) {
  const codeChanging = capabilities.reviewRepair || capabilities.repair || capabilities.issueImplementation;
  if (codeChanging && !validationCommand) {
    throw new InstallerError(
      snapshot.validationCommandCandidate
        ? `Confirm ${snapshot.validationCommandCandidate} before enabling code-changing capabilities.`
        : "Code-changing capabilities require a trusted repository validation command. Add a supported root package lockfile and check or test script, then rerun setup.",
      { code: "PLAN_INVALID" },
    );
  }
}

export function applyValidationCommand(inputPolicy, validationCommand) {
  if (validationCommand) {
    inputPolicy.audit.repair.validationCommands = [
      "git diff --check",
      ...inputPolicy.audit.repair.validationCommands.filter((command) => command !== "git diff --check" && command !== validationCommand),
      validationCommand,
    ];
  }
}

export function applyPolicyCapabilities(inputPolicy, capabilities, tracing) {
  inputPolicy.review.autoRepair = capabilities.reviewRepair;
  inputPolicy.audit.repair.enabled = capabilities.repair;
  inputPolicy.issues.allowAiImplementation = capabilities.issueImplementation;
  inputPolicy.issues.closeExactDuplicates = capabilities.duplicateClosure;
  inputPolicy.merge.enabled = capabilities.autoMerge;
  inputPolicy.ai.tracing.enabled = tracing;
}

export function applyModelSettings(inputPolicy, models) {
  for (const [mode, selection] of Object.entries(models)) {
    const agent = inputPolicy.ai.agents[MODE_REGISTRY[mode]?.policyAgent ?? mode];
    agent.provider = selection.provider;
    agent.model = selection.model;
    agent.effort = selection.effort;
    agent.modelSettings = Object.hasOwn(selection, "modelSettings")
      ? structuredClone(selection.modelSettings)
      : selection.provider === "openai"
        ? { text: { verbosity: "low" } }
        : selection.provider === "deepseek"
          ? { temperature: 0.2, providerData: { thinking: { type: "disabled" }, response_format: { type: "json_object" } } }
          : {};
  }
}
