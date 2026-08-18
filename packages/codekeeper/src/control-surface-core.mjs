const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MODE_IDS = Object.freeze(["review", "maintain", "issues", "fix"]);
export const CONTROL_CAPABILITY_IDS = Object.freeze([
  "reviewRepair",
  "repair",
  "issueImplementation",
  "duplicateClosure",
  "autoMerge"
]);
const CAPABILITY_SET = new Set(CONTROL_CAPABILITY_IDS);
const CONFIG_KEYS = Object.freeze([
  "version",
  "displayName",
  "ownerLogins",
  "modes",
  "preset",
  "models",
  "capabilities",
  "tracing",
  "maintenanceScheduled",
  "enabled",
  "validationCommand",
  "appClientId",
  "automationBotLogin"
]);

function invalid(message, code = "CONTROL_SURFACE_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactObject(value, label, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object.`, "CONFIG_INVALID");
  }
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (unexpected.length) {
    invalid(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "CONFIG_INVALID");
  }
  return value;
}

function inspectForCredentials(value, trail = "Configuration", seen = new WeakSet()) {
  if (typeof value === "string") {
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(value)) {
      invalid(`${trail} must not contain a private key.`, "CONFIG_SECRET_FORBIDDEN");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) invalid(`${trail} must be JSON-compatible.`, "CONFIG_INVALID");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|token|private.?key|api.?key|credential|password)/i.test(key)) {
      invalid(`${trail} must not contain credential field ${key}.`, "CONFIG_SECRET_FORBIDDEN");
    }
    inspectForCredentials(child, `${trail}.${key}`, seen);
  }
  seen.delete(value);
}

export function parseControlArgs(command, argv) {
  if (!["status", "explain", "plan"].includes(command)) {
    invalid(`Unsupported control-surface command: ${command}`, "CLI_USAGE");
  }
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const options = {
    json: false,
    apply: false,
    capability: null,
    configPath: null,
    packageIntegrity: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    else if (value === "--apply" && command === "plan") options.apply = true;
    else if (value === "--capability" && command === "explain") {
      const capability = argv[index + 1];
      if (!CAPABILITY_SET.has(capability)) {
        invalid("--capability requires one supported capability ID.", "CLI_USAGE");
      }
      options.capability = capability;
      index += 1;
    } else if (value === "--config" && command === "plan") {
      const configPath = argv[index + 1];
      if (!configPath || /[\u0000-\u001f\u007f]/.test(configPath)) {
        invalid("--config requires a safe file path.", "CLI_USAGE");
      }
      options.configPath = configPath;
      index += 1;
    } else if (value === "--package-integrity" && command === "plan") {
      const integrity = argv[index + 1];
      if (!integrity || !SHA512_INTEGRITY.test(integrity)) {
        invalid("--package-integrity requires a SHA-512 npm integrity.", "CLI_USAGE");
      }
      options.packageIntegrity = integrity;
      index += 1;
    } else {
      invalid(`Unsupported ${command} option: ${value}`, "CLI_USAGE");
    }
  }
  if (command === "plan" && !options.configPath) {
    invalid("plan requires --config FILE.", "CLI_USAGE");
  }
  return Object.freeze(options);
}

export function parseNonInteractiveConfig(value) {
  inspectForCredentials(value);
  exactObject(value, "Configuration", CONFIG_KEYS);
  if (value.version !== 1) invalid("Configuration version must be 1.", "CONFIG_INVALID");
  if (
    value.displayName !== undefined &&
    (typeof value.displayName !== "string" || value.displayName.trim() !== value.displayName || !value.displayName)
  ) {
    invalid("displayName must be a non-empty trimmed string.", "CONFIG_INVALID");
  }
  if (value.ownerLogins !== undefined) {
    if (
      !Array.isArray(value.ownerLogins) ||
      !value.ownerLogins.length ||
      value.ownerLogins.some((login) => typeof login !== "string" || !LOGIN.test(login.trim().toLowerCase())) ||
      new Set(value.ownerLogins.map((login) => login.trim().toLowerCase())).size !== value.ownerLogins.length
    ) {
      invalid("ownerLogins must contain unique GitHub login names.", "CONFIG_INVALID");
    }
  }
  if (value.modes !== undefined) {
    if (
      !Array.isArray(value.modes) ||
      !value.modes.length ||
      value.modes.some((mode) => !MODE_IDS.includes(mode)) ||
      new Set(value.modes).size !== value.modes.length
    ) {
      invalid("modes must contain unique supported workflow IDs.", "CONFIG_INVALID");
    }
  }
  if (value.preset !== undefined && !["openai", "mixed"].includes(value.preset)) {
    invalid("preset must be openai or mixed.", "CONFIG_INVALID");
  }
  if (value.capabilities !== undefined) {
    if (
      !Array.isArray(value.capabilities) ||
      value.capabilities.some((id) => !CAPABILITY_SET.has(id)) ||
      new Set(value.capabilities).size !== value.capabilities.length
    ) {
      invalid("capabilities must contain unique supported capability IDs.", "CONFIG_INVALID");
    }
  }
  for (const key of ["tracing", "maintenanceScheduled", "enabled"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      invalid(`${key} must be boolean.`, "CONFIG_INVALID");
    }
  }
  if (value.models !== undefined) {
    exactObject(value.models, "models", MODE_IDS);
    for (const [mode, model] of Object.entries(value.models)) {
      exactObject(model, `models.${mode}`, ["provider", "model", "effort", "modelSettings"]);
      if (typeof model.provider !== "string" || !model.provider.trim()) {
        invalid(`models.${mode}.provider must be a non-empty string.`, "CONFIG_INVALID");
      }
      if (
        typeof model.model !== "string" ||
        !model.model.trim() ||
        /[\s\u0000-\u001f\u007f]/.test(model.model)
      ) {
        invalid(`models.${mode}.model must be one safe model ID.`, "CONFIG_INVALID");
      }
      if (
        typeof model.effort !== "string" ||
        !["none", "minimal", "low", "medium", "high", "max", "xhigh"].includes(model.effort)
      ) {
        invalid(`models.${mode}.effort is unsupported.`, "CONFIG_INVALID");
      }
    }
  }
  return Object.freeze(structuredClone(value));
}

function capabilityExplanation(status, capability = null) {
  const details = {
    reviewRepair: "Allows one bounded repair pass for an eligible same-repository pull request after review.",
    repair: "Allows a manually dispatched live maintenance run to open a bounded repair pull request.",
    issueImplementation: "Allows a ready issue to start the Fixer workflow and open an implementation pull request.",
    duplicateClosure: "Allows issue triage to close only an exact duplicate after current-state revalidation.",
    autoMerge: "Allows Codekeeper to merge an eligible validated repair pull request within policy."
  };
  const selected = capability ? [capability] : CONTROL_CAPABILITY_IDS;
  return Object.freeze(Object.fromEntries(selected.map((id) => [id, Object.freeze({
    enabled: status.capabilities[id] === true,
    description: details[id]
  })])));
}

export function explainControlSurface(status, capability = null) {
  if (capability !== null && !CAPABILITY_SET.has(capability)) {
    invalid("Unsupported capability explanation.", "CLI_USAGE");
  }
  if (!status?.installed) {
    return Object.freeze({
      version: 1,
      installed: false,
      repository: status?.repository ?? null,
      message: "Codekeeper is not installed in this checkout."
    });
  }
  return Object.freeze({
    version: 1,
    installed: true,
    repository: status.repository,
    enabled: status.enabled,
    authority: Object.freeze({
      owners: status.owners,
      appPermissions: status.appPermissions,
      capabilities: capabilityExplanation(status, capability),
      automaticTriggers: Object.freeze({
        review: status.modes.includes("review"),
        issueTriage: status.modes.includes("issues"),
        maintenanceSchedule: status.scheduledMaintenance,
        ownerRequests: status.ownerRequests === true
      })
    }),
    data: Object.freeze({
      providers: Object.freeze([...new Set(Object.values(status.agents).map((agent) => agent.provider))].sort()),
      tracing: status.tracing,
      requiredSecretNames: status.requiredSecrets
    }),
    validation: Object.freeze({
      commands: status.validationCommands,
      budgets: status.budgets
    })
  });
}
