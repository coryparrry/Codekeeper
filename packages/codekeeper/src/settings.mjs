import { AGENT_PROFILE_IDS, AGENT_PROFILES, MODE_IDS, MODEL_OPTIONS, MODEL_PROVIDER_SECRETS, MODES, SOURCE_COMMIT, SOURCE_REPOSITORY } from "./constants.mjs";
import { InstallerError } from "./errors.mjs";
import { isReleaseOwnedPolicyPath, RELEASE_OWNED_POLICY_PATHS } from "./policy.mjs";
import { validatePolicy } from "./policy-validator.mjs";

const AGENT_IDS = Object.freeze(["review", "audit", "issue", "fix"]);
const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "max", "xhigh"]);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const STANDARD_PATHS = Object.freeze([
  ["automation.automaticPrReview", "Automatic PR review"],
  ["automation.reviewFeedbackTriage", "Review feedback triage"],
  ["automation.issueTriage", "Automatic issue triage"],
  ["automation.ownerRequests", "Owner requests"],
  ["review.createDeferredIssues", "Deferred issue creation"],
  ["review.autoRepair", "Automatic PR repair"],
  ["audit.repair.enabled", "Maintenance repair"],
  ["issues.allowAiImplementation", "Ready issue implementation"],
  ["issues.closeExactDuplicates", "Exact duplicate closure"],
  ["issues.closeResolvedIssues", "Resolved issue closure"],
  ["merge.enabled", "Automatic merge"],
  ["automation.maintenanceSchedule", "Maintenance schedule"],
  ["ai.tracing.enabled", "OpenAI tracing"]
]);

function clone(value) {
  return structuredClone(value);
}

function canonicalOwnerLogins(value) {
  return Array.isArray(value)
    ? value.map((login) => String(login).trim().toLowerCase())
    : value;
}

function pathParts(path) {
  return Array.isArray(path) ? path : path.split(".");
}

function getPath(object, path) {
  return pathParts(path).reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const parts = pathParts(path);
  const leaf = parts.pop();
  const parent = parts.reduce((current, key) => current[key], object);
  parent[leaf] = value;
}

function readOnlyPolicyPath(path) {
  return path === "version"
    || path === "repository.defaultBranch"
    || isReleaseOwnedPolicyPath(path)
    || path === "merge.allowedUserAuthors";
}

function enumChoices(path, policy) {
  if (/^ai\.agents\.[^.]+\.provider$/.test(path)) {
    return Object.keys(MODEL_PROVIDER_SECRETS).filter((provider) => policy.ai.providers[provider]);
  }
  const coordinatorEffort = path.match(/^ai\.agents\.([^.]+)\.effort$/);
  if (coordinatorEffort) {
    const provider = policy.ai.agents[coordinatorEffort[1]].provider;
    return policy.ai.providers[provider]?.supportsReasoningEffort ? EFFORTS : ["none"];
  }
  if (/^ai\.agents\.[^.]+\.workspace\.effort$/.test(path)) return EFFORTS;
  if (path === "merge.method") return ["MERGE", "SQUASH", "REBASE"];
  return null;
}

function policyRow(policy, path, label = path, keys = pathParts(path)) {
  const value = getPath(policy, keys);
  const choices = enumChoices(path, policy);
  const canonicalKeys = pathParts(path);
  return {
    id: `policy:${path}`,
    section: path.split(".")[0],
    label,
    path,
    ...(keys.length === canonicalKeys.length && keys.every((key, index) => key === canonicalKeys[index]) ? {} : { keys }),
    value,
    readOnly: readOnlyPolicyPath(path),
    kind: readOnlyPolicyPath(path) ? "readonly"
      : choices ? "enum"
        : typeof value === "boolean" ? "boolean"
          : typeof value === "number" ? "number"
            : typeof value === "string" || /^ai\.agents\.[^.]+\.workspace\.model$/.test(path) ? "string"
              : "json",
    ...(choices ? { choices } : {})
  };
}

function flattenPolicy(policy, value = policy, prefix = "", rows = [], parentKeys = []) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const keys = [...parentKeys, key];
    if (path === "ai.providers" || /^ai\.agents\.[^.]+\.modelSettings$/.test(path)) {
      rows.push(policyRow(policy, path, path, keys));
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenPolicy(policy, child, path, rows, keys);
    } else {
      rows.push(policyRow(policy, path, path, keys));
    }
  }
  return rows;
}

export function normalizeProfileSettings({ profiles = {}, defaults = profiles, sources = null, existingOverrides = [] }) {
  const overrides = new Set(existingOverrides);
  const hasExplicitSources = sources && typeof sources === "object" && !Array.isArray(sources);
  const profileDefaults = {};
  const normalizedProfiles = {};
  const profileSources = {};
  for (const id of AGENT_PROFILE_IDS) {
    const defaultSource = defaults[id] ?? defaults[AGENT_PROFILES[id].target] ?? "";
    const desiredSource = profiles[id] ?? profiles[AGENT_PROFILES[id].target] ?? defaultSource;
    const source = hasExplicitSources && Object.hasOwn(sources, id)
      ? sources[id]
      : overrides.has(id) || desiredSource !== defaultSource ? "repository" : "package";
    profileDefaults[id] = defaultSource;
    profileSources[id] = source;
    normalizedProfiles[id] = source === "package" ? defaultSource : desiredSource;
  }
  return { profileDefaults, profiles: normalizedProfiles, profileSources };
}

export function createEditableSettings({
  policy,
  modes,
  enabled,
  profiles = {},
  profileDefaults = profiles,
  profileSources = null,
  profileOverrides = []
}) {
  const editablePolicy = clone(policy);
  if (!modes.includes("issues")) {
    editablePolicy.review.createDeferredIssues = false;
    editablePolicy.issues.closeResolvedIssues = false;
  }
  const normalizedProfiles = normalizeProfileSettings({
    profiles,
    defaults: profileDefaults,
    sources: profileSources,
    existingOverrides: profileOverrides
  });
  return {
    policy: editablePolicy,
    modes: [...modes],
    enabled: enabled !== false,
    ...normalizedProfiles
  };
}

export function settingsRows(settings, { advanced = false } = {}) {
  const rows = [
    ...MODE_IDS.map((mode) => ({
      id: `workflow:${mode}`,
      section: "workflows",
      label: MODES[mode].label,
      kind: "boolean",
      value: settings.modes.includes(mode)
    })),
    { id: "workflow:assistant", section: "workflows", label: "Repository assistant", kind: "readonly", value: "always installed", readOnly: true },
    { id: "enabled", section: "workflows", label: "Global enablement", kind: "boolean", value: settings.enabled },
    ...STANDARD_PATHS.map(([path, label]) => policyRow(settings.policy, path, label))
  ];
  for (const agent of AGENT_IDS) {
    const label = agent === "audit" ? "auditor" : agent === "issue" ? "issue triager" : agent;
    for (const [suffix, name] of [
      ["provider", "provider"],
      ["model", "model ID"],
      ["effort", "effort"],
      ["workspace.enabled", "workspace specialist"],
      ["workspace.model", "workspace model"],
      ["workspace.effort", "workspace effort"]
    ]) rows.push(policyRow(settings.policy, `ai.agents.${agent}.${suffix}`, `${label} ${name}`));
  }
  for (const profile of AGENT_PROFILE_IDS) {
    rows.push({
      id: `profile:${profile}`,
      section: "profiles",
      label: `${settings.profileSources?.[profile] === "repository" ? "Repository override" : "Packaged default"} · ${AGENT_PROFILES[profile].purpose}`,
      kind: "profile",
      value: settings.profiles[profile],
      profile,
      source: settings.profileSources?.[profile] ?? "package"
    });
  }
  if (!advanced) return rows;
  const seen = new Set(rows.map((row) => row.id));
  for (const row of flattenPolicy(settings.policy)) {
    if (!seen.has(row.id)) rows.push(row);
  }
  rows.push(
    { id: "release:repository", section: "release", label: "Pinned source repository", kind: "readonly", value: SOURCE_REPOSITORY, readOnly: true },
    { id: "release:commit", section: "release", label: "Pinned source commit", kind: "readonly", value: SOURCE_COMMIT, readOnly: true }
  );
  return rows;
}

export function setSetting(settings, row, value) {
  if (row.readOnly || row.kind === "readonly") throw new InstallerError("That Codekeeper setting is read-only.", { code: "SETTING_READ_ONLY" });
  const next = clone(settings);
  if (row.id === "enabled") next.enabled = value;
  else if (row.id.startsWith("workflow:")) {
    const mode = row.id.slice("workflow:".length);
    next.modes = value
      ? MODE_IDS.filter((candidate) => candidate === mode || next.modes.includes(candidate))
      : next.modes.filter((candidate) => candidate !== mode);
  } else if (row.id.startsWith("profile:")) {
    next.profileSources[row.profile] = "repository";
    next.profiles[row.profile] = value;
  } else {
    setPath(next.policy, row.keys ?? row.path, value);
    if (/^ai\.agents\.[^.]+\.provider$/.test(row.path)) {
      const agent = row.path.split(".")[2];
      const bundledModels = Object.hasOwn(MODEL_OPTIONS, value) ? MODEL_OPTIONS[value] : null;
      if (bundledModels) {
        next.policy.ai.agents[agent].model = bundledModels[0].model;
        next.policy.ai.agents[agent].modelSettings = value === "openai"
          ? { text: { verbosity: "low" } }
          : value === "deepseek"
            ? { temperature: 0.2, providerData: { thinking: { type: "disabled" }, response_format: { type: "json_object" } } }
            : {};
      }
      if (!next.policy.ai.providers[value]?.supportsReasoningEffort) next.policy.ai.agents[agent].effort = "none";
    }
    if (row.path === "repository.ownerLogins") {
      const ownerLogins = canonicalOwnerLogins(value);
      next.policy.repository.ownerLogins = ownerLogins;
      next.policy.merge.allowedUserAuthors = Array.isArray(ownerLogins) ? [...ownerLogins] : ownerLogins;
    }
  }
  return next;
}

export function resetProfileOverride(settings, profile) {
  if (!AGENT_PROFILE_IDS.includes(profile)) throw new InstallerError("That agent profile is invalid.", { code: "SETTING_INVALID" });
  const next = clone(settings);
  next.profileSources[profile] = "package";
  next.profiles[profile] = next.profileDefaults[profile];
  return next;
}

export function parseSettingValue(row, input) {
  const text = String(input ?? "").trim();
  if (row.kind === "number") {
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new InstallerError("Enter a whole number.", { code: "SETTING_INVALID" });
    return value;
  }
  if (row.kind === "json") {
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new InstallerError("Enter valid JSON.", { code: "SETTING_INVALID", cause });
    }
  }
  if (!text) throw new InstallerError("Enter a non-empty value.", { code: "SETTING_INVALID" });
  return text;
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateEditableSettings(settings, baselinePolicy) {
  if (!settings || typeof settings !== "object" || typeof settings.enabled !== "boolean") throw new InstallerError("Codekeeper settings are invalid.", { code: "SETTING_INVALID" });
  if (!Array.isArray(settings.modes) || !settings.modes.length || new Set(settings.modes).size !== settings.modes.length || settings.modes.some((mode) => !MODE_IDS.includes(mode))) {
    throw new InstallerError("Select at least one installed workflow.", { code: "SETTING_INVALID" });
  }
  const policy = settings.policy;
  if (policy?.version !== 3) throw new InstallerError("Policy version is read-only.", { code: "SETTING_INVALID" });
  for (const path of ["repository.defaultBranch", ...RELEASE_OWNED_POLICY_PATHS]) {
    if (!equal(getPath(policy, path), getPath(baselinePolicy, path))) throw new InstallerError(`${path} is a read-only safety boundary.`, { code: "SETTING_INVALID" });
  }
  if (policy.projectInvariants === undefined) policy.projectInvariants = [];
  for (const agent of Object.values(policy.ai?.agents ?? {})) agent.modelSettings ??= {};
  try {
    validatePolicy(policy);
  } catch (cause) {
    throw new InstallerError(cause.message, { code: "SETTING_INVALID", cause });
  }
  if (policy.repository.displayName.trim() !== policy.repository.displayName || policy.repository.displayName.length > 100) {
    throw new InstallerError("repository.displayName is invalid.", { code: "SETTING_INVALID" });
  }
  const normalizedOwnerLogins = canonicalOwnerLogins(policy.repository.ownerLogins);
  if (normalizedOwnerLogins.some((login) => !LOGIN.test(login))
    || !equal(policy.merge.allowedUserAuthors, normalizedOwnerLogins)) {
    throw new InstallerError("Owner logins are invalid or out of sync.", { code: "SETTING_INVALID" });
  }
  for (const agentId of AGENT_IDS) {
    const agent = policy.ai.agents[agentId];
    if (!Object.hasOwn(MODEL_PROVIDER_SECRETS, agent.provider) || !policy.ai.providers[agent.provider]) {
      throw new InstallerError(`${agentId} must use an installable provider.`, { code: "SETTING_INVALID" });
    }
  }
  if (policy.review.createDeferredIssues && !settings.modes.includes("issues")) {
    throw new InstallerError("Deferred issue creation requires the Issue triage workflow.", { code: "SETTING_INVALID" });
  }
  if (policy.review.autoRepair && !(settings.modes.includes("review") && settings.modes.includes("fix"))) {
    throw new InstallerError("Automatic PR repair requires both the Review and Fixer workflows.", { code: "SETTING_INVALID" });
  }
  if (policy.audit.repair.enabled && !settings.modes.includes("maintain")) throw new InstallerError("Repository repair requires the Maintenance workflow.", { code: "SETTING_INVALID" });
  if (policy.issues.allowAiImplementation && !(settings.modes.includes("issues") && settings.modes.includes("fix"))) {
    throw new InstallerError("Issue implementation requires both the Issue triage and Fixer workflows.", { code: "SETTING_INVALID" });
  }
  if (policy.issues.closeExactDuplicates && !settings.modes.includes("issues")) throw new InstallerError("Duplicate closure requires the Issue triage workflow.", { code: "SETTING_INVALID" });
  if (policy.issues.closeResolvedIssues && !settings.modes.includes("issues")) throw new InstallerError("Resolved issue closure requires the Issue triage workflow.", { code: "SETTING_INVALID" });
  if (policy.merge.enabled && !(settings.modes.includes("review") && settings.modes.some((mode) => mode === "maintain" || mode === "fix"))) {
    throw new InstallerError("Automatic merge requires the Review workflow and a repair workflow.", { code: "SETTING_INVALID" });
  }
  for (const profile of AGENT_PROFILE_IDS) {
    const source = settings.profiles[profile];
    if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source) > 64 * 1024 || source.includes("\0")) throw new InstallerError(`${profile} profile is invalid.`, { code: "SETTING_INVALID" });
    if (!["package", "repository"].includes(settings.profileSources?.[profile])) throw new InstallerError(`${profile} profile source is invalid.`, { code: "SETTING_INVALID" });
    if (settings.profileSources[profile] === "package" && source !== settings.profileDefaults?.[profile]) {
      throw new InstallerError(`${profile} packaged profile must match the release default.`, { code: "SETTING_INVALID" });
    }
  }
  return settings;
}

export function settingsAnswers(settings) {
  const policy = settings.policy;
  return {
    modes: [...settings.modes],
    enabled: settings.enabled,
    policy: clone(policy),
    profiles: clone(settings.profiles),
    profileSources: clone(settings.profileSources),
    displayName: policy.repository.displayName,
    ownerLogins: [...policy.repository.ownerLogins],
    tracing: policy.ai.tracing.enabled,
    capabilities: [
      ...(settings.modes.includes("review") && settings.modes.includes("fix") && policy.review.autoRepair ? ["reviewRepair"] : []),
      ...(settings.modes.includes("maintain") && policy.audit.repair.enabled ? ["repair"] : []),
      ...(settings.modes.includes("issues") && settings.modes.includes("fix") && policy.issues.allowAiImplementation ? ["issueImplementation"] : []),
      ...(settings.modes.includes("issues") && policy.issues.closeExactDuplicates ? ["duplicateClosure"] : []),
      ...(settings.modes.includes("review") && settings.modes.some((mode) => mode === "maintain" || mode === "fix") && policy.merge.enabled ? ["autoMerge"] : [])
    ],
    models: Object.fromEntries(settings.modes.map((mode) => {
      const agent = policy.ai.agents[MODES[mode].policyAgent];
      return [mode, { provider: agent.provider, model: agent.model, effort: agent.effort }];
    }))
  };
}
