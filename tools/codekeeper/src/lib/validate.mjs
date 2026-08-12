import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_PROFILE_BUNDLE_FILE, loadFrozenAgentProfile } from "./agent-profiles.mjs";
import { applyPatch, changedFilesBetween, changedLineHunksBetween, collectWorkingTreeChanges, createPatch, currentHead, ensureClean, runValidationCommands } from "./git.mjs";
import { readRegularFile, readRegularJson, writeJson } from "./io.mjs";
import { sha256 } from "./markers.mjs";
import { validatePatch } from "./policy.mjs";
import { frozenPullRepairTarget } from "./pr-repair.mjs";
import { validateAuditResult, validateFixResult, validateIssueResult, validateReviewResult } from "./schemas.mjs";

function assertTrustedContext(context, expectedMode) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new Error("Trusted context is missing or invalid");
  }
  if (context.mode !== expectedMode) {
    throw new Error(`Trusted context mode is ${context.mode || "missing"}; expected ${expectedMode}`);
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository && context.repository !== repository) {
    throw new Error(`Trusted context repository is ${context.repository || "missing"}; expected ${repository}`);
  }
}

function assertFrozenPolicy(context, configSha256) {
  if (!/^[a-f0-9]{64}$/i.test(String(context.configSha256 ?? ""))) {
    throw new Error("Trusted context is missing its frozen policy hash");
  }
  if (context.configSha256 !== configSha256) {
    throw new Error("Policy changed after preparation; refusing to validate");
  }
}

async function createFreshDirectory(directory) {
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Output directory already exists: ${directory}`);
    throw error;
  }
}

function candidateComponents({ contextBytes, resultBytes, patchBytes, validationBytes, agentProfileBytes, runtimeMetadataBytes }) {
  return {
    contextSha256: sha256(contextBytes),
    resultSha256: sha256(resultBytes),
    patchSha256: patchBytes ? sha256(patchBytes) : null,
    validationSha256: sha256(validationBytes),
    agentProfileSha256: sha256(agentProfileBytes),
    runtimeMetadataSha256: sha256(runtimeMetadataBytes)
  };
}

function assertRuntimeMetadata(metadata, mode) {
  if (!metadata || metadata.mode !== mode || !metadata.usage || typeof metadata.usage !== "object") {
    throw new Error("Coordinator runtime metadata is missing or invalid");
  }
  for (const field of ["attempt", "maxTurns", "durationMs", "promptBytes", "evidenceBytes", "outputBytes"]) {
    if (!Number.isFinite(metadata[field]) || metadata[field] < 0) {
      throw new Error(`Coordinator runtime metadata has an invalid ${field}`);
    }
  }
  for (const field of ["requests", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens"]) {
    if (!Number.isFinite(metadata.usage[field]) || metadata.usage[field] < 0) {
      throw new Error(`Coordinator runtime metadata has invalid usage.${field}`);
    }
  }
  return metadata;
}

async function readRuntimeMetadata(directory, mode) {
  const filePath = path.join(directory, "runtime-metadata.json");
  const bytes = await readRegularFile(filePath);
  assertRuntimeMetadata(await readRegularJson(filePath), mode);
  return bytes;
}

async function writeCandidate({ artifactDirectory, context, result, patch = null, patchBytes = null, validation = null, agentProfileBytes, runtimeMetadataBytes }) {
  await createFreshDirectory(artifactDirectory);
  await writeFile(path.join(artifactDirectory, AGENT_PROFILE_BUNDLE_FILE), agentProfileBytes);
  await writeJson(path.join(artifactDirectory, "context.json"), context);
  await writeJson(path.join(artifactDirectory, "result.json"), result);
  await writeJson(path.join(artifactDirectory, "validation.json"), validation);
  await writeFile(path.join(artifactDirectory, "runtime-metadata.json"), runtimeMetadataBytes);
  if (patchBytes) await writeFile(path.join(artifactDirectory, "patch.diff"), patchBytes);

  const contextBytes = await readRegularFile(path.join(artifactDirectory, "context.json"));
  const resultBytes = await readRegularFile(path.join(artifactDirectory, "result.json"));
  const validationBytes = await readRegularFile(path.join(artifactDirectory, "validation.json"));
  const components = candidateComponents({ contextBytes, resultBytes, patchBytes, validationBytes, agentProfileBytes, runtimeMetadataBytes });
  const candidate = {
    version: 2,
    mode: context.mode,
    repository: context.repository,
    patch,
    validation,
    ...components
  };
  await writeJson(path.join(artifactDirectory, "candidate.json"), candidate);
  return {
    candidate,
    candidateSha256: sha256(await readRegularFile(path.join(artifactDirectory, "candidate.json")))
  };
}

async function writeArtifact({ artifactDirectory, context, result, patch = null, patchBytes = null, validation = null, config, configSha256, agentProfileBytes, runtimeMetadataBytes }) {
  await createFreshDirectory(artifactDirectory);
  await writeFile(path.join(artifactDirectory, AGENT_PROFILE_BUNDLE_FILE), agentProfileBytes);
  await writeJson(path.join(artifactDirectory, "context.json"), context);
  await writeJson(path.join(artifactDirectory, "result.json"), result);
  await writeJson(path.join(artifactDirectory, "config.json"), config);
  await writeJson(path.join(artifactDirectory, "validation.json"), validation);
  await writeFile(path.join(artifactDirectory, "runtime-metadata.json"), runtimeMetadataBytes);
  if (patchBytes) await writeFile(path.join(artifactDirectory, "patch.diff"), patchBytes);

  const contextBytes = await readRegularFile(path.join(artifactDirectory, "context.json"));
  const resultBytes = await readRegularFile(path.join(artifactDirectory, "result.json"));
  const configBytes = await readRegularFile(path.join(artifactDirectory, "config.json"));
  const validationBytes = await readRegularFile(path.join(artifactDirectory, "validation.json"));
  const sealedPatchBytes = patchBytes ? await readRegularFile(path.join(artifactDirectory, "patch.diff")) : null;
  const manifest = {
    version: 3,
    sealed: true,
    mode: context.mode,
    repository: context.repository,
    createdAt: new Date().toISOString(),
    context,
    patch,
    validation,
    configSha256,
    configFileSha256: sha256(configBytes),
    ...candidateComponents({ contextBytes, resultBytes, patchBytes: sealedPatchBytes, validationBytes, agentProfileBytes, runtimeMetadataBytes })
  };
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  await writeJson(manifestPath, manifest);
  return { manifest, manifestSha256: sha256(await readRegularFile(manifestPath)) };
}

function inactiveReviewSource(source) {
  return source?.resolved === true || source?.outdated === true ||
    (source?.kind === "review" && String(source.state ?? "").trim().toLowerCase() === "dismissed");
}

export function validateFrozenReviewFeedback(sourceFeedback, resultFeedback) {
  const expectedSources = new Set(sourceFeedback.map((item) => item.sourceKey));
  const actualSources = new Set(resultFeedback.flatMap((item) => item.sourceKeys));
  if (expectedSources.size !== actualSources.size || [...expectedSources].some((source) => !actualSources.has(source))) {
    throw new Error("Review feedback classifications must cover the complete frozen review surface exactly once");
  }
  const sourcesByKey = new Map(sourceFeedback.map((item) => [item.sourceKey, item]));
  for (const feedback of resultFeedback) {
    const sources = feedback.sourceKeys.map((key) => sourcesByKey.get(key));
    const inactiveSources = sources.filter(inactiveReviewSource);
    if (inactiveSources.length > 0 && inactiveSources.length !== sources.length) {
      throw new Error(`Review feedback ${feedback.problemKey} mixes active and inactive frozen sources`);
    }
    if (inactiveSources.length > 0 && feedback.disposition !== "ignore") {
      throw new Error(`Review feedback ${feedback.problemKey} must ignore resolved, outdated, or dismissed frozen sources`);
    }
    const expectedThreadIds = [...new Set(sources.map((source) => source?.threadId).filter(Boolean))].sort();
    if (JSON.stringify([...feedback.threadIds].sort()) !== JSON.stringify(expectedThreadIds)) {
      throw new Error(`Review feedback ${feedback.problemKey} has thread IDs outside its frozen sources`);
    }
  }
}

function reviewResult(context, result) {
  const findings = [...result.blockingFindings, ...result.nonBlockingFindings];
  const changedFiles = new Set(changedFilesBetween(context.pullRequest.baseSha, context.pullRequest.headSha));
  const citedPaths = [...new Set(findings.map((finding) => finding.file).filter((file) => file !== null))];
  const changedHunks = changedLineHunksBetween(context.pullRequest.baseSha, context.pullRequest.headSha, citedPaths);
  for (const finding of findings) {
    if (finding.file === null) {
      if (finding.line !== null) throw new Error("Review finding line requires a file");
      continue;
    }
    if (!changedFiles.has(finding.file)) {
      throw new Error(`Review finding points outside the PR diff: ${finding.file}`);
    }
    if (finding.line !== null) {
      const ranges = changedHunks.get(finding.file) ?? [];
      if (!ranges.some(({ start, end }) => finding.line >= start && finding.line <= end)) {
        throw new Error(`Review finding line is outside the changed hunk: ${finding.file}:${finding.line}`);
      }
    }
  }
  const sourceFeedback = context.pullRequest.reviewFeedback ?? [];
  validateFrozenReviewFeedback(sourceFeedback, result.reviewFeedback);
  return result;
}

export async function validateReview({ directory, contextPath = path.join(directory, "context.json"), resultPath, artifactDirectory, config, configSha256 }) {
  const context = await readRegularJson(contextPath);
  assertTrustedContext(context, "review");
  assertFrozenPolicy(context, configSha256);
  const result = reviewResult(context, validateReviewResult(await readRegularJson(resultPath), config));
  if (currentHead() !== context.pullRequest.headSha) {
    throw new Error("Checkout head changed after review context was prepared");
  }
  const changes = await collectWorkingTreeChanges();
  if (changes.files.length > 0) {
    throw new Error(`Review mode modified the checkout: ${changes.files.map((file) => file.path).join(", ")}`);
  }
  const agentProfile = await loadFrozenAgentProfile({ mode: "review", directory, context });
  const runtimeMetadataBytes = await readRuntimeMetadata(directory, "review");
  return writeCandidate({ artifactDirectory, context, result, patch: null, validation: { checks: ["head", "diff-hunks", "clean-worktree"] }, agentProfileBytes: agentProfile.bytes, runtimeMetadataBytes });
}

export async function validateIssue({ directory, contextPath = path.join(directory, "context.json"), resultPath, artifactDirectory, config, configSha256 }) {
  const context = await readRegularJson(contextPath);
  assertTrustedContext(context, "issue");
  assertFrozenPolicy(context, configSha256);
  const result = validateIssueResult(await readRegularJson(resultPath), config);
  if (result.duplicateOf !== null) {
    if (result.duplicateOf === context.issue?.number) {
      throw new Error(`Issue #${context.issue.number} cannot be its own duplicate`);
    }
    const trustedCandidates = new Set(
      (context.duplicateCandidates ?? [])
        .filter((candidate) => candidate?.kind === "issue")
        .map((candidate) => candidate?.number)
        .filter((number) => Number.isSafeInteger(number) && number > 0)
    );
    if (!trustedCandidates.has(result.duplicateOf)) {
      throw new Error(`Duplicate target #${result.duplicateOf} was not present in the trusted issue shortlist`);
    }
  }
  const changes = await collectWorkingTreeChanges();
  if (changes.files.length > 0) {
    throw new Error(`Issue triage modified the checkout: ${changes.files.map((file) => file.path).join(", ")}`);
  }
  const agentProfile = await loadFrozenAgentProfile({ mode: "issue", directory, context });
  const runtimeMetadataBytes = await readRuntimeMetadata(directory, "issue");
  return writeCandidate({ artifactDirectory, context, result, patch: null, validation: { checks: ["duplicate-target", "clean-worktree"] }, agentProfileBytes: agentProfile.bytes, runtimeMetadataBytes });
}

async function capturePatch(cwd = process.cwd()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-validation-"));
  const patchPath = path.join(directory, "patch.diff");
  try {
    const changes = await createPatch(patchPath, cwd);
    return { changes, bytes: await readFile(patchPath) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function captureWorkspacePatch({ context, config, repairRequested, risk }) {
  const reasons = [];
  if (currentHead() !== context.baseSha) {
    reasons.push(`Checkout HEAD changed from ${context.baseSha} to ${currentHead()}`);
  }

  const initial = await capturePatch();
  const changes = initial.changes;
  const policy = validatePatch(changes, config);
  reasons.push(...policy.reasons);
  if (repairRequested && changes.files.length === 0) reasons.push("Result requested a repair but the worktree is unchanged");
  if (!repairRequested && changes.files.length > 0) reasons.push("Codex changed files without declaring a repair");

  const valid = reasons.length === 0 && changes.files.length > 0 && repairRequested;
  const patch = {
    present: changes.files.length > 0,
    valid,
    reasons,
    risk,
    files: policy.files,
    additions: policy.additions,
    deletions: policy.deletions,
    changedLines: policy.changedLines,
    changedBytes: policy.changedBytes ?? changes.changedBytes,
    patchBytes: changes.patchBytes,
    sha256: valid ? sha256(initial.bytes) : null,
    fileName: valid ? "patch.diff" : null
  };
  return { patch, patchBytes: valid ? initial.bytes : null };
}

export async function validateAudit({ directory, contextPath = path.join(directory, "context.json"), resultPath, artifactDirectory, config, configSha256 }) {
  const context = await readRegularJson(contextPath);
  assertTrustedContext(context, "audit");
  assertFrozenPolicy(context, configSha256);
  const result = validateAuditResult(await readRegularJson(resultPath), config);
  if (typeof context.repairAuthorized !== "boolean") {
    throw new Error("Trusted audit context is missing explicit repair authorization");
  }
  const repairPermitted = config.audit.repair.enabled && context.repairAuthorized;
  if (!repairPermitted && result.repair.requested) {
    throw new Error("Audit requested a repair without frozen explicit repair authorization");
  }
  if (!repairPermitted) {
    const changes = await collectWorkingTreeChanges();
    if (changes.files.length > 0) {
      throw new Error("Audit changed files without frozen explicit repair authorization");
    }
  }
  const { patch, patchBytes } = await captureWorkspacePatch({
    context,
    config,
    repairRequested: result.repair.requested,
    risk: result.repair.risk
  });
  const agentProfile = await loadFrozenAgentProfile({ mode: "audit", directory, context });
  const runtimeMetadataBytes = await readRuntimeMetadata(directory, "audit");
  return writeCandidate({ artifactDirectory, context, result, patch, patchBytes, validation: { checks: ["head", "patch-policy"] }, agentProfileBytes: agentProfile.bytes, runtimeMetadataBytes });
}

export async function validateFix({ directory, contextPath = path.join(directory, "context.json"), resultPath, artifactDirectory, config, configSha256, targetNumber }) {
  const context = await readRegularJson(contextPath);
  assertTrustedContext(context, "fix");
  assertFrozenPolicy(context, configSha256);
  if (!context.target || !["issue", "pull_request"].includes(context.target.kind)) {
    throw new Error("Trusted fix context is missing a valid target kind");
  }
  if (context.target.number !== targetNumber) {
    throw new Error(`Trusted fix context targets #${context.target.number ?? "missing"}; expected #${targetNumber}`);
  }
  if (context.target.kind === "issue") {
    if (context.issue?.number !== context.target.number) {
      throw new Error("Trusted issue fix context does not match its frozen target");
    }
  } else {
    frozenPullRepairTarget(context, config);
  }
  const result = validateFixResult(await readRegularJson(resultPath), context.target);
  const changes = await collectWorkingTreeChanges();
  const repairRequested = changes.files.length > 0;
  if (!repairRequested && !result.noChangeReason) {
    throw new Error("Fix mode made no changes without explaining noChangeReason");
  }
  if (repairRequested && result.noChangeReason !== null) {
    throw new Error("Fix mode changed files while also declaring noChangeReason");
  }
  if (repairRequested && !result.changedSummary.trim()) {
    throw new Error("Fix mode changed files without a changedSummary");
  }
  if (!repairRequested && result.changedSummary.trim()) {
    throw new Error("Fix mode reported changedSummary even though the worktree is unchanged");
  }
  const { patch, patchBytes } = await captureWorkspacePatch({
    context,
    config,
    repairRequested,
    risk: result.risk
  });
  const agentProfile = await loadFrozenAgentProfile({ mode: "fix", directory, context });
  const runtimeMetadataBytes = await readRuntimeMetadata(directory, "fix");
  return writeCandidate({ artifactDirectory, context, result, patch, patchBytes, validation: { checks: ["head", "patch-policy"] }, agentProfileBytes: agentProfile.bytes, runtimeMetadataBytes });
}

function validateResultForMode(mode, result, context, config) {
  if (mode === "review") return validateReviewResult(result, config);
  if (mode === "audit") return validateAuditResult(result, config);
  if (mode === "issue") return validateIssueResult(result, config);
  if (mode === "fix") return validateFixResult(result, context.target);
  throw new Error(`Unsupported candidate mode: ${mode}`);
}

async function readCandidate({ mode, candidateDirectory, expectedCandidateSha256, config, configSha256 }) {
  if (!/^[a-f0-9]{64}$/i.test(expectedCandidateSha256)) throw new Error("--expected-candidate-sha must be a SHA-256 digest");
  const candidatePath = path.join(candidateDirectory, "candidate.json");
  const candidateBytes = await readRegularFile(candidatePath);
  if (sha256(candidateBytes) !== expectedCandidateSha256) {
    throw new Error("Candidate artifact changed after validation");
  }
  const candidate = await readRegularJson(candidatePath);
  if (candidate.version !== 2 || candidate.mode !== mode) throw new Error("Candidate metadata is invalid");

  const contextPath = path.join(candidateDirectory, "context.json");
  const resultPath = path.join(candidateDirectory, "result.json");
  const validationPath = path.join(candidateDirectory, "validation.json");
  const contextBytes = await readRegularFile(contextPath);
  const resultBytes = await readRegularFile(resultPath);
  const validationBytes = await readRegularFile(validationPath);
  const agentProfileBytes = await readRegularFile(path.join(candidateDirectory, AGENT_PROFILE_BUNDLE_FILE));
  const runtimeMetadataPath = path.join(candidateDirectory, "runtime-metadata.json");
  const runtimeMetadataBytes = await readRegularFile(runtimeMetadataPath);
  assertRuntimeMetadata(await readRegularJson(runtimeMetadataPath), mode);
  const context = await readRegularJson(contextPath);
  const result = await readRegularJson(resultPath);
  const validation = await readRegularJson(validationPath);
  if (sha256(contextBytes) !== candidate.contextSha256) {
    throw new Error("Candidate context is not the frozen trusted context");
  }
  if (sha256(resultBytes) !== candidate.resultSha256 || sha256(validationBytes) !== candidate.validationSha256) {
    throw new Error("Candidate content hash does not match metadata");
  }
  if (sha256(agentProfileBytes) !== candidate.agentProfileSha256 || sha256(agentProfileBytes) !== context.agentProfile?.sha256) {
    throw new Error("Candidate agent profile is not the frozen trusted profile");
  }
  if (sha256(runtimeMetadataBytes) !== candidate.runtimeMetadataSha256) {
    throw new Error("Candidate runtime metadata hash does not match metadata");
  }
  assertTrustedContext(context, mode);
  if (candidate.repository !== context.repository) throw new Error("Candidate repository does not match its context");
  assertFrozenPolicy(context, configSha256);
  validateResultForMode(mode, result, context, config);

  let patchBytes = null;
  if (candidate.patch?.valid) {
    if (candidate.patch.fileName !== "patch.diff" || !candidate.patch.sha256) {
      throw new Error("Candidate patch metadata is invalid");
    }
    patchBytes = await readRegularFile(path.join(candidateDirectory, "patch.diff"));
    if (sha256(patchBytes) !== candidate.patch.sha256 || sha256(patchBytes) !== candidate.patchSha256) {
      throw new Error("Candidate patch hash does not match metadata");
    }
  } else if (candidate.patchSha256 !== null) {
    throw new Error("Candidate contains an unexpected patch hash");
  }
  return { candidate, context, result, validation, patchBytes, agentProfileBytes, runtimeMetadataBytes };
}

async function verifyPatchCandidate({ mode, candidateDirectory, expectedCandidateSha256, config, configSha256 }) {
  const { candidate, context, patchBytes } = await readCandidate({
    mode,
    candidateDirectory,
    expectedCandidateSha256,
    config,
    configSha256
  });
  // No-repair audits and intentionally unchanged fixes still need sealing so
  // their issue/comment outcome can publish. An invalid *present* patch is
  // never allowed through this path.
  if (!candidate.patch?.present) {
    return { verified: true, skipped: true, mode, candidateSha256: expectedCandidateSha256 };
  }
  if (!candidate.patch.valid || !patchBytes) throw new Error("Candidate has no valid patch to verify");
  if (currentHead() !== context.baseSha) {
    throw new Error(`Verification checkout moved from ${context.baseSha} to ${currentHead()}`);
  }
  ensureClean();
  applyPatch(path.join(candidateDirectory, "patch.diff"));
  const initial = await capturePatch();
  if (sha256(initial.bytes) !== candidate.patch.sha256) {
    throw new Error("Fresh verification checkout produced a different patch");
  }
  const policy = validatePatch(initial.changes, config);
  if (!policy.valid) throw new Error(`Fresh verification patch failed policy: ${policy.reasons.join("; ")}`);
  runValidationCommands(config.audit.repair.validationCommands);
  if (currentHead() !== context.baseSha) {
    throw new Error(`Validation commands changed checkout HEAD from ${context.baseSha} to ${currentHead()}`);
  }
  const afterValidation = await capturePatch();
  if (sha256(initial.bytes) !== sha256(afterValidation.bytes)) {
    throw new Error("Validation commands modified the proposed patch");
  }
  return { verified: true, mode, candidateSha256: expectedCandidateSha256 };
}

async function seal({ mode, candidateDirectory, artifactDirectory, expectedCandidateSha256, expectedContextSha256, config, configSha256 }) {
  if (!/^[a-f0-9]{64}$/i.test(expectedContextSha256)) throw new Error("--expected-context-sha must be a SHA-256 digest");
  const { candidate, context, result, validation, patchBytes, agentProfileBytes, runtimeMetadataBytes } = await readCandidate({
    mode,
    candidateDirectory,
    expectedCandidateSha256,
    config,
    configSha256
  });
  const contextBytes = await readRegularFile(path.join(candidateDirectory, "context.json"));
  if (sha256(contextBytes) !== expectedContextSha256 || sha256(contextBytes) !== candidate.contextSha256) {
    throw new Error("Candidate context is not the frozen trusted context");
  }
  return writeArtifact({
    artifactDirectory,
    context,
    result,
    patch: candidate.patch ?? null,
    patchBytes,
    validation,
    config,
    configSha256,
    agentProfileBytes,
    runtimeMetadataBytes
  });
}

export function sealReview(options) {
  return seal({ mode: "review", ...options });
}

export function sealAudit(options) {
  return seal({ mode: "audit", ...options });
}

export function sealIssue(options) {
  return seal({ mode: "issue", ...options });
}

export function sealFix(options) {
  return seal({ mode: "fix", ...options });
}

export function verifyAudit(options) {
  return verifyPatchCandidate({ mode: "audit", ...options });
}

export function verifyFix(options) {
  return verifyPatchCandidate({ mode: "fix", ...options });
}
