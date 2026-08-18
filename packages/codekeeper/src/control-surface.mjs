import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { loadVerifiedAssets } from "./assets.mjs";
import {
  CAPABILITY_IDS,
  MODES,
  PACKAGE_NAME,
  PACKAGE_VERSION
} from "./constants.mjs";
import { InstallerError } from "./errors.mjs";
import { installPlan } from "./install.mjs";
import { normalizePackageRelease } from "./package-release.mjs";
import {
  appPermissions,
  buildInstallPlan,
  normalizeCapabilities,
  normalizeModes,
  normalizeOwnerLogins,
  requiredSecretNames
} from "./plan.mjs";
import { inspectInstallationFiles, inspectRepository } from "./preflight.mjs";
import {
  CONTROL_CAPABILITY_IDS,
  explainControlSurface,
  parseControlArgs,
  parseNonInteractiveConfig
} from "./control-surface-core.mjs";

const MAX_CONFIG_BYTES = 1024 * 1024;

if (JSON.stringify(CAPABILITY_IDS) !== JSON.stringify(CONTROL_CAPABILITY_IDS)) {
  throw new Error("Control-surface capability IDs are out of sync with installer policy constants");
}

export { explainControlSurface, parseControlArgs, parseNonInteractiveConfig };

function fail(message, code = "CONTROL_SURFACE_INVALID") {
  throw new InstallerError(message, { code });
}

async function checked(runner, command, args, options, message) {
  const result = await runner.run(command, args, options);
  if (
    !result ||
    result.status !== 0 ||
    result.timedOut === true ||
    result.truncated === true ||
    typeof result.stdout !== "string"
  ) {
    fail(message, "CONTROL_SURFACE_COMMAND_FAILED");
  }
  return result.stdout.trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new InstallerError(`${label} is not valid JSON.`, {
      code: "CONTROL_SURFACE_INVALID_RESPONSE",
      cause
    });
  }
}

function parseGitHubRepository(originUrl) {
  const source = String(originUrl ?? "").trim();
  const match =
    source.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    source.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    source.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) fail("origin must be a GitHub.com repository.", "UNSUPPORTED_REPOSITORY");
  return `${match[1]}/${match[2]}`;
}

async function readConfigFile(configPath, { cwd, fsImpl = { lstat, readFile } }) {
  const target = path.resolve(cwd, configPath);
  const stat = await fsImpl.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    fail("Configuration must be a regular non-symlink JSON file no larger than 1 MiB.", "CONFIG_INVALID");
  }
  return parseNonInteractiveConfig(parseJson(await fsImpl.readFile(target, "utf8"), "Configuration file"));
}

function deriveCapabilities(policy) {
  return Object.freeze([
    ...(policy?.review?.autoRepair === true ? ["reviewRepair"] : []),
    ...(policy?.audit?.repair?.enabled === true ? ["repair"] : []),
    ...(policy?.issues?.allowAiImplementation === true ? ["issueImplementation"] : []),
    ...(policy?.issues?.closeExactDuplicates === true ? ["duplicateClosure"] : []),
    ...(policy?.merge?.enabled === true ? ["autoMerge"] : [])
  ]);
}

function deriveModels(modes, policy) {
  return Object.freeze(Object.fromEntries(modes.map((mode) => {
    const agent = policy.ai.agents[MODES[mode].policyAgent];
    return [mode, Object.freeze({
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      modelSettings: structuredClone(agent.modelSettings ?? {})
    })];
  })));
}

function derivePreset(policy) {
  return policy?.ai?.agents?.issue?.provider === "deepseek" ? "mixed" : "openai";
}

function sanitizePlan(plan) {
  return Object.freeze({
    version: 1,
    operation: plan.operation,
    repository: plan.repository,
    defaultBranch: plan.defaultBranch,
    originalHead: plan.originalHead,
    branch: plan.branch,
    packageVersion: plan.packageVersion,
    source: plan.source,
    modes: plan.modes,
    enabled: plan.enabled,
    tracing: plan.tracing,
    maintenanceScheduled: plan.maintenanceScheduled,
    capabilities: plan.capabilities,
    appPermissions: plan.appPermissions,
    models: plan.modelSummary,
    files: Object.freeze(plan.files.map((file) => Object.freeze({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      previousSha256: file.previousSha256 ?? null,
      delete: file.delete === true
    }))),
    variables: Object.freeze(plan.variables.map((variable) => Object.freeze({
      name: variable.name,
      valueSha256: createHash("sha256").update(variable.value).digest("hex")
    }))),
    secrets: Object.freeze(plan.secrets.map((secret) => Object.freeze({
      name: secret.name,
      purpose: secret.purpose
    }))),
    settingsOnly: plan.settingsOnly
  });
}

function sameSnapshot(left, right) {
  for (const key of ["root", "repository", "defaultBranch", "headSha", "remoteDefaultSha"]) {
    if (left[key] !== right[key]) return false;
  }
  const leftSettings = left.existingSettings ?? null;
  const rightSettings = right.existingSettings ?? null;
  return JSON.stringify(leftSettings) === JSON.stringify(rightSettings);
}

async function repositoryContext({ runner, cwd }) {
  const root = await checked(runner, "git", ["rev-parse", "--show-toplevel"], { cwd }, "Run this command inside a Git checkout.");
  const originUrl = await checked(runner, "git", ["remote", "get-url", "origin"], { cwd: root }, "An origin remote is required.");
  const repository = parseGitHubRepository(originUrl);
  const repositoryData = parseJson(
    await checked(runner, "gh", ["api", "--hostname", "github.com", `repos/${repository}`], { cwd: root }, "Could not read the GitHub repository."),
    "GitHub repository response"
  );
  return Object.freeze({
    root,
    repository,
    defaultBranch: repositoryData?.default_branch ?? null,
    admin: repositoryData?.permissions?.admin === true
  });
}

export async function inspectControlSurface({ runner, cwd = process.cwd() } = {}) {
  if (!runner || typeof runner.run !== "function") throw new TypeError("A command runner is required.");
  const context = await repositoryContext({ runner, cwd });
  let installation = null;
  try {
    installation = await inspectInstallationFiles(context.root);
  } catch (cause) {
    throw new InstallerError("The installed Codekeeper files are incomplete or invalid.", {
      code: "INSTALLATION_INVALID",
      cause
    });
  }
  if (!installation) {
    return Object.freeze({
      version: 1,
      repository: context.repository,
      defaultBranch: context.defaultBranch,
      installed: false
    });
  }
  const variables = parseJson(
    await checked(
      runner,
      "gh",
      ["variable", "list", "--repo", context.repository, "--json", "name,value"],
      { cwd: context.root },
      "Could not inspect repository variables."
    ),
    "GitHub variable response"
  );
  if (!Array.isArray(variables) || variables.some((item) => typeof item?.name !== "string" || typeof item?.value !== "string")) {
    fail("GitHub returned an invalid variable list.", "CONTROL_SURFACE_INVALID_RESPONSE");
  }
  const variableMap = new Map(variables.map((item) => [item.name, item.value]));
  const policy = installation.policy;
  const capabilities = deriveCapabilities(policy);
  const permissions = appPermissions({
    modes: installation.modes,
    capabilities,
    ownerRequests: policy.automation?.ownerRequests === true
  });
  const requiredSecrets = requiredSecretNames({
    modes: installation.modes,
    models: deriveModels(installation.modes, policy),
    tracing: policy.ai.tracing?.enabled === true,
    policy
  });
  const validationCommands = Object.freeze([...(policy.audit?.repair?.validationCommands ?? [])]);
  const agents = Object.freeze(Object.fromEntries(installation.modes.map((mode) => {
    const agent = policy.ai.agents[MODES[mode].policyAgent];
    return [mode, Object.freeze({
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      workspace: Object.freeze({
        enabled: agent.workspace?.enabled === true,
        model: agent.workspace?.model ?? null,
        effort: agent.workspace?.effort ?? null,
        allowWrites: agent.workspace?.allowWrites === true
      })
    })];
  })));
  return Object.freeze({
    version: 1,
    repository: context.repository,
    defaultBranch: context.defaultBranch,
    installed: true,
    enabled: variableMap.get("CODEKEEPER_ENABLED") === "true",
    package: Object.freeze({
      name: installation.releaseManifest?.package?.name ?? "codekeeper",
      version: installation.releaseManifest?.package?.version ?? null,
      integrity: installation.releaseManifest?.package?.integrity ?? null,
      source: installation.releaseManifest?.source ?? null
    }),
    displayName: policy.repository?.displayName ?? null,
    owners: Object.freeze([...(policy.repository?.ownerLogins ?? [])]),
    modes: installation.modes,
    capabilities: Object.freeze(Object.fromEntries(CAPABILITY_IDS.map((id) => [id, capabilities.includes(id)]))),
    appPermissions: permissions,
    requiredSecrets,
    agents,
    tracing: policy.ai.tracing?.enabled === true,
    scheduledMaintenance: installation.maintenanceScheduled,
    ownerRequests: policy.automation?.ownerRequests === true,
    validationCommands,
    budgets: Object.freeze({
      reviewFiles: policy.review?.maxFiles ?? null,
      reviewChangedLines: policy.review?.maxChangedLines ?? null,
      auditFindings: policy.audit?.maxFindings ?? null,
      repairFiles: policy.audit?.repair?.maxFiles ?? null,
      repairChangedLines: policy.audit?.repair?.maxChangedLines ?? null,
      modelAttempts: policy.ai?.maxAttempts ?? null
    })
  });
}

async function buildConfigPlan({
  runner,
  cwd,
  config,
  packageIntegrity,
  environment,
  loadAssets = loadVerifiedAssets,
  inspect = inspectRepository
}) {
  if (typeof runner.resolveTrustedCommands === "function") runner = await runner.resolveTrustedCommands({ cwd });
  const snapshot = await inspect({ runner, cwd, interactive: true });
  const integrity = packageIntegrity ?? environment.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY;
  const packageRelease = normalizePackageRelease(
    {
      name: PACKAGE_NAME,
      version: environment.CODEKEEPER_UPDATE_EXPECTED_VERSION ?? PACKAGE_VERSION,
      integrity
    },
    { code: "PACKAGE_INTEGRITY_REQUIRED" }
  );
  const bundle = await loadAssets({ packageRelease });
  const installation = snapshot.installation ?? null;
  const modes = config.modes ?? installation?.modes ?? ["review", "maintain"];
  const preset = config.preset ?? (installation ? derivePreset(installation.policy) : "openai");
  const capabilities = config.capabilities ?? (installation ? deriveCapabilities(installation.policy) : []);
  normalizeCapabilities(modes, capabilities);
  const answers = {
    modes,
    preset,
    displayName: config.displayName ?? installation?.policy?.repository?.displayName ?? snapshot.displayName,
    ownerLogins: config.ownerLogins ?? installation?.policy?.repository?.ownerLogins ?? [snapshot.viewerLogin],
    models: config.models ?? (installation ? deriveModels(modes, installation.policy) : {}),
    capabilities,
    tracing: config.tracing ?? installation?.policy?.ai?.tracing?.enabled ?? false,
    maintenanceScheduled: config.maintenanceScheduled ?? installation?.maintenanceScheduled ?? false,
    enabled: config.enabled ?? snapshot.existingSettings?.enabled ?? true,
    validationCommand: config.validationCommand ?? snapshot.validationCommandCandidate,
    appClientId: config.appClientId ?? snapshot.existingSettings?.appClientId,
    automationBotLogin: config.automationBotLogin ?? snapshot.existingSettings?.automationBotLogin
  };
  const plan = buildInstallPlan({ bundle, snapshot, answers });
  return { runner, snapshot, plan };
}

function printStatus(status, output) {
  output.write(`\nCodekeeper status\n`);
  output.write(`  Repository: ${status.repository}\n`);
  output.write(`  Installed: ${status.installed ? "yes" : "no"}\n`);
  if (!status.installed) return;
  output.write(`  Enabled: ${status.enabled ? "yes" : "no"}\n`);
  output.write(`  Modes: ${status.modes.join(", ")}\n`);
  output.write(`  Package: ${status.package.name}@${status.package.version ?? "unknown"}\n`);
  output.write(`  Tracing: ${status.tracing ? "enabled" : "disabled"}\n`);
  output.write(`  Scheduled maintenance: ${status.scheduledMaintenance ? "enabled" : "disabled"}\n`);
}

function printExplanation(explanation, output) {
  output.write("\nCodekeeper authority\n");
  if (!explanation.installed) {
    output.write("  Codekeeper is not installed.\n");
    return;
  }
  output.write(`  Enabled: ${explanation.enabled ? "yes" : "no"}\n`);
  output.write(`  Owners: ${explanation.authority.owners.join(", ")}\n`);
  output.write(`  App permissions: ${Object.entries(explanation.authority.appPermissions).map(([key, value]) => `${key}=${value}`).join(", ")}\n`);
  for (const [id, detail] of Object.entries(explanation.authority.capabilities)) {
    output.write(`  ${id}: ${detail.enabled ? "enabled" : "disabled"} — ${detail.description}\n`);
  }
  output.write(`  Providers: ${explanation.data.providers.join(", ")}\n`);
  output.write(`  Required secret names: ${explanation.data.requiredSecretNames.join(", ")}\n`);
}

function printPlan(plan, output) {
  output.write("\nCodekeeper noninteractive plan\n");
  output.write(`  Operation: ${plan.operation}\n`);
  output.write(`  Repository: ${plan.repository}\n`);
  output.write(`  Branch: ${plan.branch}\n`);
  output.write(`  Files: ${plan.files.length}\n`);
  output.write(`  Variables: ${plan.variables.map((item) => item.name).join(", ") || "none"}\n`);
  output.write(`  Secrets requiring secure entry: ${plan.secrets.map((item) => item.name).join(", ") || "none"}\n`);
}

export async function runControlSurfaceCli({
  command,
  argv = process.argv.slice(3),
  cwd = process.cwd(),
  runner,
  output = process.stdout,
  errorOutput = process.stderr,
  environment = process.env,
  fsImpl
} = {}) {
  try {
    const options = parseControlArgs(command, argv);
    if (command === "status") {
      const status = await inspectControlSurface({ runner, cwd });
      if (options.json) output.write(`${JSON.stringify(status)}\n`);
      else printStatus(status, output);
      return status.installed ? 0 : 1;
    }
    if (command === "explain") {
      const explanation = explainControlSurface(await inspectControlSurface({ runner, cwd }), options.capability);
      if (options.json) output.write(`${JSON.stringify(explanation)}\n`);
      else printExplanation(explanation, output);
      return explanation.installed ? 0 : 1;
    }

    const config = await readConfigFile(options.configPath, { cwd, fsImpl });
    const prepared = await buildConfigPlan({
      runner,
      cwd,
      config,
      packageIntegrity: options.packageIntegrity,
      environment
    });
    const safePlan = sanitizePlan(prepared.plan);
    if (!options.apply) {
      if (options.json) output.write(`${JSON.stringify(safePlan)}\n`);
      else printPlan(safePlan, output);
      return 0;
    }
    if (environment.CODEKEEPER_NONINTERACTIVE_APPLY !== "true") {
      fail("Set CODEKEEPER_NONINTERACTIVE_APPLY=true to apply a reviewed noninteractive plan.", "NONINTERACTIVE_APPLY_NOT_AUTHORIZED");
    }
    if (prepared.plan.secrets.length) {
      fail(
        `Noninteractive apply requires secure entry for: ${prepared.plan.secrets.map((secret) => secret.name).join(", ")}. Run the interactive installer instead.`,
        "NONINTERACTIVE_SECRET_REQUIRED"
      );
    }
    const current = await inspectRepository({ runner: prepared.runner, cwd, interactive: true });
    if (!sameSnapshot(prepared.snapshot, current)) {
      fail("Repository or settings state changed after the plan was created.", "PREFLIGHT_CHANGED");
    }
    const receipt = await installPlan(prepared.plan, {
      runner: prepared.runner,
      output,
      resumeCommand: `codekeeper plan --config ${options.configPath} --apply`
    });
    const result = Object.freeze({ plan: safePlan, receipt });
    if (options.json) output.write(`${JSON.stringify(result)}\n`);
    else {
      printPlan(safePlan, output);
      output.write(`  Pull request: ${receipt.pullRequestUrl}\n`);
    }
    return 0;
  } catch (error) {
    errorOutput.write(`Codekeeper ${command} stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    return error?.code === "CLI_USAGE" ? 2 : 1;
  }
}
