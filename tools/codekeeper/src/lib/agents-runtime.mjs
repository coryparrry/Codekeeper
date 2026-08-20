import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadFrozenAgentProfile } from "./agent-profiles.mjs";
import * as core from "./agents-runtime-core.mjs";
import { getAgentRuntimeSettings } from "./config.mjs";
import { readJson, readOptionalRegularJson, writeJson } from "./io.mjs";
import { validateIssueResult } from "./schemas.mjs";
import { loadTrustedRepositoryContext, repositoryContextGate } from "./repository-context.mjs";

export * from "./agents-runtime-core.mjs";
export { loadTrustedRepositoryContext, repositoryContextGate, trustedRepositoryRef } from "./repository-context.mjs";

export async function runWorkspaceAgentFromBundle(options) {
  const { mode, directory, resultPath } = options;
  const contextPath = path.join(directory, "context.json");
  const promptPath = path.join(directory, "workspace-prompt.md");
  const [context, originalPrompt] = await Promise.all([readJson(contextPath), readFile(promptPath, "utf8")]);
  if (context?.mode !== mode) throw new Error(`Frozen context mode is ${context?.mode ?? "missing"}; expected ${mode}`);
  const repositoryContext = loadTrustedRepositoryContext(mode, context, { cwd: process.cwd() });
  const gatedPrompt = `${repositoryContextGate(mode, context, repositoryContext)}\n\n${originalPrompt}`;
  const result = await core.runWorkspaceAgentFromBundle({ ...options, workspacePrompt: gatedPrompt });
  const metadataPath = path.join(path.dirname(resultPath), "workspace-runtime-metadata.json");
  const metadata = await readJson(metadataPath);
  metadata.repositoryContext = repositoryContextMetadata(repositoryContext);
  await writeJson(metadataPath, metadata);
  return result;
}

function repositoryContextMetadata(repositoryContext) {
  return {
    version: repositoryContext.version,
    ref: repositoryContext.ref,
    instructionFiles: repositoryContext.instructionFiles,
    rootPath: repositoryContext.rootPath,
    rootInstructionsSha256: repositoryContext.rootInstructionsSha256,
    rootInstructionsBytes: repositoryContext.rootInstructionsBytes
  };
}

function validateRepositoryContextMetadata(metadata, expected) {
  const expectedMetadata = repositoryContextMetadata(expected);
  if (!metadata || typeof metadata !== "object"
    || metadata.version !== expectedMetadata.version
    || metadata.ref !== expectedMetadata.ref
    || metadata.rootPath !== expectedMetadata.rootPath
    || metadata.rootInstructionsSha256 !== expectedMetadata.rootInstructionsSha256
    || metadata.rootInstructionsBytes !== expectedMetadata.rootInstructionsBytes
    || !Array.isArray(metadata.instructionFiles)
    || metadata.instructionFiles.length !== expectedMetadata.instructionFiles.length
    || metadata.instructionFiles.some((file, index) => file !== expectedMetadata.instructionFiles[index])) {
    throw new Error("Workspace repository context metadata does not match the frozen trusted context");
  }
  return expectedMetadata;
}

function noWorkspaceIssueResult() {
  return {
    mode: "issue",
    summary: "No repository workspace evidence was available for issue triage.",
    type: "maintenance",
    priority: "p3",
    labels: [],
    actionable: false,
    missingInformation: ["Repository context is required before Codekeeper can recommend work."],
    duplicateOf: null,
    duplicateConfidence: "none",
    implementationRecommendation: "no",
    decision: { required: false, question: "", rationale: "", options: [] },
    comment: "Codekeeper made no repository-dependent suggestion because workspace context was unavailable."
  };
}

export async function runAgentFromBundle(options) {
  const { mode, directory, config, resultPath, workspaceResultPath = path.join(directory, "workspace-result.json") } = options;
  if (mode !== "issue") return core.runAgentFromBundle(options);

  const [context, specialistResult, workspaceMetadata] = await Promise.all([
    readJson(path.join(directory, "context.json")),
    readOptionalRegularJson(workspaceResultPath),
    readOptionalRegularJson(path.join(path.dirname(workspaceResultPath), "workspace-runtime-metadata.json"))
  ]);
  if (context?.mode !== "issue") throw new Error(`Frozen context mode is ${context?.mode ?? "missing"}; expected issue`);
  await loadFrozenAgentProfile({ mode: "issue", directory, context });
  const settings = getAgentRuntimeSettings(config, "issue", { mutationAuthorized: false, context });

  if (specialistResult === null) {
    if (settings.workspaceEnabled) throw new Error("Codekeeper issue triage requires repository workspace evidence");
    const output = validateIssueResult(noWorkspaceIssueResult(), config);
    const metadata = { mode: "issue", provider: "deterministic", model: "none", attempt: 0, structuredOutputs: false, workspaceSpecialistUsed: false, coordinatorSkipped: "no-workspace", maxTurns: 0, durationMs: 0, totalModelDurationMs: 0 };
    await writeJson(resultPath, output);
    await writeJson(path.join(directory, "runtime-metadata.json"), metadata);
    return metadata;
  }

  if (!settings.workspaceEnabled) {
    throw new Error("Codekeeper issue triage received workspace evidence while the specialist is disabled");
  }
  const trustedRepositoryContext = loadTrustedRepositoryContext("issue", context, { cwd: process.cwd() });
  const validatedWorkspaceMetadata = core.validateWorkspaceRuntimeMetadata(workspaceMetadata, "issue", config, context);
  validateRepositoryContextMetadata(validatedWorkspaceMetadata.repositoryContext, trustedRepositoryContext);
  const output = validateIssueResult(specialistResult, config);
  const totalModelDurationMs = validatedWorkspaceMetadata.totalDurationMs;
  const metadata = {
    mode: "issue",
    provider: "workspace",
    model: settings.workspaceModel,
    attempt: 1,
    structuredOutputs: true,
    workspaceSpecialistUsed: true,
    coordinatorSkipped: "workspace-authoritative",
    maxTurns: 0,
    durationMs: 0,
    totalModelDurationMs,
    workspace: validatedWorkspaceMetadata
  };
  await writeJson(resultPath, output);
  await writeJson(path.join(directory, "runtime-metadata.json"), metadata);
  return metadata;
}
