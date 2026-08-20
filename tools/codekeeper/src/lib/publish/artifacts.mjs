import path from "node:path";
import { AGENT_PROFILE_BUNDLE_FILE, loadTrustedAgentProfile } from "../agent-profiles.mjs";
import { assertCandidateValidationReceipt } from "../git.mjs";
import { readRegularFile } from "../io.mjs";
import { sha256 } from "../markers.mjs";
import { validateAuditResult, validateFixResult, validateIssueResult, validateReviewResult } from "../schemas.mjs";
import { assertNoPublicSecurityFindings } from "../security-containment.mjs";

function parseArtifactJson(bytes, name) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in sealed artifact ${name}: ${error.message}`);
  }
}

function validateArtifactResult(mode, result, context, config) {
  if (mode === "review") return validateReviewResult(result, config);
  if (mode === "audit") {
    return assertNoPublicSecurityFindings(validateAuditResult(result, config));
  }
  if (mode === "issue") return validateIssueResult(result, config);
  if (mode === "fix") return validateFixResult(result, context.target);
  throw new Error(`Unsupported artifact mode: ${mode}`);
}

export async function loadArtifact(
  artifactDirectory,
  expectedMode,
  config,
  configSha256,
  expectedManifestSha256,
  agentProfilePath,
  agentProfileSource,
  agentProfileSourceSha
) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedManifestSha256 ?? ""))) {
    throw new Error("Publisher requires the trusted sealed manifest SHA-256");
  }
  const manifestBytes = await readRegularFile(path.join(artifactDirectory, "manifest.json"));
  if (sha256(manifestBytes) !== expectedManifestSha256) {
    throw new Error("Sealed artifact manifest changed after sealing");
  }
  const manifest = parseArtifactJson(manifestBytes, "manifest.json");
  if (manifest.version !== 3) throw new Error("Unsupported artifact manifest version");
  if (manifest.sealed !== true) throw new Error("Only sealed artifacts may be published");
  if (!/^[a-f0-9]{64}$/i.test(String(configSha256 ?? ""))) {
    throw new Error("Publisher requires the SHA-256 of its frozen configuration");
  }

  const [contextBytes, resultBytes, configBytes, validationBytes, agentProfileBytes, runtimeMetadataBytes] = await Promise.all([
    readRegularFile(path.join(artifactDirectory, "context.json")),
    readRegularFile(path.join(artifactDirectory, "result.json")),
    readRegularFile(path.join(artifactDirectory, "config.json")),
    readRegularFile(path.join(artifactDirectory, "validation.json")),
    readRegularFile(path.join(artifactDirectory, AGENT_PROFILE_BUNDLE_FILE)),
    readRegularFile(path.join(artifactDirectory, "runtime-metadata.json"))
  ]);
  if (
    sha256(contextBytes) !== manifest.contextSha256 ||
    sha256(resultBytes) !== manifest.resultSha256 ||
    sha256(configBytes) !== manifest.configFileSha256 ||
    sha256(validationBytes) !== manifest.validationSha256 ||
    sha256(agentProfileBytes) !== manifest.agentProfileSha256 ||
    sha256(runtimeMetadataBytes) !== manifest.runtimeMetadataSha256
  ) {
    throw new Error("Sealed artifact component changed after sealing");
  }

  const context = parseArtifactJson(contextBytes, "context.json");
  const result = parseArtifactJson(resultBytes, "result.json");
  const artifactConfig = parseArtifactJson(configBytes, "config.json");
  const validation = parseArtifactJson(validationBytes, "validation.json");
  if (manifest.configSha256 !== configSha256 || context.configSha256 !== configSha256) {
    throw new Error("Artifact configuration does not match the publisher's frozen configuration");
  }
  if (JSON.stringify(artifactConfig) !== JSON.stringify(config)) {
    throw new Error("Sealed artifact configuration differs from the trusted publisher configuration");
  }
  if (manifest.mode !== expectedMode || context.mode !== expectedMode || result.mode !== expectedMode) {
    throw new Error(`Artifact mode mismatch; expected ${expectedMode}`);
  }
  if (manifest.repository !== context.repository) throw new Error("Artifact repository fields do not match");
  if (JSON.stringify(manifest.context) !== JSON.stringify(context)) {
    throw new Error("Artifact context does not match its trusted manifest");
  }
  if (JSON.stringify(manifest.validation) !== JSON.stringify(validation)) {
    throw new Error("Artifact validation does not match its trusted manifest");
  }
  if (sha256(agentProfileBytes) !== context.agentProfile?.sha256) {
    throw new Error("Sealed artifact agent profile does not match its frozen context");
  }
  const liveProfile = await loadTrustedAgentProfile({
    mode: expectedMode,
    source: agentProfileSource,
    sourcePath: agentProfilePath,
    sourceSha: agentProfileSourceSha ?? context.agentProfile?.sourceSha
  });
  const frozenSource = context.agentProfile?.source ?? "repository";
  if (
    liveProfile.metadata.source !== frozenSource ||
    liveProfile.metadata.path !== context.agentProfile?.path ||
    liveProfile.metadata.sourceSha !== context.agentProfile?.sourceSha ||
    liveProfile.metadata.sha256 !== context.agentProfile?.sha256
  ) {
    throw new Error("Agent profile changed after preparation; stale action will not publish");
  }
  if (manifest.patch?.valid) {
    const patchBytes = await readRegularFile(path.join(artifactDirectory, "patch.diff"));
    if (sha256(patchBytes) !== manifest.patchSha256 || sha256(patchBytes) !== manifest.patch.sha256) {
      throw new Error("Sealed artifact patch changed after sealing");
    }
    assertCandidateValidationReceipt(validation?.receipt, {
      candidateSha256: manifest.candidateSha256,
      configSha256,
      patchSha256: manifest.patch.sha256,
      baseSha: context.baseSha,
      config,
    });
  } else if (manifest.patchSha256 !== null) {
    throw new Error("Sealed artifact contains an unexpected patch hash");
  }
  validateArtifactResult(expectedMode, result, context, config);
  if (process.env.GITHUB_REPOSITORY && context.repository !== process.env.GITHUB_REPOSITORY) {
    throw new Error(`Artifact targets ${context.repository}; workflow repository is ${process.env.GITHUB_REPOSITORY}`);
  }
  return { manifest, context, result };
}
