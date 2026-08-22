import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runAgentFromBundle,
  runWorkspaceAgentFromBundle,
} from "../agents-runtime.mjs";
import { getAgentRuntimeSettings } from "../config.mjs";
import { applyPatch, createPatch, currentHead } from "../git.mjs";
import { modeAdapter, assertVerifiedModePlan } from "./mode-adapters.mjs";
import { assertCredentialBoundary } from "./credential-boundaries.mjs";
import {
  runIsolatedWorkspaceAgent,
  verifyFrozenContext,
} from "./workspace-isolation.mjs";

function required(value, name) {
  if (value === undefined || value === null || value === "")
    throw new Error(`${name} is required`);
  return value;
}

async function applyWorkspacePatch(patchPath) {
  const patch = await readFile(patchPath);
  if (patch.length === 0) return;
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-workspace-patch-"),
  );
  try {
    const safePatchPath = path.join(temporaryDirectory, "workspace.patch");
    await writeFile(safePatchPath, patch);
    applyPatch(safePatchPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runCompute({
  mode,
  operation,
  plan,
  config,
  ...options
}) {
  const verifiedPlan = assertVerifiedModePlan(plan, mode, { config });
  const adapter = modeAdapter(verifiedPlan.resolvedMode);
  const directory = required(options.directory, "directory");
  if (operation === "prepare") {
    if (
      options.targetNumber !== undefined &&
      verifiedPlan.targetNumber !== options.targetNumber
    ) {
      throw new Error("Mode-plan target does not match the prepared target");
    }
    if (typeof adapter.prepare !== "function")
      throw new Error(`Mode ${mode} has no prepare adapter`);
    const context = await adapter.prepare({ ...options, config, directory });
    return {
      context,
      contextSha256: await digestFile(path.join(directory, "context.json")),
    };
  }
  if (operation === "workspace-worker") {
    const resultPath = required(options.resultPath, "resultPath");
    return runWorkspaceAgentFromBundle({
      mode:
        adapter.mode === "issues"
          ? "issue"
          : adapter.mode === "maintain"
            ? "audit"
            : adapter.mode,
      directory,
      resultPath,
      config,
    });
  }
  if (operation === "workspace") {
    assertCredentialBoundary("workspace", {
      token: options.token,
      modelKey: process.env.CODEKEEPER_MODEL_API_KEY,
      traceKey: process.env.CODEKEEPER_TRACE_API_KEY,
      workspaceKey:
        options.workspaceApiKey ?? process.env.CODEKEEPER_WORKSPACE_API_KEY,
    });
    const resultPath = required(options.resultPath, "resultPath");
    const runtimeMode =
      adapter.mode === "issues"
        ? "issue"
        : adapter.mode === "maintain"
          ? "audit"
          : adapter.mode;
    const settings = getAgentRuntimeSettings(config, runtimeMode, {
      mutationAuthorized: options.mutationAuthorized === true,
    });
    if (verifiedPlan.workspaceAccess === "none" || !settings.workspaceEnabled) {
      return { skipped: true, mode: runtimeMode };
    }
    const workspaceResult = await runIsolatedWorkspaceAgent({
      mode: runtimeMode,
      directory,
      resultPath,
      configPath: required(options.configPath, "configPath"),
      modePlanPath: required(options.modePlanPath, "modePlanPath"),
      cliPath: options.cliPath ?? process.argv[1],
      workspaceApiKey:
        options.workspaceApiKey ?? process.env.CODEKEEPER_WORKSPACE_API_KEY,
      workspaceUser:
        options.workspaceUser ??
        process.env.WORKSPACE_USER ??
        (verifiedPlan.workspaceAccess === "write"
          ? "codekeeper-workspace"
          : undefined),
      workspaceAccess: verifiedPlan.workspaceAccess,
      codexHome: options.codexHome ?? process.env.CODEX_HOME,
      quarantine: options.quarantine ?? process.env.QUARANTINE,
      workspaceTemp: options.workspaceTemp ?? process.env.WORKSPACE_TEMP,
      workspaceRoot: options.workspaceRoot ?? process.env.GITHUB_WORKSPACE,
      repositoryPath: options.repositoryPath ?? process.cwd(),
      toolingPath: options.toolingPath,
      worker: () =>
        runWorkspaceAgentFromBundle({
          mode: runtimeMode,
          directory,
          resultPath,
          config,
        }),
    });
    if (options.patchPath) {
      const context = JSON.parse(
        await readFile(path.join(directory, "context.json"), "utf8"),
      );
      const expectedHead = String(context.baseSha ?? "").trim();
      const actualHead = currentHead();
      if (!expectedHead || actualHead !== expectedHead) {
        throw new Error(
          `Workspace checkout HEAD ${actualHead} does not match frozen context.baseSha ${expectedHead || "missing"}`,
        );
      }
      workspaceResult.patch = await createPatch(
        options.patchPath,
        process.cwd(),
        config.audit.repair,
      );
    }
    return workspaceResult;
  }
  if (operation === "analyze") {
    assertCredentialBoundary("coordinator", {
      token: options.token,
      modelKey: process.env.CODEKEEPER_MODEL_API_KEY,
      traceKey: process.env.CODEKEEPER_TRACE_API_KEY,
      workspaceKey: process.env.CODEKEEPER_WORKSPACE_API_KEY,
    });
    const resultPath = required(options.resultPath, "resultPath");
    if (options.expectedContextSha256)
      await verifyFrozenContext(directory, options.expectedContextSha256);
    if (options.expectedBaseSha) {
      const context = JSON.parse(
        await readFile(path.join(directory, "context.json"), "utf8"),
      );
      if (context.baseSha !== options.expectedBaseSha)
        throw new Error(
          "Workspace checkout target does not match the frozen context base SHA",
        );
    }
    if (options.workspacePatchPath)
      await applyWorkspacePatch(options.workspacePatchPath);
    return runAgentFromBundle({
      mode:
        adapter.mode === "issues"
          ? "issue"
          : adapter.mode === "maintain"
            ? "audit"
            : adapter.mode,
      directory,
      resultPath,
      config,
      workspaceResultPath: options.workspaceResultPath,
    });
  }
  if (operation === "bind-context") {
    return {
      contextSha256: await verifyFrozenContext(
        directory,
        required(options.expectedContextSha256, "expectedContextSha256"),
      ),
    };
  }
  throw new Error(`Unknown compute operation: ${operation}`);
}

async function digestFile(filePath) {
  const { sha256 } = await import("../markers.mjs");
  return sha256(await readFile(filePath));
}
