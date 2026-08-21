import { registrationAppPermissions } from "../app-permissions.mjs";
import {
  BOT_LOGIN_VARIABLE,
  CLIENT_ID_VARIABLE,
  ENABLED_VARIABLE,
  MODEL_PROVIDER_SECRETS,
  SECRET_PURPOSES,
  SETUP_BRANCH,
  SETUP_COMMIT_MESSAGE,
  SETUP_PR_TITLE
} from "../constants.mjs";
import { AGENT_PROFILE_IDS, AGENT_PROFILES, MODE_IDS } from "../mode-registry.mjs";
export { resolveModePlan } from "../mode-plan.mjs";
import { InstallerError } from "../errors.mjs";
import { normalizeProfileSettings, validateEditableSettings } from "../settings.mjs";
import {
  applicableCapabilityIds,
  capabilitySummary,
  normalizeCapabilities,
  requiresAutomationBotLogin
} from "./capabilities.mjs";
import { changedInstallFiles, renderPlannedInstallFiles } from "./files.mjs";
import {
  existingSecretNames,
  modelAssignments,
  modelSummary,
  normalizeModelChoices,
  requiredSecretNames
} from "./models.mjs";
import {
  BOT_LOGIN,
  normalizeModes,
  normalizeOwnerLogins,
  validClientId,
  validDisplayName
} from "./normalization.mjs";
import {
  applyModelSettings,
  applyPolicyCapabilities,
  applyValidationCommand,
  assertCodeChangingRequirements,
  assertSupportedPreset,
  createInputPolicy,
  createValidationBaselinePolicy,
  loadBaselinePolicy,
  resolveValidationCommand
} from "./policy.mjs";
import {
  collectAppAnswers,
  collectAppPrivateKeyPath,
  collectAutomationBotLogin,
  collectSetupAnswers
} from "./prompts.mjs";
import {
  completionGuidance,
  documentMap,
  setupPullRequestBody,
  workflowMap
} from "./pull-request.mjs";
import { buildUpdateAnswers } from "./update.mjs";

export {
  normalizeModes,
  normalizeOwnerLogins
};
export {
  modelAssignments,
  normalizeModelChoices,
  requiredSecretNames
};
export {
  applicableCapabilityIds,
  capabilitySummary,
  normalizeCapabilities,
  requiresAutomationBotLogin
};
export {
  documentMap,
  workflowMap,
  completionGuidance,
  setupPullRequestBody
};
export { buildUpdateAnswers };
export {
  collectSetupAnswers,
  collectAutomationBotLogin,
  collectAppAnswers,
  collectAppPrivateKeyPath
};

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function appPermissions({ modes = MODE_IDS, capabilities = ["reviewRepair", "repair", "issueImplementation", "autoMerge"], ownerRequests = true } = {}) {
  return registrationAppPermissions({
    modes: normalizeModes(modes),
    capabilities,
    ownerRequests
  });
}

export function appRegistrationUrl({ repository, displayName, ownerType = "User", modes, capabilities, ownerRequests = true }) {
  const [owner] = repository.split("/");
  if (ownerType !== "User" && ownerType !== "Organization") {
    throw new InstallerError("GitHub App registration requires a personal or organization repository owner.", { code: "PLAN_INVALID" });
  }
  const name = `Codekeeper ${displayName}`.slice(0, 34);
  const permissions = appPermissions({ modes, capabilities, ownerRequests });
  const parameters = new URLSearchParams({
    name,
    description: `Codekeeper automation for ${repository}`,
    url: `https://github.com/${repository}`,
    public: "false",
    webhook_active: "false",
    contents: permissions.contents,
    issues: permissions.issues,
    pull_requests: permissions.pullRequests,
    metadata: permissions.metadata
  });
  const registrationPath = ownerType === "Organization"
    ? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "/settings/apps/new";
  return `https://github.com${registrationPath}?${parameters.toString()}#codekeeper-${owner.toLowerCase()}`;
}

export function buildInstallPlan({ bundle, snapshot, answers }) {
  const modes = normalizeModes(answers.modes);
  const installation = snapshot.installation ?? null;
  const maintenanceScheduled = answers.maintenanceScheduled ?? installation?.maintenanceScheduled ?? true;
  if (typeof maintenanceScheduled !== "boolean") {
    throw new InstallerError("Scheduled maintenance choice is invalid.", {
      code: "PLAN_INVALID"
    });
  }
  const releaseUpdate = Boolean(installation && answers.releaseUpdate === true);
  const operation = releaseUpdate ? "release-update" : installation ? "configuration-update" : "setup";
  const policySource = installation?.policySource ?? bundle.contents[`policies/${answers.preset}.json`];
  assertSupportedPreset(answers.preset);
  const baselinePolicy = loadBaselinePolicy(policySource);
  const validationBaselinePolicy = createValidationBaselinePolicy({
    releaseUpdate,
    baselinePolicy,
    bundle,
    preset: answers.preset,
    defaultBranch: snapshot.defaultBranch
  });
  const effectiveProfiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id,
    installation?.contents[AGENT_PROFILES[id].target] ?? bundle.contents[AGENT_PROFILES[id].asset]
  ]));
  const packagedProfileDefaults = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  const inputPolicy = createInputPolicy({
    answers,
    baselinePolicy,
    modes,
    maintenanceScheduled,
    snapshot,
    installation,
    effectiveProfiles,
    packagedProfileDefaults
  });
  const displayName = answers.policy?.repository.displayName ?? answers.displayName;
  if (!validDisplayName(displayName))
    throw new InstallerError("Repository display name is invalid.", {
      code: "PLAN_INVALID"
    });
  const ownerLogins = normalizeOwnerLogins(answers.policy?.repository.ownerLogins ?? answers.ownerLogins);
  if (!validClientId(answers.appClientId))
    throw new InstallerError("GitHub App Client ID is invalid.", {
      code: "PLAN_INVALID"
    });
  const capabilities = normalizeCapabilities(modes, answers.capabilities ?? []);
  const models = normalizeModelChoices({
    modes,
    preset: answers.preset,
    bundle,
    choices: answers.models,
    policySource
  });
  const tracing = answers.policy ? answers.policy.ai.tracing.enabled : answers.tracing !== false;
  const validationCommand = resolveValidationCommand(answers, snapshot);
  assertCodeChangingRequirements(capabilities, validationCommand, snapshot);
  applyValidationCommand(inputPolicy, validationCommand);
  applyPolicyCapabilities(inputPolicy, capabilities, tracing);
  applyModelSettings(inputPolicy, models);
  const desiredProfileSettings = normalizeProfileSettings({
    profiles: answers.profiles ?? effectiveProfiles,
    defaults: packagedProfileDefaults,
    sources: answers.profileSources,
    existingOverrides: installation
      ? AGENT_PROFILE_IDS.filter((id) => Object.hasOwn(installation.contents, AGENT_PROFILES[id].target))
      : []
  });
  const profileSources = {};
  for (const id of AGENT_PROFILE_IDS) {
    const { target } = AGENT_PROFILES[id];
    if (desiredProfileSettings.profileSources[id] === "repository") {
      profileSources[target] = desiredProfileSettings.profiles[id];
    }
  }
  const files = renderPlannedInstallFiles({
    bundle,
    answers,
    snapshot,
    modes,
    displayName,
    ownerLogins,
    capabilities,
    models,
    tracing,
    maintenanceScheduled,
    policySource,
    profileSources,
    installation,
    inputPolicy,
    releaseUpdate
  });
  const effectivePolicy = JSON.parse(files.find((file) => file.path === ".github/codekeeper.json").contents);
  validateEditableSettings(
    {
      policy: effectivePolicy,
      modes,
      enabled: answers.enabled !== false,
      maintenanceScheduled,
      validationCommandCandidate: snapshot.validationCommandCandidate,
      validationCommand,
      profiles: desiredProfileSettings.profiles,
      profileDefaults: desiredProfileSettings.profileDefaults,
      profileSources: desiredProfileSettings.profileSources
    },
    validationBaselinePolicy
  );
  const needsAutomationBotLogin = requiresAutomationBotLogin(modes, capabilities, effectivePolicy.automation.ownerRequests);
  const automationBotLogin = needsAutomationBotLogin
    ? String(answers.automationBotLogin ?? "")
        .trim()
        .toLowerCase()
    : null;
  if (needsAutomationBotLogin && !BOT_LOGIN.test(automationBotLogin))
    throw new InstallerError("GitHub App bot login is invalid.", {
      code: "PLAN_INVALID"
    });
  const changedFiles = changedInstallFiles({
    files,
    installation,
    desiredProfileSettings,
    modes
  });
  const enabled = answers.enabled !== false;
  const variables = installation ? [] : [{ name: CLIENT_ID_VARIABLE, value: answers.appClientId }];
  if (!installation && needsAutomationBotLogin) variables.push({ name: BOT_LOGIN_VARIABLE, value: automationBotLogin });
  if (installation && needsAutomationBotLogin && automationBotLogin !== snapshot.existingSettings.automationBotLogin) {
    variables.push({ name: BOT_LOGIN_VARIABLE, value: automationBotLogin });
  }
  if (!installation || enabled !== snapshot.existingSettings.enabled) {
    variables.push({ name: ENABLED_VARIABLE, value: String(enabled) });
  }
  if (installation && !changedFiles.length && !variables.length) {
    throw new InstallerError("The selected configuration does not change the current installation.", { code: "NO_CHANGES" });
  }
  const requiredSecrets = requiredSecretNames({
    modes,
    models,
    tracing,
    policy: effectivePolicy
  });
  const secretNames = installation ? requiredSecrets.filter((name) => !existingSecretNames(installation).has(name)) : requiredSecrets;
  const assignments = modelAssignments(modes);
  const plan = {
    packageVersion: bundle.packageRelease.version,
    source: {
      repository: bundle.metadata.source.repository,
      commit: bundle.metadata.source.commit
    },
    root: snapshot.root,
    repository: snapshot.repository,
    defaultBranch: snapshot.defaultBranch,
    originalHead: snapshot.headSha,
    modes,
    preset: answers.preset,
    displayName,
    ownerLogins,
    enabled,
    capabilities,
    appPermissions: appPermissions({ modes, capabilities, ownerRequests: effectivePolicy.automation.ownerRequests }),
    models,
    modelSummary: modelSummary(modes, effectivePolicy),
    tracing,
    maintenanceScheduled,
    policy: effectivePolicy,
    files: changedFiles,
    variables,
    secrets: secretNames.map((name) => {
      const provider = Object.entries(MODEL_PROVIDER_SECRETS).find(([, secretName]) => secretName === name)?.[0];
      const roles = provider ? assignments.filter(({ key }) => models[key]?.provider === provider).map(({ label }) => label) : [];
      const purpose = roles.length ? `${SECRET_PURPOSES[name].replace(/[.]$/, "")}. Used by: ${roles.join(", ")}.` : SECRET_PURPOSES[name];
      return { name, purpose };
    }),
    branch: installation ? snapshot.updateBranch : SETUP_BRANCH,
    commitMessage: operation === "release-update"
      ? "chore(codekeeper): update release"
      : operation === "configuration-update" ? "chore(codekeeper): update configuration" : SETUP_COMMIT_MESSAGE,
    pullRequest: {
      title: operation === "release-update"
        ? "chore(codekeeper): update release"
        : operation === "configuration-update" ? "chore(codekeeper): update configuration" : SETUP_PR_TITLE
    },
    operation,
    update: Boolean(installation),
    settingsOnly: Boolean(installation && !changedFiles.length)
  };
  plan.pullRequest.body = setupPullRequestBody(plan);
  return deepFreeze(plan);
}
