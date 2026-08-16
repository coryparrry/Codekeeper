import path from "node:path";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  ALL_MODEL_OPTIONS,
  APP_SECRET,
  BOT_LOGIN_VARIABLE,
  CAPABILITIES,
  CAPABILITY_IDS,
  CLIENT_ID_VARIABLE,
  CONSERVATIVE_BOUNDARIES,
  ENABLED_VARIABLE,
  MODE_IDS,
  MODES,
  MODEL_PROVIDER_SECRETS,
  OPENAI_SECRET,
  PRESET_IDS,
  RECOMMENDED_MODES,
  RECOMMENDED_PRESET,
  RELEASE_MANIFEST_TARGET,
  SECRET_PURPOSES,
  SETUP_BRANCH,
  SETUP_COMMIT_MESSAGE,
  SETUP_PR_TITLE,
  TRACE_SECRET
} from "./constants.mjs";
import { renderInstallFiles, sha256 } from "./assets.mjs";
import { InstallerError } from "./errors.mjs";
import { upgradePolicy } from "./policy.mjs";
import { repositoryArtifactForTarget } from "./repository-artifacts.mjs";
import { createEditableSettings, normalizeProfileSettings, settingsAnswers, validateEditableSettings } from "./settings.mjs";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,99})$/;
const CLIENT_ID = /^(?:Iv[A-Za-z0-9]{18,253}|Iv1\.[A-Za-z0-9]{16,253})$/;

function appSlugFromInput(value) {
  const input = String(value ?? "").trim().toLowerCase();
  const match = input.match(/^(?:https:\/\/github\.com)?\/(?:organizations\/[^/]+\/)?settings\/apps\/([a-z0-9-]+)\/?$/);
  const slug = match?.[1] ?? input;
  return APP_SLUG.test(slug) ? slug : null;
}

function tuiOptions(prompt, plain, tui) {
  return prompt?.kind === "ink" ? { ...plain, ...tui } : plain;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validDisplayName(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPrivateKeyPath(value) {
  return typeof value === "string"
    && path.isAbsolute(value)
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validClientId(value) {
  return typeof value === "string"
    && !/[\s\u0000-\u001f\u007f]/.test(value)
    && CLIENT_ID.test(value);
}

export function normalizeModes(modes) {
  if (!Array.isArray(modes)) throw new InstallerError("Select at least one Codekeeper mode.", { code: "PLAN_INVALID" });
  const selected = [...new Set(modes)];
  if (!selected.length || selected.some((mode) => !MODE_IDS.includes(mode))) {
    throw new InstallerError("Select at least one supported Codekeeper mode.", { code: "PLAN_INVALID" });
  }
  return MODE_IDS.filter((mode) => selected.includes(mode));
}

export function modelAssignments(modes) {
  return normalizeModes(modes).map((mode) => ({
    key: mode,
    agent: MODES[mode].policyAgent,
    label: MODES[mode].agentLabel,
    workflow: MODES[mode].label
  }));
}

export function normalizeOwnerLogins(ownerLogins) {
  if (!Array.isArray(ownerLogins) || !ownerLogins.length) throw new InstallerError("At least one owner login is required.", { code: "PLAN_INVALID" });
  const normalized = ownerLogins.map((login) => String(login).trim().toLowerCase());
  if (normalized.some((login) => !LOGIN.test(login)) || new Set(normalized).size !== normalized.length) {
    throw new InstallerError("Owner logins must be unique GitHub login names.", { code: "PLAN_INVALID" });
  }
  return normalized;
}

export function applicableCapabilityIds(modes) {
  const selected = normalizeModes(modes);
  return CAPABILITY_IDS.filter((id) => id === "reviewRepair"
    ? selected.includes("review") && selected.includes("fix")
    : CAPABILITIES[id].modes.some((mode) => selected.includes(mode)));
}

export function normalizeCapabilities(modes, selected = []) {
  if (!Array.isArray(selected)) throw new InstallerError("Capability choices are invalid.", { code: "PLAN_INVALID" });
  const applicable = applicableCapabilityIds(modes);
  if (selected.some((id) => !applicable.includes(id)) || new Set(selected).size !== selected.length) {
    throw new InstallerError("Capability choices do not match the selected workflows.", { code: "PLAN_INVALID" });
  }
  return Object.freeze(Object.fromEntries(CAPABILITY_IDS.map((id) => [id, selected.includes(id)])));
}

export function requiresAutomationBotLogin(modes, capabilities = [], ownerRequests = true) {
  const issueImplementation = Array.isArray(capabilities)
    ? capabilities.includes("issueImplementation")
    : capabilities?.issueImplementation === true;
  return ownerRequests || modes.includes("review") || (modes.includes("fix") && issueImplementation);
}

export function capabilitySummary(capabilities, modes = null) {
  const ids = modes ? applicableCapabilityIds(modes) : CAPABILITY_IDS;
  return ids.map((id) => `${CAPABILITIES[id].label}: ${capabilities[id] ? "on" : "off"}.`);
}

export function requiredSecretNames({ modes, models, preset = RECOMMENDED_PRESET, tracing = true, policy = null }) {
  const selected = normalizeModes(modes);
  const names = [];
  const providers = new Set(modelAssignments(selected).map(({ key }) => models?.[key]?.provider ?? (preset === "mixed" && key === "issues" ? "deepseek" : "openai")));
  for (const mode of selected) {
    const agent = policy?.ai?.agents?.[MODES[mode].policyAgent];
    if (MODES[mode].workspaceProvider && (!policy || agent?.workspace?.enabled === true)) {
      providers.add(MODES[mode].workspaceProvider);
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

function existingSecretNames(installation) {
  const providers = new Set(modelAssignments(installation.modes).map(({ agent }) => installation.policy.ai.agents[agent].provider));
  for (const mode of installation.modes) {
    const agent = installation.policy.ai.agents[MODES[mode].policyAgent];
    if (agent.workspace?.enabled && MODES[mode].workspaceProvider) providers.add(MODES[mode].workspaceProvider);
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
    const choice = typeof requested === "string"
      ? ALL_MODEL_OPTIONS.find((option) => option.id === requested)
      : requested;
    if (!choice || typeof choice !== "object") throw new InstallerError(`Model choice is invalid for ${workflow}.`, { code: "PLAN_INVALID" });
    const provider = String(choice.provider ?? "").trim();
    const model = String(choice.model ?? "").trim();
    const effort = String(choice.effort ?? "none").trim();
    if (!Object.hasOwn(MODEL_PROVIDER_SECRETS, provider) || !policy.ai.providers[provider]
      || !model || model.length > 256 || /[\s\u0000-\u001f\u007f]/.test(model)
      || !["none", "minimal", "low", "medium", "high", "max", "xhigh"].includes(effort)
      || (effort !== "none" && !policy.ai.providers[provider]?.supportsReasoningEffort)) {
      throw new InstallerError(`Model choice is invalid for ${workflow}.`, { code: "PLAN_INVALID" });
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

export function appRegistrationUrl({ repository, displayName, ownerType = "User" }) {
  const [owner] = repository.split("/");
  if (ownerType !== "User" && ownerType !== "Organization") {
    throw new InstallerError("GitHub App registration requires a personal or organization repository owner.", { code: "PLAN_INVALID" });
  }
  const name = `Codekeeper ${displayName}`.slice(0, 34);
  const parameters = new URLSearchParams({
    name,
    description: `Codekeeper automation for ${repository}`,
    url: `https://github.com/${repository}`,
    public: "false",
    webhook_active: "false",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read"
  });
  const registrationPath = ownerType === "Organization"
    ? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "/settings/apps/new";
  return `https://github.com${registrationPath}?${parameters.toString()}#codekeeper-${owner.toLowerCase()}`;
}

export function documentMap(files) {
  return files.map((file) => {
    const artifact = repositoryArtifactForTarget(file.path);
    return Object.freeze({
      path: file.path,
      purpose: file.delete === true
        ? artifact
          ? `Remove this release-owned artifact. ${artifact.purpose}`
          : "Remove this retired Codekeeper artifact"
        : file.path === RELEASE_MANIFEST_TARGET
          ? "Release version and managed generated-file inventory"
          : (artifact?.purpose ?? "Codekeeper setup")
    });
  });
}

export function workflowMap(modes) {
  return normalizeModes(modes).map((mode) => Object.freeze({
    mode,
    label: MODES[mode].label,
    description: MODES[mode].description,
    workflow: MODES[mode].target,
    trigger: MODES[mode].trigger,
    policyAgent: MODES[mode].policyAgent
  }));
}

export function completionGuidance(modes, enabled = true, update = false) {
  const normalizedModes = normalizeModes(modes);
  return Object.freeze({
    heading: enabled
      ? update
        ? "Codekeeper keeps running the current default-branch configuration. The change takes effect when the pull request merges; no separate validation run is required."
        : "Codekeeper is ready. It starts the selected workflows when the setup pull request merges; no separate dry run or controlled test is required."
      : "Codekeeper stays off after merge. Set CODEKEEPER_ENABLED=true when you want it to start; no separate validation run is required.",
    profileGuidance: "Packaged agent profiles are the default. Edit a profile in Settings to create an optional .github/codekeeper/agents/*.md repository override. Capability switches control repair, issue implementation, issue closure, and merge actions.",
    reviewGateWarning: !enabled && normalizedModes.includes("review")
      ? "Keep the Codekeeper review gate optional while Codekeeper is disabled."
      : null,
    closing: "The installer did not run a workflow or merge the pull request."
  });
}

function editableSettingsForInstallation(snapshot, bundle) {
  const installation = snapshot.installation;
  if (!installation) {
    throw new InstallerError("No Codekeeper installation was found. Run codekeeper init first.", {
      code: "UPDATE_NOT_INSTALLED"
    });
  }
  const preset = installation.policy.ai.agents.issue?.provider === "deepseek" ? "mixed" : "openai";
  const profiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [
    id,
    installation.contents[AGENT_PROFILES[id].target] ?? bundle.contents[AGENT_PROFILES[id].asset]
  ]));
  const profileDefaults = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  const settings = createEditableSettings({
    policy: installation.policy,
    modes: installation.modes,
    enabled: snapshot.existingSettings.enabled,
    profiles,
    profileDefaults,
    profileOverrides: AGENT_PROFILE_IDS.filter((id) => Object.hasOwn(installation.contents, AGENT_PROFILES[id].target))
  });
  return { preset, settings };
}

export function buildUpdateAnswers({ snapshot, bundle, output }) {
  const { preset, settings } = editableSettingsForInstallation(snapshot, bundle);
  output.write("Codekeeper release update\n\n");
  output.write("This advances the release-owned workflow and runtime pins, policy safety boundaries, and provider definitions.\n");
  output.write("Your selected workflows, repository settings, model choices, automation choices, and existing agent profile overrides stay unchanged.\n\n");
  return Object.freeze({
    ...settingsAnswers(settings),
    preset,
    releaseUpdate: true,
    appClientId: snapshot.existingSettings.appClientId,
    automationBotLogin: snapshot.existingSettings.automationBotLogin
  });
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

export function setupPullRequestBody(plan) {
  const documents = markdownTable(
    ["Document", "Purpose"],
    documentMap(plan.files).map((item) => [`\`${item.path}\``, item.purpose])
  );
  const workflows = markdownTable(
    ["Workflow", "Role", "What it does", "Trigger", "Provider and model"],
    modelAssignments(plan.modes).map(({ key, label, workflow }) => {
      const mode = plan.modes.find((candidate) => MODES[candidate].label === workflow);
      const selection = plan.models[key];
      return [MODES[mode].label, label, MODES[mode].description, MODES[mode].trigger, `\`${selection.provider} / ${selection.model} / ${selection.effort}\``];
    })
  );
  const reviewDisabledNote = plan.modes.includes("review") && !plan.enabled
    ? "\nReview events fail the `Codekeeper review gate` while `CODEKEEPER_ENABLED=false`, so keep the gate optional until Codekeeper is enabled.\n"
    : "";
  const requiredSettings = [
    plan.variables.length ? `Required variables: ${plan.variables.map((item) => `\`${item.name}\``).join(", ")}.` : null,
    plan.secrets.length ? `Required secrets: ${plan.secrets.map((item) => `\`${item.name}\``).join(", ")}. Values are never stored in this branch or pull request.` : null
  ].filter(Boolean).join("\n\n");
  return `## Summary

Codekeeper CLI release **${plan.packageVersion}** uses the **${plan.preset}** starting model set at source commit \`${plan.source.commit}\`. Each role has its selected provider and model below. ${plan.update && plan.enabled ? "It is enabled now with the current default-branch configuration; this update applies after the pull request merges." : plan.update ? `It will be ${plan.enabled ? "enabled" : "disabled"} after this update pull request merges.` : `It will be ${plan.enabled ? "enabled" : "disabled"} after this setup pull request merges.`}

OpenAI traces are **${plan.tracing ? "enabled" : "disabled"}**.

Source: [${plan.source.repository}@${plan.source.commit}](https://github.com/${plan.source.repository}/tree/${plan.source.commit})

## Documents

${documents}

## Workflows

${workflows}

## Safety boundaries

${CONSERVATIVE_BOUNDARIES.map((item) => `- ${item}`).join("\n")}
${capabilitySummary(plan.capabilities, plan.modes).map((item) => `- ${item}`).join("\n")}
${reviewDisabledNote}
${requiredSettings ? `\n${requiredSettings}\n` : ""}

## After merge

${plan.enabled
    ? plan.update
      ? "Codekeeper keeps running the current default-branch configuration. The update takes effect when this pull request merges; no separate validation run is required."
      : "Codekeeper starts running the selected workflows when this pull request merges; no separate dry run or controlled test is required."
    : "Codekeeper stays off. Set `CODEKEEPER_ENABLED=true` when you want it to start; no separate validation run is required."}

Packaged agent profiles are used by default. Edit a profile in Settings to create an optional \`.github/codekeeper/agents/*.md\` repository override for priorities, work selection, implementation approach, review standards, or reporting. The capability switches above control which GitHub actions Codekeeper can take. A live maintenance run can repair when repository repair is on. An issue marked ready can start implementation when issue implementation is on.

The installer did not merge this pull request or run a workflow.
`;
}

export function buildInstallPlan({ bundle, snapshot, answers }) {
  const modes = normalizeModes(answers.modes);
  const installation = snapshot.installation ?? null;
  const releaseUpdate = Boolean(installation && answers.releaseUpdate === true);
  const operation = releaseUpdate ? "release-update" : installation ? "configuration-update" : "setup";
  const policySource = installation?.policySource ?? bundle.contents[`policies/${answers.preset}.json`];
  if (!PRESET_IDS.includes(answers.preset)) throw new InstallerError(`Unsupported preset: ${answers.preset}`, { code: "PLAN_INVALID" });
  const baselinePolicy = upgradePolicy(JSON.parse(policySource));
  const validationBaselinePolicy = releaseUpdate
    ? upgradePolicy(JSON.parse(bundle.contents[`policies/${answers.preset}.json`]))
    : baselinePolicy;
  validationBaselinePolicy.repository.defaultBranch = snapshot.defaultBranch;
  const effectiveProfiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id,
    installation?.contents[AGENT_PROFILES[id].target] ?? bundle.contents[AGENT_PROFILES[id].asset]
  ]));
  const packagedProfileDefaults = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  const inputPolicy = answers.policy ?? createEditableSettings({
    policy: baselinePolicy,
    modes,
    enabled: answers.enabled !== false,
    profiles: answers.profiles ?? effectiveProfiles,
    profileDefaults: packagedProfileDefaults,
    profileSources: answers.profileSources,
    profileOverrides: installation
      ? AGENT_PROFILE_IDS.filter((id) => Object.hasOwn(installation.contents, AGENT_PROFILES[id].target))
      : []
  }).policy;
  const displayName = answers.policy?.repository.displayName ?? answers.displayName;
  if (!validDisplayName(displayName)) throw new InstallerError("Repository display name is invalid.", { code: "PLAN_INVALID" });
  const ownerLogins = normalizeOwnerLogins(answers.policy?.repository.ownerLogins ?? answers.ownerLogins);
  if (!validClientId(answers.appClientId)) throw new InstallerError("GitHub App Client ID is invalid.", { code: "PLAN_INVALID" });
  const capabilities = normalizeCapabilities(modes, answers.capabilities ?? []);
  const models = normalizeModelChoices({ modes, preset: answers.preset, bundle, choices: answers.models, policySource });
  const tracing = answers.policy ? answers.policy.ai.tracing.enabled : answers.tracing !== false;
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
  const files = renderInstallFiles(bundle, {
    modes,
    preset: answers.preset,
    displayName,
    defaultBranch: snapshot.defaultBranch,
    ownerLogins,
    capabilities,
    models,
    tracing,
    policySource: answers.policy ? policySource : JSON.stringify(inputPolicy),
    profileSources,
    enforceBundledDefaults: !installation,
    policyOverride: answers.policy ?? null,
    refreshReleaseBoundaries: releaseUpdate
  });
  const effectivePolicy = JSON.parse(files.find((file) => file.path === ".github/codekeeper.json").contents);
  validateEditableSettings({
    policy: effectivePolicy,
    modes,
    enabled: answers.enabled !== false,
    profiles: desiredProfileSettings.profiles,
    profileDefaults: desiredProfileSettings.profileDefaults,
    profileSources: desiredProfileSettings.profileSources
  }, validationBaselinePolicy);
  const needsAutomationBotLogin = requiresAutomationBotLogin(modes, capabilities, effectivePolicy.automation.ownerRequests);
  const automationBotLogin = needsAutomationBotLogin ? String(answers.automationBotLogin ?? "").trim().toLowerCase() : null;
  if (needsAutomationBotLogin && !BOT_LOGIN.test(automationBotLogin)) throw new InstallerError("GitHub App bot login is invalid.", { code: "PLAN_INVALID" });
  const changedFiles = installation
    ? files
      .filter((file) => installation.contents[file.path] !== file.contents)
      .map((file) => ({ ...file, previousSha256: installation.contents[file.path] === undefined ? null : sha256(installation.contents[file.path]) }))
    : files;
  if (installation) {
    for (const id of AGENT_PROFILE_IDS) {
      const target = AGENT_PROFILES[id].target;
      if (desiredProfileSettings.profileSources[id] !== "package" || !Object.hasOwn(installation.contents, target)) continue;
      changedFiles.push({
        path: target,
        contents: null,
        bytes: 0,
        sha256: null,
        previousSha256: sha256(installation.contents[target]),
        delete: true
      });
    }
    for (const mode of installation.modes.filter((mode) => !modes.includes(mode))) {
      const target = MODES[mode].target;
      if (!Object.hasOwn(installation.contents, target)) continue;
      changedFiles.push({
        path: target,
        contents: null,
        bytes: 0,
        sha256: null,
        previousSha256: sha256(installation.contents[target]),
        delete: true
      });
    }
    const nextReleaseManifest = JSON.parse(files.find((file) => file.path === RELEASE_MANIFEST_TARGET).contents);
    const nextManagedTargets = new Set(Object.keys(nextReleaseManifest.managedFiles));
    const changedTargets = new Set(changedFiles.map((file) => file.path));
    for (const target of Object.keys(installation.releaseManifest?.managedFiles ?? {})) {
      if (nextManagedTargets.has(target) || changedTargets.has(target)) continue;
      changedFiles.push({
        path: target,
        contents: null,
        bytes: 0,
        sha256: null,
        previousSha256: sha256(installation.contents[target]),
        delete: true
      });
    }
  }
  const enabled = answers.enabled !== false;
  const variables = installation
    ? (enabled === snapshot.existingSettings.enabled ? [] : [{ name: ENABLED_VARIABLE, value: String(enabled) }])
    : [
    { name: ENABLED_VARIABLE, value: String(enabled) },
    { name: CLIENT_ID_VARIABLE, value: answers.appClientId }
  ];
  if (!installation && needsAutomationBotLogin) variables.push({ name: BOT_LOGIN_VARIABLE, value: automationBotLogin });
  if (installation && needsAutomationBotLogin && automationBotLogin !== snapshot.existingSettings.automationBotLogin) {
    variables.push({ name: BOT_LOGIN_VARIABLE, value: automationBotLogin });
  }
  if (installation && !changedFiles.length && !variables.length) {
    throw new InstallerError("The selected configuration does not change the current installation.", { code: "NO_CHANGES" });
  }
  const requiredSecrets = requiredSecretNames({ modes, models, tracing, policy: effectivePolicy });
  const secretNames = installation
    ? requiredSecrets.filter((name) => !existingSecretNames(installation).has(name))
    : requiredSecrets;
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
    models,
    tracing,
    policy: effectivePolicy,
    files: changedFiles,
    variables,
    secrets: secretNames.map((name) => {
      const provider = Object.entries(MODEL_PROVIDER_SECRETS).find(([, secretName]) => secretName === name)?.[0];
      const roles = provider
        ? modelAssignments(modes)
          .filter(({ key }) => models[key]?.provider === provider)
          .map(({ label }) => label)
        : [];
      const purpose = roles.length
        ? `${SECRET_PURPOSES[name].replace(/[.]$/, "")}. Used by: ${roles.join(", ")}.`
        : SECRET_PURPOSES[name];
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

export async function collectSetupAnswers({ prompt, snapshot, bundle, output, initialAnswers = null }) {
  const installation = snapshot.installation ?? null;
  if (!initialAnswers) {
    output.write(`Codekeeper guided setup\n\n`);
    output.write(installation
      ? "This edits the current Codekeeper installation through a new pull request.\n\n"
      : "This creates a setup pull request. It does not run a model, merge the pull request, or put secrets in generated files.\n\n");
    const repositoryConfirmed = await prompt.confirm({
      message: `${installation ? "Edit Codekeeper in" : "Install into"} ${snapshot.repository} on default branch ${snapshot.defaultBranch}?`,
      defaultValue: true,
      ...(prompt?.kind === "ink" ? {
        step: "repository",
        description: [
          "Codekeeper supports GitHub.com repositories with a clean, current default-branch checkout.",
          "The installer is still read-only at this point."
        ],
        yesLabel: "Use this repository",
        noLabel: "Cancel"
      } : {})
    });
    if (!repositoryConfirmed) throw new InstallerError("Setup was cancelled before any mutation.", { code: "USER_CANCELLED" });
  }
  if (prompt?.kind === "ink" && typeof prompt.editSettings === "function") {
    const installed = installation ? editableSettingsForInstallation(snapshot, bundle) : null;
    const preset = initialAnswers?.preset ?? installed?.preset ?? "openai";
    const baselinePolicy = installed?.settings.policy
      ?? upgradePolicy(JSON.parse(bundle.contents[`policies/${preset}.json`]));
    if (!installation) {
      baselinePolicy.repository.displayName = snapshot.displayName;
      baselinePolicy.repository.ownerLogins = [snapshot.viewerLogin.toLowerCase()];
      baselinePolicy.merge.allowedUserAuthors = [...baselinePolicy.repository.ownerLogins];
    }
    const profileDefaults = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
    const settings = initialAnswers
      ? createEditableSettings({
        policy: initialAnswers.policy,
        modes: initialAnswers.modes,
        enabled: initialAnswers.enabled,
        profiles: initialAnswers.profiles,
        profileDefaults,
        profileSources: initialAnswers.profileSources
      })
      : installed?.settings ?? createEditableSettings({
        policy: baselinePolicy,
        modes: RECOMMENDED_MODES,
        enabled: true,
        profiles: profileDefaults
      });
    const edited = await prompt.editSettings({
      settings,
      baselinePolicy,
      repository: snapshot.repository,
      update: Boolean(installation)
    });
    validateEditableSettings(edited, baselinePolicy);
    return Object.freeze({
      ...settingsAnswers(edited),
      preset,
      ...(initialAnswers?.releaseUpdate ? { releaseUpdate: true } : {})
    });
  }
  if (!installation) output.write("Recommended starter setup\n");
  if (!installation) {
    output.write("  - Pull request review: your GitHub App posts comments, labels, and a blocking result on controlled same-repository PRs\n");
    output.write("  - Repository maintenance: manual or scheduled audits; live runs can repair when repository repair is on\n");
    output.write("  - OpenAI starting models: you can assign any supported provider and model to each role\n");
    output.write("  - Issue triage and issue fix are not included\n");
    output.write("  - You choose whether Codekeeper starts when the setup pull request merges\n");
    output.write("  - The maintenance workflow includes a schedule after merge\n");
    output.write("Press Return at the next question to accept these choices.\n");
  }
  const useRecommended = installation ? false : prompt?.kind === "ink"
    ? await prompt.select({
      step: "setup",
      message: "Choose a starting setup",
      description: [
        "Recommended installs pull-request review and maintenance with OpenAI models.",
        "Custom lets you select each workflow and its provider and model."
      ],
      defaultValue: "recommended",
      choices: [
        { value: "recommended", label: "Recommended — review + maintenance, OpenAI models" },
        { value: "custom", label: "Custom — choose workflows and models" }
      ]
    }) === "recommended"
    : await prompt.confirm({ message: "Use the recommended starter setup?", defaultValue: true });

  let modes;
  let preset;
  if (installation) {
    modes = [...installation.modes];
    preset = installation.policy.ai.agents.issue?.provider === "deepseek" ? "mixed" : "openai";
    output.write(`Editing the current ${modes.map((mode) => MODES[mode].label).join(" + ")} installation.\n`);
    if (installation.legacyFiles?.length) {
      output.write(`Legacy inactive file remains unchanged: ${installation.legacyFiles.join(", ")}. Remove it in a separately reviewed pull request when ready.\n`);
    }
  } else if (useRecommended) {
    modes = [...RECOMMENDED_MODES];
    preset = RECOMMENDED_PRESET;
    output.write("Using pull request review and repository maintenance with OpenAI starting models.\n");
  } else {
    output.write("\nCustom setup: install only the workflows that you want to use. Issue triage responds to issue events. You choose issue implementation separately.\n");
    modes = await prompt.multiselect(tuiOptions(prompt, {
      message: "Choose workflows to generate:",
      defaultValues: RECOMMENDED_MODES,
      choices: MODE_IDS.map((mode) => ({ value: mode, label: `${MODES[mode].label} — ${MODES[mode].description}` }))
    }, {
      step: "workflows",
      description: ["Install only the workflows you intend to prove in this repository."]
    }));
    preset = await prompt.select(tuiOptions(prompt, {
      message: "Choose the starting model set:",
      defaultValue: RECOMMENDED_PRESET,
      choices: [
        { value: "openai", label: "openai — use OpenAI for every selected workflow (recommended)" },
        { value: "mixed", label: "mixed — use DeepSeek for issue triage and OpenAI for other workflows" }
      ]
    }, {
      step: "models",
      description: ["This choice supplies starting models. You can change every role on the next screens."]
    }));
  }
  const presetPolicy = installation?.policy ?? JSON.parse(bundle.contents[`policies/${preset}.json`]);
  const models = {};
  for (const assignment of modelAssignments(modes)) {
    const { key, agent: agentId, label, workflow } = assignment;
    const agent = presetPolicy.ai.agents[agentId];
    const defaultChoice = ALL_MODEL_OPTIONS.find((choice) => choice.provider === agent.provider && choice.model === agent.model && choice.effort === agent.effort);
    const customChoiceId = `current-custom-${key}`;
    const newCustomChoiceId = `custom-${key}`;
    const choices = [
      ...(defaultChoice ? [] : [{
        id: customChoiceId,
        label: `Current custom model · ${agent.provider} · ${agent.model} · ${agent.effort} effort`
      }]),
      ...ALL_MODEL_OPTIONS,
      { id: newCustomChoiceId, label: "Custom provider and model" }
    ];
    const selectedModel = await prompt.select(tuiOptions(prompt, {
      message: `Assign a model to the ${label}:`,
      defaultValue: defaultChoice?.id ?? customChoiceId,
      choices: choices.map((choice) => ({ value: choice.id, label: choice.label }))
    }, {
      step: "models",
      description: [
        `${workflow} uses this role. The role is not tied to one provider.`,
        "You can change this choice later in .github/codekeeper.json."
      ]
    }));
    if (selectedModel === newCustomChoiceId) {
      const provider = await prompt.select(tuiOptions(prompt, {
        message: `Choose the provider for the ${label}:`,
        defaultValue: agent.provider,
        choices: Object.keys(MODEL_PROVIDER_SECRETS).map((value) => ({ value, label: value }))
      }, {
        step: "models",
        description: ["Provider credentials are collected separately and never written to the repository."]
      }));
      const model = await prompt.inputText(tuiOptions(prompt, {
        message: `Enter the model ID for the ${label}:`,
        defaultValue: provider === agent.provider ? agent.model : ""
      }, {
        step: "models",
        description: ["Use the exact model ID accepted by the selected provider."]
      }));
      const effort = presetPolicy.ai.providers[provider].supportsReasoningEffort
        ? await prompt.select(tuiOptions(prompt, {
          message: `Choose the reasoning effort for the ${label}:`,
          defaultValue: provider === agent.provider ? agent.effort : "medium",
          choices: ["none", "minimal", "low", "medium", "high", "max", "xhigh"]
            .map((value) => ({ value, label: value }))
        }, {
          step: "models",
          description: ["The provider must support the selected reasoning effort."]
        }))
        : "none";
      models[key] = { provider, model, effort };
    } else {
      models[key] = selectedModel === customChoiceId
        ? { provider: agent.provider, model: agent.model, effort: agent.effort }
        : selectedModel;
    }
  }
  const tracing = prompt?.kind === "ink"
    ? await prompt.select({
      step: "tracing",
      message: "Enable OpenAI traces?",
      description: [
        "Traces record model runs in OpenAI Platform Logs.",
        "Enabled needs a separate OpenAI Platform API key. Disabled does not request the trace key."
      ],
      defaultValue: (installation ? installation.policy.ai.tracing.enabled : true) ? "enabled" : "disabled",
      choices: [
        { value: "enabled", label: "Enabled" },
        { value: "disabled", label: "Disabled" }
      ]
    }) === "enabled"
    : await prompt.confirm({ message: "Enable OpenAI traces?", defaultValue: installation ? installation.policy.ai.tracing.enabled : true });
  const enabled = prompt?.kind === "ink"
    ? await prompt.select({
      step: "startup",
      message: installation ? "Start Codekeeper now?" : "Start Codekeeper after the setup pull request merges?",
      description: installation ? [
        "Enabled changes the repository setting now and starts the current default-branch configuration.",
        "Configuration changes from this update take effect after its pull request merges."
      ] : [
        "Enabled starts the workflows you selected as soon as this setup is merged.",
        "Disabled installs the files and secrets but keeps every Codekeeper workflow off."
      ],
      defaultValue: (installation ? snapshot.existingSettings.enabled : true) ? "enabled" : "disabled",
      choices: [
        { value: "enabled", label: "Enabled (recommended)" },
        { value: "disabled", label: "Disabled" }
      ]
    }) === "enabled"
    : await prompt.confirm({
      message: installation ? "Start Codekeeper now?" : "Start Codekeeper after the setup pull request merges?",
      defaultValue: installation ? snapshot.existingSettings.enabled : true,
      ...(installation ? { description: [
        "Enabled changes the repository setting now and starts the current default-branch configuration.",
        "Configuration changes from this update take effect after its pull request merges."
      ] } : {})
    });
  const applicableCapabilities = applicableCapabilityIds(modes);
  const capabilities = applicableCapabilities.length
    ? await prompt.multiselect(tuiOptions(prompt, {
      message: "Choose capabilities to turn on:",
      allowEmpty: true,
      defaultValues: installation
        ? applicableCapabilities.filter((id) => ({
          reviewRepair: installation.policy.review.autoRepair,
          repair: installation.policy.audit.repair.enabled,
          issueImplementation: installation.policy.issues.allowAiImplementation,
          duplicateClosure: installation.policy.issues.closeExactDuplicates,
          autoMerge: installation.policy.merge.enabled
        })[id])
        : [],
      choices: applicableCapabilities.map((id) => ({
        value: id,
        label: `${CAPABILITIES[id].label} — ${CAPABILITIES[id].description}`
      }))
    }, {
      step: "capabilities",
      description: [
        "Automatic code changes and merge start off.",
        "Select only the capabilities that you want Codekeeper to use."
      ]
    }))
    : [];
  const displayName = await prompt.inputText(tuiOptions(prompt, {
    message: "Name to show in Codekeeper comments",
    defaultValue: installation?.policy.repository.displayName ?? snapshot.displayName,
    validate: (value) => validDisplayName(value) || "Use 1–100 printable characters."
  }, {
    step: "identity",
    description: ["This label appears in Codekeeper's GitHub comments. Your repository name is unchanged."],
    maxLength: 100
  }));
  const ownersText = await prompt.inputText(tuiOptions(prompt, {
    message: "GitHub users who can run owner-only /codekeeper commands (comma-separated)",
    defaultValue: installation?.policy.repository.ownerLogins?.join(",") ?? snapshot.viewerLogin,
    validate(value) {
      try {
        normalizeOwnerLogins(value.split(","));
        return true;
      } catch {
        return "Enter one or more unique GitHub logins.";
      }
    }
  }, {
    step: "identity",
    description: ["Keep the authenticated user unless another maintainer can run owner-only commands."]
  }));

  if (!installation) {
    output.write("\nCredentials this setup will request later through GitHub CLI\n");
    output.write("Setup does not call a model. API keys go directly to GitHub CLI. Codekeeper does not display or store their values.\n");
    output.write("The installer sends the selected App key file directly to GitHub CLI. It does not read or display the key.\n");
    const selectedModels = normalizeModelChoices({ modes, preset, bundle, choices: models, policySource: JSON.stringify(presetPolicy) });
    for (const name of requiredSecretNames({ modes, models: selectedModels, tracing, policy: presetPolicy })) output.write(`  - ${name}: ${SECRET_PURPOSES[name]}\n`);
  } else {
    output.write("\nThe current GitHub App settings and existing API keys stay unchanged. If this edit needs a new key, the installer requests it after the final review.\n");
  }

  const policy = installation?.policy ?? JSON.parse(bundle.contents[`policies/${preset}.json`]);
  output.write("\nSafety settings\n");
  capabilitySummary(normalizeCapabilities(modes, capabilities), modes).forEach((item) => output.write(`  - ${item}\n`));
  CONSERVATIVE_BOUNDARIES.forEach((item) => output.write(`  - ${item}\n`));
  output.write(`The policy has ${policy.audit.repair.protectedPaths.length} protected-path rules. Review the full list in the setup pull request.\n`);
  const confirmed = await prompt.confirm(tuiOptions(prompt, {
    message: "Continue with these safety settings?",
    defaultValue: false
  }, {
    step: "safety",
    description: [
      ...capabilitySummary(normalizeCapabilities(modes, capabilities), modes),
      ...CONSERVATIVE_BOUNDARIES,
      `${policy.audit.repair.protectedPaths.length} protected-path rules are bundled for review before merge.`
    ],
    yesLabel: "Continue",
    noLabel: "Cancel"
  }));
  if (!confirmed) throw new InstallerError("Setup was cancelled before any mutation.", { code: "USER_CANCELLED" });
  return Object.freeze({
    modes: normalizeModes(modes),
    preset,
    models,
    tracing,
    displayName,
    ownerLogins: normalizeOwnerLogins(ownersText.split(",")),
    enabled,
    capabilities
  });
}

export async function collectAutomationBotLogin({ prompt, output }) {
  output.write("  - App settings URL: copy it from the browser after GitHub saves the App\n");
  if (prompt?.kind === "ink") {
    const appInput = await prompt.inputText({
      step: "GitHub App",
      message: "Paste the GitHub App settings URL",
      description: [
        "Copy the GitHub App settings URL after GitHub saves the App.",
        "For https://github.com/settings/apps/my-codekeeper-app, Codekeeper uses my-codekeeper-app[bot].",
        "You can also enter only my-codekeeper-app."
      ],
      validate: (value) => Boolean(appSlugFromInput(value)) || "Paste a GitHub App settings URL, or enter its lowercase URL name."
    });
    const appSlug = appSlugFromInput(appInput);
    if (!appSlug) throw new InstallerError("The GitHub App settings URL is invalid.", { code: "PLAN_INVALID" });
    return `${appSlug}[bot]`;
  }
  const automationBotLogin = await prompt.inputText({
    message: "GitHub App bot login (<app-slug>[bot], for example my-app[bot])",
    validate: (value) => BOT_LOGIN.test(value.toLowerCase()) || "Enter the App bot login ending in [bot]."
  });
  return automationBotLogin.toLowerCase();
}

export async function collectAppAnswers({ prompt, modes, capabilities = [], ownerRequests = true, output }) {
  output.write("\nGitHub App identifiers\n");
  output.write("  - Client ID: find the value that starts with Iv in the App settings\n");
  const appClientId = await prompt.inputText(tuiOptions(prompt, {
    message: "GitHub App Client ID (starts with Iv, not the numeric App ID)",
    validate: (value) => validClientId(value) || "Enter the App Client ID shown in GitHub App settings."
  }, {
    step: "GitHub App",
    description: [
      "Find Client ID in the App's General settings. It begins with Iv.",
      "Do not enter the numeric App ID."
    ]
  }));
  const automationBotLogin = requiresAutomationBotLogin(modes, capabilities, ownerRequests)
    ? await collectAutomationBotLogin({ prompt, output })
    : null;
  return Object.freeze({ appClientId, automationBotLogin: automationBotLogin?.toLowerCase() ?? null });
}

export async function collectAppPrivateKeyPath({ prompt, output }) {
  output.write("\nGitHub App private-key file\n");
  output.write("Select the new .pem file that GitHub downloaded. Do not open the file or paste its contents.\n");
  output.write("The installer sends the file directly to GitHub CLI. It does not display the path or key.\n");
  if (typeof prompt.selectPrivateKey === "function") return prompt.selectPrivateKey();
  return prompt.inputText({
    message: "Full absolute path to the downloaded GitHub App private-key PEM",
    validate: (value) => validPrivateKeyPath(value) || "Enter the full absolute path to the downloaded .pem file, not the key contents."
  });
}
