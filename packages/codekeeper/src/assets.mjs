import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  ASSET_KEYS,
  MODE_IDS,
  MODEL_PROVIDER_SECRETS,
  MODES,
  POLICY_TARGET,
  SOURCE_COMMIT,
  SOURCE_REPOSITORY
} from "./constants.mjs";
import { InstallerError } from "./errors.mjs";
import { upgradePolicy } from "./policy.mjs";

const DEFAULT_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

export async function loadVerifiedAssets({
  packageRoot = DEFAULT_PACKAGE_ROOT,
  fsImpl = { readFile, lstat }
} = {}) {
  const assetsRoot = path.join(packageRoot, "assets");
  const metadataBytes = await readRegularFile(fsImpl, path.join(assetsRoot, "metadata.json"), "Asset metadata");
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
  if (metadata.source.repository !== SOURCE_REPOSITORY || metadata.source.commit !== SOURCE_COMMIT) {
    throw new InstallerError("Asset metadata does not match this installer's pinned source release.", { code: "ASSET_METADATA_INVALID" });
  }
  exactKeys(Object.keys(metadata.assets), ASSET_KEYS, "Asset");

  const contents = {};
  for (const assetKey of ASSET_KEYS) {
    const record = metadata.assets[assetKey];
    if (!record || !SHA256.test(record.sha256 ?? "") || !Number.isSafeInteger(record.bytes) || record.bytes < 1) {
      throw new InstallerError(`Asset metadata is invalid for ${assetKey}.`, { code: "ASSET_METADATA_INVALID" });
    }
    const bytes = await readRegularFile(fsImpl, path.join(assetsRoot, ...assetKey.split("/")), `Asset ${assetKey}`);
    if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
      throw new InstallerError(`Bundled asset verification failed for ${assetKey}.`, { code: "ASSET_DIGEST_MISMATCH" });
    }
    contents[assetKey] = bytes.toString("utf8");
  }

  return deepFreeze({ metadata, contents });
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
  requiredPolicySource = policySource
}) {
  let policy;
  try {
    policy = upgradePolicy(JSON.parse(policySource));
  } catch (cause) {
    throw new InstallerError("Bundled policy is invalid or unsupported.", { code: "ASSET_POLICY_INVALID", cause });
  }
  if (enforceBundledDefaults) assertDisabledPolicy(policy);
  let requiredPolicy;
  try {
    requiredPolicy = upgradePolicy(JSON.parse(requiredPolicySource));
  } catch (cause) {
    throw new InstallerError("Bundled policy is invalid or unsupported.", { code: "ASSET_POLICY_INVALID", cause });
  }
  if (!policy.repository || !policy.merge || !Array.isArray(policy.merge.allowedUserAuthors)) {
    throw new InstallerError("Bundled policy cannot be tailored safely.", { code: "ASSET_POLICY_INVALID" });
  }
  policy.repository.displayName = displayName;
  policy.repository.defaultBranch = defaultBranch;
  policy.repository.ownerLogins = [...ownerLogins];
  policy.merge.allowedUserAuthors = [...ownerLogins];
  policy.labels ??= {};
  for (const [name, definition] of Object.entries(requiredPolicy.labels ?? {})) {
    if (!Object.hasOwn(policy.labels, name)) policy.labels[name] = structuredClone(definition);
  }
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
    agent.modelSettings = selection.provider === "openai"
      ? { text: { verbosity: "low" } }
      : selection.provider === "deepseek"
        ? { temperature: 0.2, providerData: { thinking: { type: "disabled" }, response_format: { type: "json_object" } } }
        : {};
  }
  if (!Array.isArray(policy.audit.repair.protectedPaths) || !policy.audit.repair.protectedPaths.length) {
    throw new InstallerError("Rendered policy has no protected paths.", { code: "UNSAFE_POLICY" });
  }
  if (!policy.audit.repair.validationCommands.includes("git diff --check")) {
    throw new InstallerError("Rendered policy does not require git diff --check.", { code: "UNSAFE_POLICY" });
  }
  return `${JSON.stringify(policy, null, 2)}\n`;
}

function assertPinnedWorkflow(source, sourceRepository, sourceCommit) {
  const activeUses = source.split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:-\s+)?uses:/.test(line))
    .map((line) => line.replace(/^-\s+/, ""));
  if (activeUses.length !== 2 || activeUses.some((line) => !line.endsWith(`@${sourceCommit}`))) {
    throw new InstallerError("Rendered workflow does not contain exactly two immutable source pins.", { code: "WORKFLOW_RENDER_INVALID" });
  }
  if (!activeUses.some((line) => line === `uses: ${sourceRepository}/tools/codekeeper@${sourceCommit}`)) {
    throw new InstallerError("Rendered workflow is missing the pinned bootstrap action.", { code: "WORKFLOW_RENDER_INVALID" });
  }
  if (!activeUses.some((line) => line.startsWith(`uses: ${sourceRepository}/.github/workflows/codekeeper-`))) {
    throw new InstallerError("Rendered workflow is missing the pinned reusable workflow.", { code: "WORKFLOW_RENDER_INVALID" });
  }
}

export function renderWorkflow(template, { sourceRepository, sourceCommit, mode, provider, preset }) {
  if (!MODE_IDS.includes(mode)) throw new InstallerError(`Unknown mode: ${mode}`, { code: "PLAN_INVALID" });
  if (count(template, "OWNER/REPOSITORY") !== 3 || count(template, "FULL_COMMIT_SHA") !== 3) {
    throw new InstallerError(`Bundled ${mode} workflow has unexpected placeholders.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  const manualHeader = `# Copy to .github/workflows/codekeeper-${mode}.yml, then replace OWNER/REPOSITORY\n# and FULL_COMMIT_SHA with the published maintainer repository and release commit.`;
  if (count(template, manualHeader) !== 1) {
    throw new InstallerError(`Bundled ${mode} workflow has an unexpected installation header.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  let rendered = template
    .replace(manualHeader, `# Generated by codekeeper from ${sourceRepository}@${sourceCommit}.`)
    .replaceAll("OWNER/REPOSITORY", sourceRepository)
    .replaceAll("FULL_COMMIT_SHA", sourceCommit);

  const resolvedProvider = provider ?? (mode === "issues" && preset === "mixed" ? "deepseek" : "openai");
  const desiredSecret = MODEL_PROVIDER_SECRETS[resolvedProvider];
  if (!desiredSecret) throw new InstallerError(`Unsupported model provider: ${resolvedProvider}`, { code: "PLAN_INVALID" });
  const modelSecretPattern = /model_api_key: \$\{\{ secrets\.(?:OPENAI|DEEPSEEK|OPENROUTER)_API_KEY \}\}/;
  if (!modelSecretPattern.test(rendered)) {
    throw new InstallerError(`Bundled ${mode} workflow has no model API key placeholder.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  rendered = rendered.replace(modelSecretPattern, `model_api_key: \${{ secrets.${desiredSecret} }}`);
  if (rendered.includes("OWNER/REPOSITORY") || rendered.includes("FULL_COMMIT_SHA")) {
    throw new InstallerError(`Rendered ${mode} workflow contains unresolved placeholders.`, { code: "WORKFLOW_RENDER_INVALID" });
  }
  assertPinnedWorkflow(rendered, sourceRepository, sourceCommit);
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
  policySource = bundle.contents[`policies/${preset}.json`],
  profileSources = bundle.contents,
  enforceBundledDefaults = true
}) {
  const { repository: sourceRepository, commit: sourceCommit } = bundle.metadata.source;
  const rendered = [{
    path: POLICY_TARGET,
    contents: renderPolicy(policySource, {
      displayName,
      defaultBranch,
      ownerLogins,
      capabilities,
      models,
      tracing,
      enforceBundledDefaults,
      requiredPolicySource: bundle.contents[`policies/${preset}.json`]
    })
  }];
  for (const profile of AGENT_PROFILE_IDS) {
    rendered.push({
      path: AGENT_PROFILES[profile].target,
      contents: profileSources[AGENT_PROFILES[profile].target] ?? profileSources[AGENT_PROFILES[profile].asset]
    });
  }
  for (const mode of modes) {
    rendered.push({
      path: MODES[mode].target,
      contents: renderWorkflow(bundle.contents[MODES[mode].asset], {
        sourceRepository,
        sourceCommit,
        mode,
        provider: models[mode]?.provider,
        preset
      })
    });
  }
  return rendered.map((file) => deepFreeze({
    ...file,
    bytes: Buffer.byteLength(file.contents),
    sha256: sha256(file.contents)
  }));
}
