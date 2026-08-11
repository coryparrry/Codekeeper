import { AGENT_PROFILE_IDS, AGENT_PROFILES, MODE_IDS, MODES, SOURCE_COMMIT, SOURCE_REPOSITORY } from "./constants.mjs";
import { InstallerError } from "./errors.mjs";

const AGENT_IDS = Object.freeze(["review", "audit", "issue", "fix"]);
const EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "max", "xhigh"]);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CAPS = Object.freeze({
  "review.maximumBlockingFindings": [0, 20],
  "review.maximumNonBlockingFindings": [0, 20],
  "review.maximumDiffBytes": [1, 5 * 1024 * 1024],
  "review.maximumChangedFiles": [1, 1_000],
  "audit.maximumIssuesPerRun": [1, 20],
  "audit.repair.maximumFiles": [1, 100],
  "audit.repair.maximumChangedLines": [1, 10_000],
  "audit.repair.maximumPatchBytes": [1, 5 * 1024 * 1024],
  "audit.repair.maximumFileBytes": [1, 1024 * 1024],
  "issues.maximumOpenIssueContext": [1, 200],
  "merge.maximumFiles": [1, 50],
  "merge.maximumChangedLines": [1, 5_000]
});

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
  ["merge.enabled", "Automatic merge"],
  ["automation.maintenanceSchedule", "Maintenance schedule"],
  ["ai.tracing.enabled", "OpenAI tracing"]
]);

function clone(value) {
  return structuredClone(value);
}

function pathParts(path) {
  return path.split(".");
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
    || path === "repository.automationBranchPrefix"
    || path === "ai.tracing.includeSensitiveData"
    || path.startsWith("ai.providers.")
    || /^ai\.agents\.[^.]+\.maxTurns$/.test(path)
    || /^ai\.agents\.[^.]+\.workspace\.allowWrites$/.test(path)
    || path === "audit.repair.protectedPaths"
    || path === "audit.repair.validationCommands"
    || path === "merge.allowUserPullRequests"
    || path === "merge.allowedUserAuthors"
    || path === "merge.blockedPaths";
}

function enumChoices(path, policy) {
  if (/^ai\.agents\.[^.]+\.provider$/.test(path)) return Object.keys(policy.ai.providers);
  if (/^ai\.agents\.[^.]+\.(?:workspace\.)?effort$/.test(path)) return EFFORTS;
  if (path === "merge.method") return ["MERGE", "SQUASH", "REBASE"];
  return null;
}

function policyRow(policy, path, label = path) {
  const value = getPath(policy, path);
  const choices = enumChoices(path, policy);
  return {
    id: `policy:${path}`,
    section: path.split(".")[0],
    label,
    path,
    value,
    readOnly: readOnlyPolicyPath(path),
    kind: readOnlyPolicyPath(path) ? "readonly"
      : choices ? "enum"
        : typeof value === "boolean" ? "boolean"
          : typeof value === "number" ? "number"
            : typeof value === "string" ? "string"
              : "json",
    ...(choices ? { choices } : {})
  };
}

function flattenPolicy(policy, value = policy, prefix = "", rows = []) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === "ai.providers" || /^ai\.agents\.[^.]+\.modelSettings$/.test(path)) {
      rows.push(policyRow(policy, path));
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      flattenPolicy(policy, child, path, rows);
    } else {
      rows.push(policyRow(policy, path));
    }
  }
  return rows;
}

export function createEditableSettings({ policy, modes, enabled, profiles = {} }) {
  return {
    policy: clone(policy),
    modes: [...modes],
    enabled: enabled !== false,
    profiles: Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, profiles[id] ?? profiles[AGENT_PROFILES[id].target] ?? ""]))
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
      label: AGENT_PROFILES[profile].purpose,
      kind: "profile",
      value: settings.profiles[profile],
      profile
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
    next.profiles[row.profile] = value;
  } else {
    setPath(next.policy, row.path, value);
    if (/^ai\.agents\.[^.]+\.provider$/.test(row.path)) {
      const agent = row.path.split(".")[2];
      next.policy.ai.agents[agent].modelSettings = value === "openai"
        ? { text: { verbosity: "low" } }
        : value === "deepseek"
          ? { temperature: 0.2, providerData: { thinking: { type: "disabled" }, response_format: { type: "json_object" } } }
          : {};
      if (!next.policy.ai.providers[value]?.supportsReasoningEffort) next.policy.ai.agents[agent].effort = "none";
    }
    if (row.path === "repository.ownerLogins") next.policy.merge.allowedUserAuthors = [...value];
  }
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

function requiredString(value, name, maximum = 16_384) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new InstallerError(`${name} is invalid.`, { code: "SETTING_INVALID" });
  }
}

function modelId(value, name) {
  requiredString(value, name, 256);
  if (/\s/.test(value)) throw new InstallerError(`${name} cannot contain whitespace.`, { code: "SETTING_INVALID" });
}

function stringList(value, name, maximumEntries = 128, maximumLength = 16_384) {
  if (!Array.isArray(value) || value.length > maximumEntries || new Set(value).size !== value.length) {
    throw new InstallerError(`${name} must be a bounded JSON string list without duplicates.`, { code: "SETTING_INVALID" });
  }
  for (const item of value) requiredString(item, name, maximumLength);
}

function validateJson(value, name, depth = 0) {
  if (depth > 20) throw new InstallerError(`${name} is nested too deeply.`, { code: "SETTING_INVALID" });
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") return requiredString(value, name);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new InstallerError(`${name} contains an invalid number.`, { code: "SETTING_INVALID" });
    return;
  }
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value ?? {});
  if (value === null || typeof value !== "object" || [...entries].length > 128) throw new InstallerError(`${name} is invalid.`, { code: "SETTING_INVALID" });
  for (const [key, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(String(key))) throw new InstallerError(`${name} contains a forbidden key.`, { code: "SETTING_INVALID" });
    validateJson(child, `${name}.${key}`, depth + 1);
  }
}

export function validateEditableSettings(settings, baselinePolicy) {
  if (!settings || typeof settings !== "object" || typeof settings.enabled !== "boolean") throw new InstallerError("Codekeeper settings are invalid.", { code: "SETTING_INVALID" });
  if (!Array.isArray(settings.modes) || !settings.modes.length || new Set(settings.modes).size !== settings.modes.length || settings.modes.some((mode) => !MODE_IDS.includes(mode))) {
    throw new InstallerError("Select at least one installed workflow.", { code: "SETTING_INVALID" });
  }
  const policy = settings.policy;
  if (policy?.version !== 3) throw new InstallerError("Policy version is read-only.", { code: "SETTING_INVALID" });
  for (const path of [
    "repository.defaultBranch", "repository.automationBranchPrefix", "ai.providers",
    "ai.tracing.includeSensitiveData", "audit.repair.protectedPaths", "audit.repair.validationCommands",
    "merge.allowUserPullRequests", "merge.blockedPaths"
  ]) {
    if (!equal(getPath(policy, path), getPath(baselinePolicy, path))) throw new InstallerError(`${path} is a read-only safety boundary.`, { code: "SETTING_INVALID" });
  }
  requiredString(policy.repository.displayName, "repository.displayName", 256);
  stringList(policy.repository.ownerLogins, "repository.ownerLogins", 64, 256);
  if (policy.repository.ownerLogins.some((login) => !LOGIN.test(login)) || !equal(policy.merge.allowedUserAuthors, policy.repository.ownerLogins)) {
    throw new InstallerError("Owner logins are invalid or out of sync.", { code: "SETTING_INVALID" });
  }
  stringList(policy.projectInvariants, "projectInvariants", 64, 4_096);
  for (const key of ["automaticPrReview", "reviewFeedbackTriage", "issueTriage", "ownerRequests"]) {
    if (typeof policy.automation[key] !== "boolean") throw new InstallerError(`automation.${key} must be boolean.`, { code: "SETTING_INVALID" });
  }
  requiredString(policy.automation.maintenanceSchedule, "automation.maintenanceSchedule", 100);
  if (!/^[^\s"'#]+(?:\s+[^\s"'#]+){4}$/.test(policy.automation.maintenanceSchedule)) throw new InstallerError("Maintenance schedule must contain five safe cron fields.", { code: "SETTING_INVALID" });
  if (typeof policy.ai.tracing.enabled !== "boolean") throw new InstallerError("Tracing must be boolean.", { code: "SETTING_INVALID" });
  for (const agentId of AGENT_IDS) {
    const agent = policy.ai.agents[agentId];
    if (!policy.ai.providers[agent.provider]) throw new InstallerError(`${agentId} references an unknown provider.`, { code: "SETTING_INVALID" });
    modelId(agent.model, `${agentId} model`);
    if (!EFFORTS.includes(agent.effort) || (agent.effort !== "none" && !policy.ai.providers[agent.provider].supportsReasoningEffort)) {
      throw new InstallerError(`${agentId} effort is incompatible with its provider.`, { code: "SETTING_INVALID" });
    }
    if (agent.maxTurns !== 1 || !Number.isSafeInteger(agent.maximumAttempts) || agent.maximumAttempts < 1 || agent.maximumAttempts > 5) {
      throw new InstallerError(`${agentId} turn and retry limits are invalid.`, { code: "SETTING_INVALID" });
    }
    if (!agent.modelSettings || typeof agent.modelSettings !== "object" || Array.isArray(agent.modelSettings)) throw new InstallerError(`${agentId}.modelSettings must be a JSON object.`, { code: "SETTING_INVALID" });
    validateJson(agent.modelSettings, `${agentId}.modelSettings`);
    if (typeof agent.workspace.enabled !== "boolean" || !equal(agent.workspace.allowWrites, baselinePolicy.ai.agents[agentId].workspace.allowWrites)) {
      throw new InstallerError(`${agentId} workspace boundary is invalid.`, { code: "SETTING_INVALID" });
    }
    modelId(agent.workspace.model, `${agentId} workspace model`);
    if (!EFFORTS.includes(agent.workspace.effort)) throw new InstallerError(`${agentId} workspace effort is invalid.`, { code: "SETTING_INVALID" });
  }
  for (const [path, [minimum, maximum]] of Object.entries(CAPS)) {
    const value = getPath(policy, path);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new InstallerError(`${path} must be between ${minimum} and ${maximum}.`, { code: "SETTING_INVALID" });
  }
  for (const path of ["review.allowedLabels", "review.managedLabels", "audit.repair.allowedPaths", "issues.managedLabels", "merge.allowedPaths"]) {
    stringList(getPath(policy, path), path, 128, 1_024);
  }
  for (const key of ["autoRepair", "createDeferredIssues", "includeDiffInAgentContext"]) if (typeof policy.review[key] !== "boolean") throw new InstallerError(`review.${key} must be boolean.`, { code: "SETTING_INVALID" });
  for (const key of ["enabled", "allowAdd"]) if (typeof policy.audit.repair[key] !== "boolean") throw new InstallerError(`audit.repair.${key} must be boolean.`, { code: "SETTING_INVALID" });
  for (const key of ["allowAiImplementation", "closeExactDuplicates"]) if (typeof policy.issues[key] !== "boolean") throw new InstallerError(`issues.${key} must be boolean.`, { code: "SETTING_INVALID" });
  if (!["MERGE", "SQUASH", "REBASE"].includes(policy.merge.method)) throw new InstallerError("merge.method is invalid.", { code: "SETTING_INVALID" });
  for (const key of ["enabled", "allowAutomationPullRequests"]) if (typeof policy.merge[key] !== "boolean") throw new InstallerError(`merge.${key} must be boolean.`, { code: "SETTING_INVALID" });
  for (const [name, label] of Object.entries(policy.labels)) {
    if (!/^[0-9A-Fa-f]{6}$/.test(label.color) || typeof label.description !== "string" || label.description.length > 1_024) throw new InstallerError(`Label ${name} is invalid.`, { code: "SETTING_INVALID" });
  }
  for (const label of [...policy.review.allowedLabels, ...policy.review.managedLabels, ...policy.issues.managedLabels]) {
    if (!policy.labels[label]) throw new InstallerError(`Policy references undefined label ${label}.`, { code: "SETTING_INVALID" });
  }
  for (const profile of AGENT_PROFILE_IDS) {
    const source = settings.profiles[profile];
    if (typeof source !== "string" || !source.trim() || Buffer.byteLength(source) > 64 * 1024 || source.includes("\0")) throw new InstallerError(`${profile} profile is invalid.`, { code: "SETTING_INVALID" });
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
    displayName: policy.repository.displayName,
    ownerLogins: [...policy.repository.ownerLogins],
    tracing: policy.ai.tracing.enabled,
    capabilities: [
      ...(settings.modes.includes("review") && settings.modes.includes("fix") && policy.review.autoRepair ? ["reviewRepair"] : []),
      ...(settings.modes.includes("maintain") && policy.audit.repair.enabled ? ["repair"] : []),
      ...(settings.modes.includes("fix") && policy.issues.allowAiImplementation ? ["issueImplementation"] : []),
      ...(settings.modes.includes("issues") && policy.issues.closeExactDuplicates ? ["duplicateClosure"] : []),
      ...(settings.modes.some((mode) => mode === "maintain" || mode === "fix") && policy.merge.enabled ? ["autoMerge"] : [])
    ],
    models: Object.fromEntries(settings.modes.map((mode) => {
      const agent = policy.ai.agents[MODES[mode].policyAgent];
      return [mode, { provider: agent.provider, model: agent.model, effort: agent.effort }];
    }))
  };
}
