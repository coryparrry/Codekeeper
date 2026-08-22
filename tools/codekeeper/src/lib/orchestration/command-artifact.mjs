import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentHead } from "../git.mjs";
import {
  readJson,
  readRegularFile,
  readRegularJson,
  writeJson,
} from "../io.mjs";
import { sha256 } from "../markers.mjs";
import {
  assertOwnerCommandContext,
  resolveOwnerCommandContext,
  runDeterministicOwnerCommand,
} from "../commands.mjs";
import {
  createArtifactHandoff,
  verifyArtifactHandoff,
} from "./artifact-handoff.mjs";
import { assertVerifiedModePlan } from "./mode-adapters.mjs";

const COMMAND_CANDIDATE_VERSION = 1;
const COMMAND_SEAL_VERSION = 1;
const SEALED_FILES = Object.freeze([
  "candidate.json",
  "config.json",
  "context.json",
  "manifest.json",
  "mode-plan.json",
]);

function adapterMode(mode) {
  return mode === "issues" ? "issue" : mode === "maintain" ? "audit" : mode;
}

async function createFreshDirectory(directory) {
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Output directory already exists: ${directory}`);
    }
    throw error;
  }
}

async function assertClosedDirectory(directory, expected) {
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Owner-command artifact must be a regular directory");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    JSON.stringify(names) !== JSON.stringify([...expected].sort())
  ) {
    throw new Error("Owner-command artifact inventory is invalid");
  }
}

function requireDigest(value, name) {
  if (!/^[a-f0-9]{64}$/i.test(String(value ?? ""))) {
    throw new Error(`${name} must be a SHA-256 digest`);
  }
  return value.toLowerCase();
}

function requireCommit(value, name) {
  if (!/^[a-f0-9]{40,64}$/i.test(String(value ?? ""))) {
    throw new Error(`${name} must be a full commit SHA`);
  }
  return value.toLowerCase();
}

function commandCandidate({ context, contextBytes, planBytes, configBytes }) {
  return {
    version: COMMAND_CANDIDATE_VERSION,
    kind: "owner-command",
    mode: context.resolvedMode,
    repository: context.repository,
    commandContextSha256: sha256(
      Buffer.from(`${JSON.stringify(context.command)}\n`, "utf8"),
    ),
    contextSha256: sha256(contextBytes),
    modePlanSha256: sha256(planBytes),
    configSha256: sha256(configBytes),
  };
}

function assertCommandCandidate(candidate, context, planBytes, configBytes) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).sort().join(",") !==
      [
        "commandContextSha256",
        "configSha256",
        "contextSha256",
        "kind",
        "mode",
        "modePlanSha256",
        "repository",
        "version",
      ]
        .sort()
        .join(",") ||
    candidate.version !== COMMAND_CANDIDATE_VERSION ||
    candidate.kind !== "owner-command" ||
    candidate.mode !== context.resolvedMode ||
    candidate.repository !== context.repository ||
    candidate.commandContextSha256 !==
      sha256(Buffer.from(`${JSON.stringify(context.command)}\n`, "utf8")) ||
    candidate.modePlanSha256 !== sha256(planBytes) ||
    candidate.configSha256 !== sha256(configBytes)
  ) {
    throw new Error("Owner-command candidate is invalid or stale");
  }
  return candidate;
}

export async function createCommandArtifactHandoff({
  artifactDirectory,
  commandContext,
  modePlanPath,
  configPath,
  config,
  toolingSha,
  configSha256,
}) {
  const trustedCommand = assertOwnerCommandContext(commandContext);
  const planBytes = await readRegularFile(modePlanPath);
  const plan = JSON.parse(planBytes.toString("utf8"));
  const verifiedPlan = assertVerifiedModePlan(plan, plan.resolvedMode, {
    config,
  });
  if (trustedCommand.executionKind !== "deterministic") {
    throw new Error("Only deterministic owner commands use a command handoff");
  }
  if (verifiedPlan.trigger !== "owner-command") {
    throw new Error(
      "Owner-command handoff requires an owner-command mode plan",
    );
  }
  if (verifiedPlan.targetNumber !== trustedCommand.targetNumber) {
    throw new Error("Owner-command target does not match the mode plan");
  }
  if (!trustedCommand.repository) {
    throw new Error("Owner-command repository is required for the handoff");
  }
  const configBytes = await readRegularFile(configPath);
  if (sha256(configBytes) !== requireDigest(configSha256, "configSha256")) {
    throw new Error("Owner-command policy digest is stale");
  }
  const sourceCommit = requireCommit(toolingSha, "toolingSha");
  const context = {
    schemaVersion: 1,
    mode: "command",
    resolvedMode: verifiedPlan.resolvedMode,
    repository: trustedCommand.repository,
    baseSha: currentHead(),
    toolingSha: sourceCommit,
    configSha256,
    requestedBy: trustedCommand.actor,
    command: trustedCommand,
  };
  await createFreshDirectory(artifactDirectory);
  await writeFile(
    path.join(artifactDirectory, "agent-profile.md"),
    "# Codekeeper deterministic owner command\n",
  );
  await writeJson(path.join(artifactDirectory, "context.json"), context);
  const contextBytes = await readRegularFile(
    path.join(artifactDirectory, "context.json"),
  );
  const candidate = commandCandidate({
    context,
    contextBytes,
    planBytes,
    configBytes,
  });
  await writeJson(path.join(artifactDirectory, "candidate.json"), candidate);
  await writeJson(path.join(artifactDirectory, "result.json"), {
    mode: "command",
    deterministic: true,
    command: trustedCommand.canonicalCommand,
  });
  await writeJson(path.join(artifactDirectory, "validation.json"), null);
  await writeJson(path.join(artifactDirectory, "runtime-metadata.json"), {
    mode: "command",
    provider: "deterministic",
    model: "none",
  });
  const handoff = await createArtifactHandoff({
    sourceDirectory: artifactDirectory,
    modePlanPath,
    configPath,
    config,
    toolingSha: sourceCommit,
  });
  return {
    candidateSha256: sha256(
      await readRegularFile(path.join(artifactDirectory, "candidate.json")),
    ),
    contextSha256: sha256(contextBytes),
    handoffManifestSha256: handoff.handoffManifestSha256,
  };
}

export async function sealCommandArtifact({
  candidateDirectory,
  artifactDirectory,
  expectedCandidateSha256,
  expectedContextSha256,
  expectedHandoffManifestSha256,
  modePlanPath,
  configPath,
  config,
  toolingSha,
  configSha256,
}) {
  await verifyArtifactHandoff({
    sourceDirectory: candidateDirectory,
    expectedManifestSha256: expectedHandoffManifestSha256,
    expectedKind: "compute",
    expectedModePlanPath: modePlanPath,
    expectedPolicyPath: configPath,
    config,
    toolingSha,
  });
  const [candidateBytes, contextBytes, planBytes, configBytes] =
    await Promise.all([
      readRegularFile(path.join(candidateDirectory, "candidate.json")),
      readRegularFile(path.join(candidateDirectory, "context.json")),
      readRegularFile(modePlanPath),
      readRegularFile(configPath),
    ]);
  if (
    sha256(candidateBytes) !==
    requireDigest(expectedCandidateSha256, "expectedCandidateSha256")
  ) {
    throw new Error("Owner-command candidate digest changed before sealing");
  }
  if (
    sha256(contextBytes) !==
    requireDigest(expectedContextSha256, "expectedContextSha256")
  ) {
    throw new Error("Owner-command context digest changed before sealing");
  }
  if (sha256(configBytes) !== requireDigest(configSha256, "configSha256")) {
    throw new Error("Owner-command policy digest changed before sealing");
  }
  const context = JSON.parse(contextBytes.toString("utf8"));
  const candidate = JSON.parse(candidateBytes.toString("utf8"));
  assertOwnerCommandContext(context.command);
  assertCommandCandidate(candidate, context, planBytes, configBytes);
  await createFreshDirectory(artifactDirectory);
  await Promise.all([
    writeFile(path.join(artifactDirectory, "candidate.json"), candidateBytes),
    writeFile(path.join(artifactDirectory, "context.json"), contextBytes),
    writeFile(path.join(artifactDirectory, "mode-plan.json"), planBytes),
    writeFile(path.join(artifactDirectory, "config.json"), configBytes),
  ]);
  const manifest = {
    version: COMMAND_SEAL_VERSION,
    sealed: true,
    kind: "owner-command",
    repository: context.repository,
    mode: context.resolvedMode,
    candidateSha256: sha256(candidateBytes),
    contextSha256: sha256(contextBytes),
    modePlanSha256: sha256(planBytes),
    configSha256: sha256(configBytes),
  };
  await writeJson(path.join(artifactDirectory, "manifest.json"), manifest);
  return {
    manifest,
    manifestSha256: sha256(
      await readRegularFile(path.join(artifactDirectory, "manifest.json")),
    ),
  };
}

export async function publishCommandArtifact({
  artifactDirectory,
  expectedManifestSha256,
  eventPath,
  automationLogin,
  automationIdentity,
  installedModes,
  modePlanPath,
  configPath,
  config,
  configSha256,
  token,
}) {
  await assertClosedDirectory(artifactDirectory, SEALED_FILES);
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  const manifestBytes = await readRegularFile(manifestPath);
  if (
    sha256(manifestBytes) !==
    requireDigest(expectedManifestSha256, "expectedManifestSha256")
  ) {
    throw new Error("Owner-command sealed manifest changed before publication");
  }
  const manifest = await readRegularJson(manifestPath);
  const [candidateBytes, contextBytes, planBytes, configBytes] =
    await Promise.all([
      readRegularFile(path.join(artifactDirectory, "candidate.json")),
      readRegularFile(path.join(artifactDirectory, "context.json")),
      readRegularFile(path.join(artifactDirectory, "mode-plan.json")),
      readRegularFile(path.join(artifactDirectory, "config.json")),
    ]);
  const expectedPlanBytes = await readRegularFile(modePlanPath);
  const expectedConfigBytes = await readRegularFile(configPath);
  if (
    manifest?.version !== COMMAND_SEAL_VERSION ||
    manifest.sealed !== true ||
    manifest.kind !== "owner-command" ||
    manifest.candidateSha256 !== sha256(candidateBytes) ||
    manifest.contextSha256 !== sha256(contextBytes) ||
    manifest.modePlanSha256 !== sha256(planBytes) ||
    manifest.configSha256 !== sha256(configBytes) ||
    Buffer.compare(planBytes, expectedPlanBytes) !== 0 ||
    Buffer.compare(configBytes, expectedConfigBytes) !== 0 ||
    manifest.configSha256 !== requireDigest(configSha256, "configSha256")
  ) {
    throw new Error("Owner-command sealed artifact is invalid or stale");
  }
  const context = JSON.parse(contextBytes.toString("utf8"));
  const candidate = JSON.parse(candidateBytes.toString("utf8"));
  const plan = JSON.parse(planBytes.toString("utf8"));
  const verifiedPlan = assertVerifiedModePlan(plan, context.resolvedMode, {
    config,
  });
  assertCommandCandidate(candidate, context, planBytes, configBytes);
  const frozenCommand = assertOwnerCommandContext(context.command);
  const currentCommand = resolveOwnerCommandContext({
    event: await readJson(eventPath),
    eventName: frozenCommand.eventName,
    config,
    automationLogin,
  });
  if (JSON.stringify(currentCommand) !== JSON.stringify(frozenCommand)) {
    throw new Error("Owner-command context changed before publication");
  }
  if (
    verifiedPlan.trigger !== "owner-command" ||
    verifiedPlan.targetNumber !== frozenCommand.targetNumber ||
    verifiedPlan.resolvedMode !== context.resolvedMode
  ) {
    throw new Error("Owner-command plan does not match the sealed command");
  }
  return runDeterministicOwnerCommand({
    eventPath,
    config,
    token,
    automationIdentity,
    installedModes,
  });
}
