import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_PERMISSION_VALUES,
  assistantAppPermissions,
  workflowAppPermissions
} from "./app-permissions.mjs";
import {
  MODE_IDS,
  MODEL_PROVIDER_SECRETS,
  MODES,
  PACKAGE_NAME,
  RELEASE_MANIFEST_TARGET,
  RELEASE_PACKAGE_ASSETS,
  SOURCE_REPOSITORY
} from "./constants.mjs";
import {
  buildDistributionMetadata,
  distributionMetadataSource,
  SOURCE_RESOLVED_ASSETS,
} from "./distribution.mjs";
import {
  activeRepositoryArtifacts,
  ASSET_KEYS,
} from "./repository-artifacts.mjs";
import { InstallerError } from "./errors.mjs";
import { applyReleasePolicyBoundaries, upgradePolicy } from "./policy.mjs";
import { normalizePackageRelease } from "./package-release.mjs";

const DEFAULT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BOT_LOGIN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,99}))\[bot\]$/;
const DISABLED_BOT_MENTION = "@_codekeeper_owner_commands_disabled_";
const RELEASE_PACKAGE_ASSET_MAP = new Map(RELEASE_PACKAGE_ASSETS.map((asset) => [asset.asset, asset]));
const SOURCE_ASSET_MAP = new Map(SOURCE_RESOLVED_ASSETS.map((asset) => [asset.asset, asset]));
const APP_PERMISSION_VALUE_SET = new Set(APP_PERMISSION_VALUES);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function exactKeys(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new InstallerError(`${label} inventory does not match this installer release.`, { code: "ASSET_INVENTORY_INVALID" });
  }
}

async function readRegularFile(fsImpl, filePath, label) {
  const stat = await fsImpl.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new InstallerError(`${label} must be a regular, non-symlink file.`, { code: "ASSET_TYPE_INVALID" });
  }
  return fsImpl.readFile(filePath);
}

async function hasRegularFile(fsImpl, filePath, label) {
  try {
    const stat = await fsImpl.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new InstallerError(`${label} must be a regular, non-symlink file.`, { code: "ASSET_TYPE_INVALID" });
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function resolveAssetFilePath(assetKey, { packageRoot, assetsRoot, stagedPackage }) {
  const sourceAsset = SOURCE_ASSET_MAP.get(assetKey);
  if (sourceAsset) {
    if (stagedPackage) return path.join(packageRoot, ...sourceAsset.packagePath.split("/"));
    if (packageRoot === DEFAULT_PACKAGE_ROOT) {
      return path.resolve(packageRoot, "..", "..", ...sourceAsset.sourcePath.split("/"));
    }
  }
  return path.join(assetsRoot, ...assetKey.split("/"));
}

async function loadAssetMetadataBytes({ packageRoot, assetsRoot, stagedPackage, fsImpl }) {
  const metadataPath = path.join(assetsRoot, "metadata.json");
  if (await hasRegularFile(fsImpl, metadataPath, "Asset metadata")) {
    return readRegularFile(fsImpl, metadataPath, "Asset metadata");
  }
  if (!stagedPackage && packageRoot === DEFAULT_PACKAGE_ROOT) {
    return distributionMetadataSource(await buildDistributionMetadata({
      repositoryRoot: path.resolve(packageRoot, "..", ".."),
    }));
  }
  throw new InstallerError("Asset metadata must be a regular, non-symlink file.", { code: "ASSET_TYPE_INVALID" });
}

export async function loadVerifiedAssets({
  packageRoot = DEFAULT_PACKAGE_ROOT,
  fsImpl = { readFile, lstat },
  packageRelease = null,
  environment = process.env
} = {}) {
  const assetsRoot = path.join(packageRoot, "assets");
  const stagedPackage = await hasRegularFile(fsImpl, path.join(packageRoot, "release", "manifest.json"), "Package release manifest");
  const metadataBytes = await loadAssetMetadataBytes({ packageRoot, assetsRoot, stagedPackage, fsImpl });
  let metadata;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch (cause) {
    throw new InstallerError("Asset metadata is not valid JSON.", { code: "ASSET_METADATA_INVALID", cause });
  }

  if (metadata?.version !== 1 || !metadata.source || !metadata.assets || typeof metadata.assets !== "object") {
    throw new InstallerError("Asset metadata has an unsupported schema.", { code: "ASSET_METADATA_INVALID" });
  }
  if (!REPOSITORY.test(metadata.source.repository ?? "") || !FULL_SHA.test(metadata.source.commit ?? "")) {
    throw new InstallerError("Asset metadata has invalid source provenance.", { code: "ASSET_METADATA_INVALID" });
  }
  if (metadata.source.repository !== SOURCE_REPOSITORY) {
    throw new InstallerError("Asset metadata does not match this installer's source repository.", { code: "ASSET_METADATA_INVALID" });
  }
  if (stagedPackage) {
    let releaseManifest;
    try {
      releaseManifest = JSON.parse((await readRegularFile(fsImpl, path.join(packageRoot, "release", "manifest.json"), "Package release manifest")).toString("utf8"));
    } catch (cause) {
      throw new InstallerError("Package release manifest is not valid JSON.", { code: "ASSET_METADATA_INVALID", cause });
    }
    if (releaseManifest?.source?.commit !== metadata.source.commit) {
      throw new InstallerError("Asset metadata does not match this package's recorded source commit.", { code: "ASSET_METADATA_INVALID" });
    }
  }
  exactKeys(Object.keys(metadata.assets), ASSET_KEYS, "Asset");

  const contents = {};
  for (const assetKey of ASSET_KEYS) {
    const record = metadata.assets[assetKey];
    if (!record || !SHA256.test(record.sha256 ?? "") || !Number.isSafeInteger(record.bytes) || record.bytes < 1) {
      throw new InstallerError(`Asset metadata is invalid for ${assetKey}.`, { code: "ASSET_METADATA_INVALID" });
    }
    const releaseAsset = RELEASE_PACKAGE_ASSET_MAP.get(assetKey);
    if (releaseAsset && (record.sourcePath !== releaseAsset.sourcePath || record.packagePath !== releaseAsset.packagePath)) {
      throw new InstallerError(`Asset metadata is invalid for ${assetKey}.`, { code: "ASSET_METADATA_INVALID" });
    }
    const assetPath = resolveAssetFilePath(assetKey, { packageRoot, assetsRoot, stagedPackage });
    const bytes = await readRegularFile(fsImpl, assetPath, `Asset ${assetKey}`);
    if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new InstallerError(`Bundled asset verification failed for ${assetKey}.`, { code: "ASSET_DIGEST_MISMATCH" });
    }
    contents[assetKey] = bytes.toString("utf8");
  }

  const environmentRelease = typeof environment.CODEKEEPER_UPDATE_EXPECTED_VERSION === "string"
    || typeof environment.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY === "string"
    ? {
        name: PACKAGE_NAME,
        version: environment.CODEKEEPER_UPDATE_EXPECTED_VERSION,
        integrity: environment.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY
      }
    : null;
  return deepFreeze({
    metadata,
    contents,
    packageRelease: packageRelease || environmentRelease
      ? normalizePackageRelease(packageRelease ?? environmentRelease)
      : null
  });
}

function count(source, token) {
  return source.split(token).length - 1;
}

function assertDisabledPolicy(policy) {
  if (policy?.review?.autoRepair !== false) throw new InstallerError("Bundled policy enables automatic review repair.", { code: "UNSAFE_POLICY" });
  if (policy?.audit?.repair?.enabled !== false) throw new InstallerError("Bundled policy enables repository repair.", { code: "UNSAFE_POLICY" });
  if (policy?.issues?.allowAiImplementation !== false) throw new InstallerError("Bundled policy enables AI issue implementation.", { code: "UNSAFE_POLICY" });
  if (policy?.issues?.closeExactDuplicates !== false) throw new InstallerError("Bundled policy enables automatic duplicate closure.", { code: "UNSAFE_POLICY" });
  if (policy?.merge?.enabled !== false) throw new InstallerError("Bundled policy enables automatic merge.", { code: "UNSAFE_POLICY" });
  if (
    policy?.ai?.orchestration?.enabled !== false ||
    policy?.ai?.orchestration?.providerMultiAgent !== false ||
    ["review", "issues", "fix", "maintain"].some((mode) => policy?.ai?.orchestration?.modes?.[mode] !== false)
  ) {
    throw new InstallerError("Bundled policy enables orchestration.", { code: "UNSAFE_POLICY" });
  }
  if (!Array.isArray(policy.audit.repair.protectedPaths) || !policy.audit.repair.protectedPaths.length) {
    throw new InstallerError("Bundled policy has no protected paths.", { code: "UNSAFE_POLICY" });
  }
  if (!Array.isArray(policy.audit.repair.validationCommands) || !policy.audit.repair.validationCommands.includes("git diff --check")) {
    throw new InstallerError("Bundled policy does not require git diff --check.", { code: "UNSAFE_POLICY" });
  }
}

export function renderPolicy(policySource, {
  displayName,
  defaultBranch,
  ownerLogins,
  capabilities = {},
  models = {},
  tracing = true,
  enforceBundledDefaults = true,
  requiredPolicySource = policySource,
  policyOverride = null,
  refreshReleaseBoundaries = false
}) {
  let policy;
  try {
    const bundledPolicy = upgradePolicy(JSON.parse(policySource));
    if (enforceBundledDefaults) assertDisabledPolicy(bundledPolicy);
    policy = policyOverride ? upgradePolicy(structuredClone(policyOverride)) : bundledPolicy;
  } catch (cause) {
    throw new InstallerError("Bundled policy is invalid or unsupported.", { code: "ASSET_POLICY_INVALID", cause });
  }
  let requiredPolicy;
  try {
    requiredPolicy = upgradePolicy(JSON.parse(requiredPolicySource));
  } catch (cause) {
    throw new InstallerError("Bundled policy is invalid or unsupported.", { code: "ASSET_POLICY_INVALID", cause });
  }
  if (!policy.repository || !policy.merge || !Array.isArray(policy.merge.allowedUserAuthors)) {
    throw new InstallerError("Bundled policy cannot be tailored safely.", { code: "ASSET_POLICY_INVALID" });
  }
  if (refreshReleaseBoundaries) applyReleasePolicyBoundaries(policy, requiredPolicy);
  policy.repository.displayName = displayName;
  policy.repository.defaultBranch = defaultBranch;
  policy.repository.ownerLogins = [...ownerLogins];
  policy.merge.allowedUserAuthors = [...ownerLogins];
  policy.labels ??= {};
  for (const [name, definition] of Object.entries(requiredPolicy.labels ?? {})) {
    if (!Object.hasOwn(policy.labels, name)) policy.labels[name] = structuredClone(definition);
  }
  if (!policyOverride) {
    policy.audit.repair.enabled = capabilities.repair === true;
    policy.review.autoRepair = capabilities.reviewRepair === true;
    policy.issues.allowAiImplementation = capabilities.issueImplementation === true;
    policy.issues.closeExactDuplicates = capabilities.duplicateClosure === true;
    policy.merge.enabled = capabilities.autoMerge === true;
    policy.ai.tracing.enabled = tracing;
    for (const [mode, selection] of Object.entries(models)) {
      const agent = policy.ai.agents[MODES[mode]?.policyAgent ?? mode];
      if (!agent) throw new InstallerError(`The ${mode} workflow has no model configuration.`, { code: "PLAN_INVALID" });
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
  if (!Array.isArray(policy.audit.repair.protectedPaths) || !policy.audit.repair.protectedPaths.length) {
    throw new InstallerError("Rendered policy has no protected paths.", { code: "UNSAFE_POLICY" });
  }
  if (!policy.audit.repair.validationCommands.includes("git diff --check")) {
    throw new InstallerError("Rendered policy does not require git diff --check.", { code: "UNSAFE_POLICY" });
  }
  return `${JSON.stringify(policy, null, 2)}\n`;
}

function assertLocalPackageWorkflow(source, mode, { allowedUses = [] } = {}) {
  const activeUses = source.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:-\s+)?uses:/.test(line))
    .map((line) => line.replace(/^-\s+/, ""));
  const expected = [`uses: ./.github/workflows/codekeeper-runtime-${mode}.yml`, ...allowedUses];
  if (activeUses.length !== expected.length || expected.some((line) => !activeUses.includes(line))) {
    throw new InstallerError("Rendered workflow does not use the installed package runtime workflow.", { code: "WORKFLOW_RENDER_INVALID" });
  }
}

function renderPackageReceipt(template, packageRelease, label) {
  const receipt = normalizePackageRelease(packageRelease);
  if (count(template, "PACKAGE_VERSION") !== 1 || count(template, "PACKAGE_INTEGRITY") !== 1) {
    throw new InstallerError(`Bundled ${label} workflow has unexpected package placeholders.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  const rendered = template
    .replaceAll("PACKAGE_VERSION", receipt.version)
    .replaceAll("PACKAGE_INTEGRITY", receipt.integrity);
  if (/PACKAGE_(?:VERSION|INTEGRITY|MANIFEST_SHA256)/.test(rendered)) {
    throw new InstallerError(`Rendered ${label} workflow contains unresolved package placeholders.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  return rendered;
}

function replaceAppPermissionInputs(source, permissions, label) {
  const replacements = {
    app_contents_permission: permissions.contents,
    app_issues_permission: permissions.issues,
    app_pull_requests_permission: permissions.pullRequests
  };
  let rendered = source;
  for (const [name, value] of Object.entries(replacements)) {
    const placeholder = `APP_${name.slice(4, -11).toUpperCase()}_PERMISSION`;
    if (!APP_PERMISSION_VALUE_SET.has(value)) {
      throw new InstallerError(`Rendered ${label} workflow has an invalid ${name}.`, { code: "WORKFLOW_RENDER_INVALID" });
    }
    const pattern = new RegExp(`(\\b${name}:\\s*)["']?${placeholder}["']?`);
    if (count(rendered, placeholder) !== 1 || !pattern.test(rendered)) {
      throw new InstallerError(`Bundled ${label} workflow has an unexpected ${name} placeholder.`, { code: "WORKFLOW_RENDER_INVALID" });
    }
    rendered = rendered.replace(pattern, `$1"${value}"`);
  }
  if (/APP_(?:CONTENTS|ISSUES|PULL_REQUESTS)_PERMISSION/.test(rendered)) {
    throw new InstallerError(`Rendered ${label} workflow contains unresolved App permission placeholders.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  return rendered;
}

function replaceAppCredentialProbePermissions(source, permissions) {
  const replacements = {
    VERIFY_APP_CONTENTS_PERMISSION: permissions.contents,
    VERIFY_APP_ISSUES_PERMISSION: permissions.issues,
    VERIFY_APP_PULL_REQUESTS_PERMISSION: permissions.pullRequests
  };
  let rendered = source;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!APP_PERMISSION_VALUE_SET.has(value) || count(rendered, placeholder) !== 1) {
      throw new InstallerError("Bundled assistant workflow has invalid App credential probe permissions.", { code: "WORKFLOW_RENDER_INVALID" });
    }
    rendered = rendered.replace(placeholder, value);
  }
  return rendered;
}

export function renderWorkflow(template, {
  packageRelease,
  mode,
  provider,
  preset,
  policy = null,
  maintenanceScheduled = true
}) {
  if (!MODE_IDS.includes(mode)) throw new InstallerError(`Unknown mode: ${mode}`, { code: "PLAN_INVALID" });
  let rendered = renderPackageReceipt(template, packageRelease, mode)
    .replaceAll("codekeeper:ready", "ready");
  rendered = replaceAppPermissionInputs(rendered, workflowAppPermissions(mode, policy), mode);

  const resolvedProvider = provider ?? (mode === "issues" && preset === "mixed" ? "deepseek" : "openai");
  const desiredSecret = MODEL_PROVIDER_SECRETS[resolvedProvider];
  if (!desiredSecret) throw new InstallerError(`Unsupported model provider: ${resolvedProvider}`, { code: "PLAN_INVALID" });
  const modelSecretPattern = /model_api_key: \$\{\{ secrets\.(?:OPENAI|DEEPSEEK|OPENROUTER)_API_KEY \}\}/;
  if (!modelSecretPattern.test(rendered)) {
    throw new InstallerError(`Bundled ${mode} workflow has no model API key placeholder.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  rendered = rendered.replace(modelSecretPattern, `model_api_key: \${{ secrets.${desiredSecret} }}`);
  if (policy) {
    const automation = policy.automation;
    if (mode === "review") {
      if (typeof automation.automaticPrReview !== "boolean" || typeof automation.reviewFeedbackTriage !== "boolean"
        || count(rendered, "auto_review: true") !== 1 || count(rendered, "feedback_triage: true") !== 1) {
        throw new InstallerError("Review automation settings cannot be rendered safely.", { code: "WORKFLOW_RENDER_INVALID" });
      }
      rendered = rendered
        .replace("auto_review: true", `auto_review: ${automation.automaticPrReview}`)
        .replace("feedback_triage: true", `feedback_triage: ${automation.reviewFeedbackTriage}`);
    } else if (mode === "issues") {
      if (typeof automation.issueTriage !== "boolean" || count(rendered, "auto_triage: true") !== 1) {
        throw new InstallerError("Issue automation settings cannot be rendered safely.", { code: "WORKFLOW_RENDER_INVALID" });
      }
      rendered = rendered.replace("auto_triage: true", `auto_triage: ${automation.issueTriage}`);
    } else if (mode === "maintain") {
      if (typeof automation.maintenanceSchedule !== "string" || !automation.maintenanceSchedule.trim()
        || count(rendered, 'cron: "17 7 * * *"') !== 1) {
        throw new InstallerError("Maintenance automation settings cannot be rendered safely.", { code: "WORKFLOW_RENDER_INVALID" });
      }
      if (maintenanceScheduled !== false) {
        rendered = rendered.replace('cron: "17 7 * * *"', `cron: ${JSON.stringify(automation.maintenanceSchedule)}`);
      }
    }
  }
  if (mode === "maintain" && maintenanceScheduled === false) {
    const scheduleBlock = rendered.match(/^  schedule:\n    - cron: "[^"\n]*"\n/m)?.[0];
    if (!scheduleBlock || count(rendered, scheduleBlock) !== 1 || !/^  workflow_dispatch:/m.test(rendered)) {
      throw new InstallerError("Maintenance workflow must retain manual dispatch when scheduling is disabled.", { code: "WORKFLOW_RENDER_INVALID" });
    }
    rendered = rendered.replace(scheduleBlock, "");
  }
  assertLocalPackageWorkflow(rendered, mode);
  return rendered;
}

export function renderAssistantWorkflow(template, { packageRelease, ownerRequests, modes }) {
  if (!/owner_requests: (?:true|false)/.test(template) || !/installed_modes: [a-z,]+/.test(template)) {
    throw new InstallerError("Bundled assistant workflow has incomplete routing controls.", { code: "WORKFLOW_RENDER_INVALID" });
  }
  const rendered = renderPackageReceipt(template, packageRelease, "assistant")
    .replace(/owner_requests: (?:true|false)/, `owner_requests: ${ownerRequests}`)
    .replace(/installed_modes: [a-z,]+/, `installed_modes: ${modes.join(",")}`);
  const permissions = assistantAppPermissions(modes, {
    automation: { ownerRequests }
  });
  const permissioned = replaceAppCredentialProbePermissions(
    rendered,
    permissions
  );
  const fullyPermissioned = replaceAppPermissionInputs(permissioned, permissions, "assistant");
  assertLocalPackageWorkflow(fullyPermissioned, "assistant", {
    allowedUses: ["uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3"]
  });
  return fullyPermissioned;
}

export function renderUnifiedWorkflow(template, {
  packageRelease,
  ownerRequests,
  automationBotLogin,
  modes,
  policy,
  maintenanceScheduled = true
}) {
  const receipt = normalizePackageRelease(packageRelease);
  const botLoginMatch = String(automationBotLogin ?? "").trim().match(BOT_LOGIN);
  const automationBotMention = ownerRequests && botLoginMatch
    ? `@${botLoginMatch[1].toLowerCase()}`
    : DISABLED_BOT_MENTION;
  if (
    count(template, "PACKAGE_VERSION") !== 5 ||
    count(template, "PACKAGE_INTEGRITY") !== 5 ||
    count(template, "OWNER_REQUESTS_ENABLED") !== 2 ||
    count(template, "AUTOMATION_BOT_MENTION") !== 3 ||
    count(template, "INSTALLED_MODES") !== 5
  ) {
    throw new InstallerError("Bundled unified workflow has incomplete release or routing controls.", { code: "WORKFLOW_RENDER_INVALID" });
  }
  let rendered = template
    .replaceAll("PACKAGE_VERSION", receipt.version)
    .replaceAll("PACKAGE_INTEGRITY", receipt.integrity)
    .replaceAll("OWNER_REQUESTS_ENABLED", String(ownerRequests))
    .replaceAll("AUTOMATION_BOT_MENTION", automationBotMention)
    .replaceAll("INSTALLED_MODES", modes.join(","));
  if (policy) {
    const automation = policy.automation;
    if (
      typeof automation.automaticPrReview !== "boolean" ||
      typeof automation.reviewFeedbackTriage !== "boolean" ||
      typeof automation.issueTriage !== "boolean" ||
      count(rendered, "AUTO_REVIEW_ENABLED") !== 2 ||
      count(rendered, "FEEDBACK_TRIAGE_ENABLED") !== 2 ||
      count(rendered, "AUTO_TRIAGE_ENABLED") !== 2
    ) {
      throw new InstallerError("Unified workflow automation settings cannot be rendered safely.", { code: "WORKFLOW_RENDER_INVALID" });
    }
    rendered = rendered
      .replaceAll("AUTO_REVIEW_ENABLED", String(automation.automaticPrReview))
      .replaceAll("FEEDBACK_TRIAGE_ENABLED", String(automation.reviewFeedbackTriage))
      .replaceAll("AUTO_TRIAGE_ENABLED", String(automation.issueTriage));
    if (
      typeof automation.maintenanceSchedule !== "string" ||
      !automation.maintenanceSchedule.trim() ||
      count(rendered, 'cron: "17 7 * * *"') !== 1
    ) {
      throw new InstallerError("Unified workflow maintenance schedule cannot be rendered safely.", { code: "WORKFLOW_RENDER_INVALID" });
    }
    if (maintenanceScheduled !== false) {
      rendered = rendered.replace('cron: "17 7 * * *"', `cron: ${JSON.stringify(automation.maintenanceSchedule)}`);
    }
  }
  if (maintenanceScheduled === false) {
    const scheduleBlock = rendered.match(/^  schedule:\n    - cron: "[^"\n]*"\n/m)?.[0];
    if (!scheduleBlock || count(rendered, scheduleBlock) !== 1 || !/^  workflow_dispatch:/m.test(rendered)) {
      throw new InstallerError("Unified workflow must retain manual dispatch when scheduling is disabled.", { code: "WORKFLOW_RENDER_INVALID" });
    }
    rendered = rendered.replace(scheduleBlock, "");
  }
  const uses = rendered.match(/^\s+uses: \.\/\.github\/workflows\/codekeeper-runtime\.yml\s*$/gm) ?? [];
  if (uses.length !== 5 || /PACKAGE_(?:VERSION|INTEGRITY)|AUTOMATION_BOT_MENTION/.test(rendered)) {
    throw new InstallerError("Rendered unified workflow does not use the installed generic runtime exactly five times.", { code: "WORKFLOW_RENDER_INVALID" });
  }
  return rendered;
}

export function renderInstallFiles(bundle, {
  modes,
  preset,
  displayName,
  defaultBranch,
  ownerLogins,
  capabilities = {},
  models = {},
  tracing = true,
  maintenanceScheduled = true,
  automationBotLogin = null,
  policySource = bundle.contents[`policies/${preset}.json`],
  profileSources = {},
  enforceBundledDefaults = true,
  policyOverride = null,
  refreshReleaseBoundaries = false
}) {
  const { repository: sourceRepository, commit: sourceCommit } = bundle.metadata.source;
  const packageRelease = normalizePackageRelease(bundle.packageRelease);
  const policyContents = renderPolicy(policySource, {
    displayName,
    defaultBranch,
    ownerLogins,
    capabilities,
    models,
    tracing,
    enforceBundledDefaults,
    requiredPolicySource: bundle.contents[`policies/${preset}.json`],
    policyOverride,
    refreshReleaseBoundaries
  });
  const renderedPolicy = JSON.parse(policyContents);
  const rendered = activeRepositoryArtifacts({ modes, profileSources }).map((artifact) => {
    if (artifact.renderer === "policy") {
      return { path: artifact.target, contents: policyContents, artifact };
    }
    if (artifact.renderer === "profile") {
      return {
        path: artifact.target,
        contents: profileSources[artifact.target],
        artifact
      };
    }
    if (artifact.renderer === "unified-workflow") {
      return {
        path: artifact.target,
        contents: renderUnifiedWorkflow(bundle.contents[artifact.asset], {
          packageRelease,
          ownerRequests: renderedPolicy.automation.ownerRequests,
          automationBotLogin,
          modes,
          policy: renderedPolicy,
          maintenanceScheduled
        }),
        artifact
      };
    }
    if (artifact.renderer === "mode-workflow") {
      const mode = artifact.activation.id;
      return {
        path: artifact.target,
        contents: renderWorkflow(bundle.contents[artifact.asset], {
          packageRelease,
          mode,
          provider: models[mode]?.provider,
          preset,
          policy: renderedPolicy,
          maintenanceScheduled
        }),
        artifact
      };
    }
    if (artifact.renderer === "copy") {
      return {
        path: artifact.target,
        contents: bundle.contents[artifact.asset],
        artifact
      };
    }
    throw new InstallerError(`Unknown repository artifact renderer: ${artifact.renderer}`, { code: "PLAN_INVALID" });
  });
  const managedFiles = Object.fromEntries(rendered
    .filter((file) => file.artifact.ownership === "release")
    .map((file) => [file.path, sha256(file.contents)]));
  rendered.push({
    path: RELEASE_MANIFEST_TARGET,
    contents: `${JSON.stringify({
      version: 2,
      package: packageRelease,
      source: { repository: sourceRepository, commit: sourceCommit },
      managedFiles
    }, null, 2)}\n`
  });
  return rendered.map(({ artifact: _artifact, ...file }) => deepFreeze({
    ...file,
    bytes: Buffer.byteLength(file.contents),
    sha256: sha256(file.contents)
  }));
}
