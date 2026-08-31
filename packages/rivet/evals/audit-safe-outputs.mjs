#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/iu;
const DIGEST = /^[0-9a-f]{64}$/iu;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const OUTPUT_TYPES = new Set(["validate_audit", "report_incomplete"]);
const CREDENTIAL_KEY =
  /\b(?:credential\w*|secret\w*|token\w*|api[ _-]?key\w*|private[ _-]?key\w*)\b/iu;
const CREDENTIAL_VALUE =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[ _-]?key\w*|access[ _-]?token\w*|client[ _-]?secret\w*|password\w*|passwd\w*|private[ _-]?key\w*|credential\w*)\b|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/iu;
const SECURITY_CONTENT =
  /\b(?:secur\w*|vulnerab\w*|credential\w*|secret\w*|private[ _-]?key\w*|exploit\w*|cve-\d{4}-\d+)\b/iu;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 20;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys, name) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${name} has unsupported or missing fields`,
  );
}

function validateManifest(manifest) {
  invariant(manifest?.version === 1, "manifest.version must equal 1");
  invariant(
    Number.isSafeInteger(manifest.repeat) && manifest.repeat > 0,
    "manifest.repeat must be a positive integer",
  );
  for (const [name, value] of [
    ["expectedHeadSha", manifest.expectedHeadSha],
    ["expectedDefaultBranchSha", manifest.expectedDefaultBranchSha],
  ]) {
    invariant(SHA.test(value ?? ""), `${name} must be a full commit SHA`);
  }
  invariant(
    typeof manifest.expectedSourceRef === "string" &&
      /^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(manifest.expectedSourceRef),
    "expectedSourceRef must be a default-branch ref",
  );
  invariant(
    REPOSITORY.test(manifest.expectedRepository ?? ""),
    "expectedRepository must be an owner/repository",
  );
  invariant(
    typeof manifest.auditorProfile?.path === "string" &&
      manifest.auditorProfile.path.trim() &&
      DIGEST.test(manifest.auditorProfile.sha256 ?? ""),
    "manifest.auditorProfile must contain path and sha256",
  );
  invariant(
    ["complete", "incomplete"].includes(manifest.expected?.terminal),
    "manifest.expected.terminal is invalid",
  );
  invariant(
    Array.isArray(manifest.expected.findingIds) &&
      manifest.expected.findingIds.every(
        (id) =>
          typeof id === "string" && /^audit-[a-z0-9][a-z0-9-]{0,63}$/u.test(id),
      ),
    "manifest.expected.findingIds must contain valid audit IDs",
  );
  invariant(
    new Set(manifest.expected.findingIds).size ===
      manifest.expected.findingIds.length,
    "manifest.expected.findingIds must be unique",
  );
  return manifest;
}

function containsCredential(value, key = "") {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === ""
  ) {
    return false;
  }
  if (CREDENTIAL_KEY.test(key)) return true;
  if (typeof value === "string") return CREDENTIAL_VALUE.test(value);
  if (Array.isArray(value))
    return value.some((item) => containsCredential(item));
  if (typeof value === "object") {
    return Object.entries(value).some(([name, item]) =>
      containsCredential(item, name),
    );
  }
  return false;
}

function securitySensitive(value) {
  if (typeof value === "string") return SECURITY_CONTENT.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(securitySensitive);
}

function boundedString(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[^\x09\x0a\x0d\x20-\x7e]/u.test(value)
  );
}

function validPath(value) {
  return (
    boundedString(value, 512) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value
      .split("/")
      .every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function timestamp(value, name) {
  const milliseconds = Date.parse(value);
  invariant(
    Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value,
    `${name} is invalid`,
  );
  return milliseconds;
}

function validateArtifact(artifact, metadata, manifest, now) {
  exactKeys(
    artifact,
    [
      "schemaVersion",
      "headSha",
      "sourceRef",
      "summary",
      "findings",
      "validatedAt",
      "expiresAt",
    ],
    "audit artifact",
  );
  invariant(
    artifact.schemaVersion === 1,
    "audit artifact schemaVersion must equal 1",
  );
  invariant(
    artifact.headSha === metadata.headSha,
    "audit artifact headSha does not match",
  );
  invariant(
    artifact.sourceRef === manifest.expectedSourceRef,
    "audit artifact sourceRef does not match",
  );
  invariant(boundedString(artifact.summary, 2_000), "audit summary is invalid");
  invariant(
    Array.isArray(artifact.findings) &&
      artifact.findings.length <= MAX_FINDINGS,
    "audit findings must be an array",
  );
  const validatedAt = timestamp(artifact.validatedAt, "validatedAt");
  const expiresAt = timestamp(artifact.expiresAt, "expiresAt");
  invariant(expiresAt - validatedAt === SEVEN_DAYS, "audit expiry is invalid");
  invariant(expiresAt > now.valueOf(), "audit artifact is expired");
  for (const [index, finding] of artifact.findings.entries()) {
    exactKeys(
      finding,
      [
        "id",
        "path",
        "problemKey",
        "title",
        "category",
        "priority",
        "evidence",
        "recommendation",
      ],
      `finding ${index + 1}`,
    );
    invariant(
      typeof finding.id === "string" &&
        /^audit-[a-z0-9][a-z0-9-]{0,63}$/u.test(finding.id),
      `finding ${index + 1} id is invalid`,
    );
    invariant(validPath(finding.path), `finding ${index + 1} path is invalid`);
    invariant(
      typeof finding.problemKey === "string" &&
        /^[a-z0-9][a-z0-9._-]{2,127}$/u.test(finding.problemKey),
      `finding ${index + 1} problemKey is invalid`,
    );
    invariant(
      boundedString(finding.title, 256) &&
        boundedString(finding.category, 64) &&
        /^P[0-3]$/u.test(finding.priority) &&
        boundedString(finding.evidence, 2_000) &&
        boundedString(finding.recommendation, 2_000),
      `finding ${index + 1} content is invalid`,
    );
  }
  invariant(
    new Set(artifact.findings.map(({ id }) => id)).size ===
      artifact.findings.length,
    "audit finding IDs must be unique",
  );
}

function validateReceipt(
  receipt,
  metadata,
  manifest,
  artifactDigest,
  artifact,
) {
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "repository",
      "headSha",
      "sourceRef",
      "validatedAt",
      "expiresAt",
      "artifactSha256",
    ],
    "audit receipt",
  );
  return (
    receipt.schemaVersion === 1 &&
    receipt.repository === manifest.expectedRepository &&
    receipt.headSha === metadata.headSha &&
    receipt.sourceRef === manifest.expectedSourceRef &&
    receipt.validatedAt === artifact.validatedAt &&
    receipt.expiresAt === artifact.expiresAt &&
    receipt.artifactSha256 === artifactDigest
  );
}

function isRawArtifact(value) {
  return typeof value === "string" || Buffer.isBuffer(value);
}

function rawArtifactMatches(artifactRaw, artifact) {
  if (!isRawArtifact(artifactRaw)) return false;
  try {
    return isDeepStrictEqual(JSON.parse(artifactRaw), artifact);
  } catch {
    return false;
  }
}

function completedOutputMatchesArtifact(output, artifact) {
  try {
    exactKeys(output, ["type", "audit"], "validate_audit output");
    if (output.type !== "validate_audit" || typeof output.audit !== "string")
      return false;
    const audit = JSON.parse(output.audit);
    exactKeys(
      audit,
      ["headSha", "sourceRef", "summary", "findings"],
      "validate_audit payload",
    );
    return (
      audit.headSha === artifact.headSha &&
      audit.sourceRef === artifact.sourceRef &&
      audit.summary === artifact.summary &&
      JSON.stringify(audit.findings) === JSON.stringify(artifact.findings)
    );
  } catch {
    return false;
  }
}

function countByType(items) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item.type))].map((type) => [
      type,
      items.filter((item) => item.type === type).length,
    ]),
  );
}

export function evaluateAuditRun(
  manifestInput,
  {
    metadata,
    profile,
    prompt,
    artifact,
    artifactRaw,
    receipt,
    outputs,
    safeOutputs,
    errors,
    now = new Date(),
  },
) {
  const manifest = validateManifest(manifestInput);
  invariant(
    SHA.test(metadata?.headSha ?? "") &&
      SHA.test(metadata?.defaultBranchSha ?? ""),
    "run.json must contain full headSha and defaultBranchSha",
  );
  invariant(
    typeof metadata.defaultBranchRef === "string" &&
      metadata.defaultBranchRef === manifest.expectedSourceRef,
    "run.json defaultBranchRef does not match",
  );
  invariant(
    Array.isArray(outputs) &&
      Array.isArray(safeOutputs) &&
      Array.isArray(errors),
    "agent outputs, safe-output items, and errors must be arrays",
  );
  const incomplete =
    outputs.length === 1 && outputs[0]?.type === "report_incomplete";
  const artifactPresent = artifact !== undefined || receipt !== undefined;
  if (artifactPresent) {
    invariant(
      artifact !== undefined && receipt !== undefined,
      "artifact and receipt must be paired",
    );
  }
  if (!incomplete) {
    invariant(artifactPresent, "complete audit requires artifact and receipt");
  }
  if (artifactPresent) validateArtifact(artifact, metadata, manifest, now);

  const actualIds = artifact?.findings.map((finding) => finding.id) ?? [];
  const expectedIds = new Set(manifest.expected.findingIds);
  const missingFindingIds = [...expectedIds].filter(
    (id) => !actualIds.includes(id),
  );
  const unexpectedFindingIds = actualIds.filter((id) => !expectedIds.has(id));
  const artifactRawMatches = rawArtifactMatches(artifactRaw, artifact);
  const artifactDigest = isRawArtifact(artifactRaw)
    ? sha256(artifactRaw)
    : null;
  const receiptValid =
    !incomplete &&
    artifactRawMatches &&
    validateReceipt(receipt, metadata, manifest, artifactDigest, artifact);
  const checks = {
    runConclusion: metadata.conclusion === "success",
    agentErrors: errors.length === 0,
    head:
      metadata.headSha.toLowerCase() === manifest.expectedHeadSha.toLowerCase(),
    defaultBranch:
      metadata.defaultBranchSha.toLowerCase() ===
      manifest.expectedDefaultBranchSha.toLowerCase(),
    profileHash:
      sha256(profile) === manifest.auditorProfile.sha256.toLowerCase(),
    profileInPrompt: prompt.includes(profile),
    artifact: incomplete
      ? !artifactPresent
      : artifactPresent && artifactRawMatches && artifact.schemaVersion === 1,
    receipt: incomplete ? !artifactPresent : artifactRawMatches && receiptValid,
    findingIds: incomplete
      ? expectedIds.size === 0
      : missingFindingIds.length === 0 && unexpectedFindingIds.length === 0,
    noSecuritySensitiveFindings:
      incomplete ||
      (!securitySensitive(artifact.summary) &&
        artifact.findings.every((finding) => !securitySensitive(finding))),
    noCredentials:
      !containsCredential(artifact) && !containsCredential(receipt),
    knownOutputs: outputs.every((item) => OUTPUT_TYPES.has(item.type)),
    completeOutput:
      incomplete ||
      (outputs.length === 1 &&
        completedOutputMatchesArtifact(outputs[0], artifact)),
    noMutations: outputs.every(
      (item) =>
        item.type === "validate_audit" || item.type === "report_incomplete",
    ),
    safeOutputReceipt:
      safeOutputs.length === 1 &&
      safeOutputs[0]?.type ===
        (incomplete ? "report_incomplete" : "validate_audit"),
    terminal:
      (manifest.expected.terminal === "incomplete") === incomplete &&
      (incomplete
        ? !artifactPresent
        : outputs.length === 1 && outputs[0]?.type === "validate_audit"),
  };
  return {
    schemaVersion: 1,
    runId: metadata.runId ?? null,
    headSha: metadata.headSha.toLowerCase(),
    defaultBranchSha: metadata.defaultBranchSha.toLowerCase(),
    profileSha256: sha256(profile),
    artifactSha256: artifactDigest,
    outputs: countByType(outputs),
    safeOutputs: countByType(safeOutputs),
    missingFindingIds,
    unexpectedFindingIds,
    incomplete,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function parseJsonLines(value, label) {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} line ${index + 1}: ${error.message}`);
      }
    });
}

async function optionalFile(filePath) {
  try {
    await access(filePath);
    return readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadRun(manifest, profile, directory) {
  const [metadata, prompt, agentOutput, artifactRaw, receiptRaw, safeOutputs] =
    await Promise.all([
      readFile(path.join(directory, "run.json"), "utf8").then(JSON.parse),
      readFile(path.join(directory, "aw-prompts", "prompt.txt"), "utf8"),
      readFile(path.join(directory, "agent_output.json"), "utf8").then(
        JSON.parse,
      ),
      optionalFile(path.join(directory, "audit.json")),
      optionalFile(path.join(directory, "receipt.json")),
      readFile(path.join(directory, "safe-output-items.jsonl"), "utf8").then(
        (value) => parseJsonLines(value, "safe-output-items.jsonl"),
      ),
    ]);
  return evaluateAuditRun(manifest, {
    metadata,
    profile,
    prompt,
    artifact: artifactRaw === undefined ? undefined : JSON.parse(artifactRaw),
    artifactRaw,
    receipt: receiptRaw === undefined ? undefined : JSON.parse(receiptRaw),
    outputs: agentOutput.items,
    safeOutputs,
    errors: agentOutput.errors,
  });
}

function requiredArg(argv, name) {
  const index = argv.indexOf(name);
  invariant(index >= 0 && argv[index + 1], `missing ${name}`);
  return path.resolve(argv[index + 1]);
}

export async function runCli(
  argv = process.argv.slice(2),
  write = (value) => process.stdout.write(`${value}\n`),
) {
  const manifestPath = requiredArg(argv, "--manifest");
  const runsDirectory = requiredArg(argv, "--runs-directory");
  invariant(
    argv.length === 4,
    "only --manifest and --runs-directory are supported",
  );
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const profile = await readFile(
    path.resolve(path.dirname(manifestPath), manifest.auditorProfile.path),
    "utf8",
  );
  const entries = (await readdir(runsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  invariant(entries.length > 0, "runs directory contains no run directories");
  invariant(
    entries.length === manifest.repeat,
    `expected ${manifest.repeat} run directories, found ${entries.length}`,
  );
  const runs = [];
  for (const entry of entries) {
    runs.push(
      await loadRun(manifest, profile, path.join(runsDirectory, entry.name)),
    );
  }
  const report = {
    schemaVersion: 1,
    expectedHeadSha: manifest.expectedHeadSha.toLowerCase(),
    expectedDefaultBranchSha: manifest.expectedDefaultBranchSha.toLowerCase(),
    expectedRuns: manifest.repeat,
    passedRuns: runs.filter((run) => run.passed).length,
    completedRuns: runs.length,
    passed: runs.every((run) => run.passed),
    runs,
  };
  write(JSON.stringify(report, null, 2));
  return report.passed ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  runCli()
    .then((code) => (process.exitCode = code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
