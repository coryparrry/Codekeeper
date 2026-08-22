#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { getAgentRuntimeSettings, loadConfig } from "./lib/config.mjs";
import {
  log,
  parseArgs,
  readJson,
  readRegularFile,
  setGitHubOutput,
  workflowCommandValue,
} from "./lib/io.mjs";
import { applyPatch, createPatch, currentHead } from "./lib/git.mjs";
import {
  prepareAudit,
  prepareFix,
  prepareIssue,
  prepareReview,
} from "./lib/prepare.mjs";
import {
  publishAudit,
  publishFix,
  publishIssue,
  publishReview,
} from "./lib/publish.mjs";
import {
  sealAudit,
  sealFix,
  sealIssue,
  sealReview,
  validateAudit,
  validateFix,
  validateIssue,
  validateReview,
  verifyAudit,
  verifyFix,
} from "./lib/validate.mjs";
import { assertRunnerOwnedDirectory } from "./lib/workspace.mjs";
import { sha256 } from "./lib/markers.mjs";
import {
  isProviderCleanupTimeout,
  runAgentFromBundle,
  runWorkspaceAgentFromBundle,
} from "./lib/agents-runtime.mjs";
import {
  resolveOwnerCommandContext,
  runOwnerCommand,
} from "./lib/commands.mjs";
import { resolveAgentProfileInputs } from "./lib/agent-profiles.mjs";
import { runCompute } from "./lib/orchestration/compute.mjs";
import { runValidate } from "./lib/orchestration/validate.mjs";
import { runPublish } from "./lib/orchestration/publish.mjs";
import { prepareTrustedConfig } from "./lib/orchestration/workspace-isolation.mjs";

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function strictBoolean(value, name) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function stringList(value, name) {
  if (value === undefined || value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

function bundleFile(directory, filePath, flag) {
  const runnerDirectory = assertRunnerOwnedDirectory(directory);
  const resolved = runnerFile(filePath, flag);
  const relative = path.relative(runnerDirectory, resolved);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".."
  ) {
    throw new Error(
      `--${flag} must be a file inside the runner-owned --directory`,
    );
  }
  return resolved;
}

function runnerFile(filePath, flag) {
  const resolved = path.resolve(filePath);
  const directory = assertRunnerOwnedDirectory(path.dirname(resolved));
  return path.join(directory, path.basename(resolved));
}

function agentProfileInputs(args, toolingSha) {
  return resolveAgentProfileInputs({
    sourcePath: args.get("agent-profile"),
    source: args.get("agent-profile-source"),
    sourceSha: args.get("agent-profile-source-sha"),
    packageSourceSha: toolingSha,
  });
}

async function stagePlan(args, directory, mode) {
  const planPath = args.get("mode-plan");
  if (!planPath)
    throw new Error(
      "Stage commands require --mode-plan from a prior trusted resolution",
    );
  const resolved = runnerFile(planPath, "mode-plan");
  let plan;
  try {
    plan = JSON.parse((await readRegularFile(resolved)).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`Invalid mode plan JSON: ${error.message}`);
    throw error;
  }
  return { mode, plan };
}

async function runStageCommand({
  args,
  phase,
  config,
  configSha256,
  toolingSha,
  token,
  dryRun,
}) {
  const operation = args.require("operation");
  const mode = args.get("mode");
  if (phase === "compute" && operation === "owner-command-context") {
    const context = resolveOwnerCommandContext({
      event: await readJson(args.require("event")),
      config,
      automationLogin: args.require("automation-bot-login"),
    });
    if (args.get("result")) {
      await writeFile(
        runnerFile(args.get("result"), "result"),
        `${JSON.stringify(context, null, 2)}\n`,
        { flag: "wx" },
      );
    }
    return context;
  }
  const rawDirectory = args.get("directory");
  const directory = rawDirectory
    ? assertRunnerOwnedDirectory(rawDirectory)
    : null;
  if (!mode) throw new Error(`Stage ${phase} requires --mode`);
  if (phase === "compute") {
    const plan = (await stagePlan(args, directory, mode)).plan;
    return runCompute({
      mode,
      operation,
      plan,
      config,
      dryRun,
      configPath: args.get("config"),
      modePlanPath: args.get("mode-plan"),
      directory,
      eventPath: args.get("event"),
      token,
      toolingSha,
      configSha256,
      resultPath:
        args.get("result") && directory
          ? bundleFile(directory, args.get("result"), "result")
          : undefined,
      workspaceResultPath:
        args.get("workspace-result") && directory
          ? runnerFile(args.get("workspace-result"), "workspace-result")
          : undefined,
      expectedContextSha256: args.get("expected-context-sha"),
      expectedBaseSha: args.get("expected-base-sha"),
      mutationAuthorized: args.get("mutation-authorized") === "true",
      workspaceApiKey: process.env.CODEKEEPER_WORKSPACE_API_KEY,
      workspaceUser: process.env.WORKSPACE_USER,
      codexHome: process.env.CODEX_HOME,
      quarantine: process.env.QUARANTINE,
      workspaceTemp: process.env.WORKSPACE_TEMP,
      workspaceRoot: process.env.GITHUB_WORKSPACE,
      toolingPath: process.env.TOOLING_PATH,
      patchPath:
        args.get("patch") && directory
          ? bundleFile(directory, args.get("patch"), "patch")
          : undefined,
      workspacePatchPath: args.get("workspace-patch")
        ? runnerFile(args.get("workspace-patch"), "workspace-patch")
        : undefined,
      actor: args.get("actor"),
      triageMode: args.get("triage-mode"),
      repairAuthorized:
        args.get("repair-authorized") === undefined
          ? false
          : strictBoolean(args.get("repair-authorized"), "repair-authorized"),
      targetNumber: args.get("target-number")
        ? integer(args.get("target-number"), "target-number")
        : undefined,
      authorizationMode: args.get("authorization-mode"),
      expectedHead: args.get("expected-head"),
      reviewThreadIds: stringList(
        args.get("review-thread-ids", ""),
        "review-thread-ids",
      ),
      ownerCommandContext: args.get("command-context")
        ? JSON.parse(
            (
              await readRegularFile(
                runnerFile(args.get("command-context"), "command-context"),
              )
            ).toString("utf8"),
          )
        : undefined,
      ...(await agentProfileInputs(args, toolingSha)),
    });
  }
  if (phase === "validate") {
    if (
      !directory &&
      !["verify", "seal", "command-candidate", "command-seal"].includes(
        operation,
      )
    )
      throw new Error("Validation stages require --directory");
    const { plan } = await stagePlan(args, directory, mode);
    const commandContext = args.get("command-context")
      ? JSON.parse(
          (
            await readRegularFile(
              runnerFile(args.get("command-context"), "command-context"),
            )
          ).toString("utf8"),
        )
      : undefined;
    return runValidate({
      mode,
      operation,
      plan,
      config,
      configSha256,
      directory,
      contextPath: args.get("context")
        ? bundleFile(directory, args.get("context"), "context")
        : undefined,
      resultPath: args.get("result")
        ? bundleFile(directory, args.get("result"), "result")
        : undefined,
      artifactDirectory: args.get("artifact")
        ? assertRunnerOwnedDirectory(args.get("artifact"))
        : undefined,
      candidateDirectory: args.get("candidate")
        ? assertRunnerOwnedDirectory(args.get("candidate"))
        : undefined,
      configPath: args.get("config"),
      modePlanPath: args.get("mode-plan"),
      toolingSha,
      workspaceResultPath: args.get("workspace-result")
        ? runnerFile(args.get("workspace-result"), "workspace-result")
        : undefined,
      expectedCandidateSha256: args.get("expected-candidate-sha"),
      expectedContextSha256: args.get("expected-context-sha"),
      expectedHandoffManifestSha256: args.get("expected-handoff-manifest-sha"),
      commandContext,
      targetNumber: args.get("target-number")
        ? integer(args.get("target-number"), "target-number")
        : undefined,
    });
  }
  if (phase === "publish") {
    const { plan } = await stagePlan(args, directory, mode);
    return runPublish({
      mode,
      operation,
      plan,
      config,
      configSha256,
      artifactDirectory: args.get("artifact")
        ? assertRunnerOwnedDirectory(args.get("artifact"))
        : undefined,
      expectedManifestSha256: args.get("expected-manifest-sha"),
      token,
      dryRun,
      contentsPermission: args.get("app-contents-permission"),
      issuesPermission: args.get("app-issues-permission"),
      pullRequestsPermission: args.get("app-pull-requests-permission"),
      appSlug: args.get("app-slug"),
      apiUrl: args.get("api-url"),
      appClientId: process.env.APP_CLIENT_ID,
      appPrivateKey: process.env.APP_PRIVATE_KEY,
      eventPath: args.get("event"),
      automationLogin: args.get("automation-bot-login"),
      automationId: args.get("automation-bot-id"),
      installedModes: args
        .get("installed-modes", "review,maintain,issues,fix")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      modePlanPath: args.get("mode-plan"),
      configPath: args.get("config"),
      ...(await agentProfileInputs(args, toolingSha)),
    });
  }
  throw new Error(`Unknown stage phase: ${phase}`);
}

const KNOWN_FLAGS = new Set([
  "actor",
  "agent-profile",
  "agent-profile-source",
  "agent-profile-source-sha",
  "artifact",
  "authorization-mode",
  "automation-bot-id",
  "automation-bot-login",
  "candidate",
  "command-context",
  "config",
  "context",
  "directory",
  "dry-run",
  "event",
  "expected-candidate-sha",
  "expected-context-sha",
  "expected-head",
  "expected-manifest-sha",
  "expected-handoff-manifest-sha",
  "expected-base-sha",
  "mode-plan",
  "operation",
  "app-contents-permission",
  "app-issues-permission",
  "app-pull-requests-permission",
  "app-slug",
  "api-url",
  "installed-modes",
  "mode",
  "mutation-authorized",
  "patch",
  "repair-authorized",
  "result",
  "review-thread-ids",
  "source-config",
  "default-branch",
  "target-number",
  "token",
  "tooling-sha",
  "triage-mode",
  "workspace-result",
  "workspace-patch",
]);

async function applyUntrustedWorkspacePatch(patchPath) {
  const patch = await readRegularFile(patchPath);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  if (!command) throw new Error("A command is required");
  args.assertKnown(KNOWN_FLAGS);
  const sealedPublishCommands = new Set([
    "publish-review",
    "publish-audit",
    "publish-issue",
    "publish-fix",
  ]);
  const artifactDirectory = args.get("artifact")
    ? assertRunnerOwnedDirectory(args.get("artifact"))
    : sealedPublishCommands.has(command)
      ? assertRunnerOwnedDirectory(args.require("artifact"))
      : null;
  const configPath = sealedPublishCommands.has(command)
    ? args.require("config")
    : args.get("config", ".github/codekeeper.json");
  if (
    command === "stage" &&
    args.positional[1] === "compute" &&
    args.get("operation") === "prepare" &&
    args.get("source-config")
  ) {
    await prepareTrustedConfig({
      source: path.resolve(args.get("source-config")),
      destination: path.resolve(configPath),
      expectedBranch: args.require("default-branch"),
    });
  }
  const { config, path: loadedConfigPath } = await loadConfig(configPath);
  const configSha256 = sha256(await readFile(loadedConfigPath));
  const usesRunnerDirectory =
    command.startsWith("prepare-") ||
    command.startsWith("validate-") ||
    command === "run-agent" ||
    command === "run-workspace-agent" ||
    command === "capture-workspace-patch";
  const directory = usesRunnerDirectory
    ? assertRunnerOwnedDirectory(args.require("directory"))
    : null;
  const token = args.get("token", process.env.GITHUB_TOKEN);
  const contextPath = directory
    ? bundleFile(
        directory,
        args.get("context", path.join(directory, "context.json")),
        "context",
      )
    : null;
  const dryRun = args.boolean("dry-run", false);
  const toolingSha = args.get(
    "tooling-sha",
    process.env.CODEKEEPER_TOOLING_SHA ?? "",
  );
  const expectedManifestSha256 =
    sealedPublishCommands.has(command) ||
    (command === "stage" &&
      args.positional[1] === "publish" &&
      args.get("operation") === "command")
      ? args.require("expected-manifest-sha")
      : undefined;

  let result;
  switch (command) {
    case "stage":
      result = await runStageCommand({
        args,
        phase: args.positional[1],
        config,
        configSha256,
        toolingSha,
        token,
        dryRun,
      });
      break;
    case "check-config":
      result = { valid: true, version: config.version };
      break;
    case "owner-command":
      result = await runOwnerCommand({
        eventPath: args.require("event"),
        config,
        token,
        automationIdentity: {
          login: args.require("automation-bot-login"),
          id: args.require("automation-bot-id"),
        },
        installedModes: args
          .get("installed-modes", "review,maintain,issues,fix")
          .split(",")
          .map((mode) => mode.trim())
          .filter(Boolean),
      });
      break;
    case "agent-settings":
      {
        const mode = args.require("mode");
        result = getAgentRuntimeSettings(config, mode, {
          mutationAuthorized: ["audit", "fix"].includes(mode)
            ? strictBoolean(
                args.get("mutation-authorized", "false"),
                "mutation-authorized",
              )
            : false,
        });
      }
      break;
    case "run-agent":
      result = await runAgentFromBundle({
        mode: args.require("mode"),
        directory,
        config,
        resultPath: bundleFile(directory, args.require("result"), "result"),
        workspaceResultPath: args.get("workspace-result")
          ? runnerFile(args.get("workspace-result"), "workspace-result")
          : undefined,
      });
      break;
    case "run-workspace-agent":
      result = await runWorkspaceAgentFromBundle({
        mode: args.require("mode"),
        directory,
        config,
        resultPath: bundleFile(directory, args.require("result"), "result"),
      });
      break;
    case "capture-workspace-patch":
      {
        const context = await readJson(contextPath);
        const expectedHead = String(context.baseSha ?? "").trim();
        const actualHead = currentHead();
        if (!expectedHead || actualHead !== expectedHead) {
          throw new Error(
            `Workspace checkout HEAD ${actualHead} does not match frozen context.baseSha ${expectedHead || "missing"}`,
          );
        }
      }
      result = await createPatch(
        bundleFile(directory, args.require("patch"), "patch"),
        process.cwd(),
        config.audit.repair,
      );
      break;
    case "apply-workspace-patch":
      await applyUntrustedWorkspacePatch(
        runnerFile(args.require("patch"), "patch"),
      );
      result = { applied: true };
      break;
    case "prepare-review":
      result = await prepareReview({
        eventPath: args.require("event"),
        directory,
        config,
        token,
        toolingSha,
        configSha256,
        ...(await agentProfileInputs(args, toolingSha)),
      });
      break;
    case "prepare-audit":
      result = await prepareAudit({
        directory,
        config,
        toolingSha,
        configSha256,
        actor: args.require("actor"),
        repairAuthorized: strictBoolean(
          args.require("repair-authorized"),
          "repair-authorized",
        ),
        ...(await agentProfileInputs(args, toolingSha)),
      });
      break;
    case "prepare-issue":
      result = await prepareIssue({
        eventPath: args.require("event"),
        actor: args.require("actor"),
        triageMode: args.require("triage-mode"),
        directory,
        config,
        token,
        toolingSha,
        configSha256,
        ...(await agentProfileInputs(args, toolingSha)),
      });
      break;
    case "prepare-fix":
      result = await prepareFix({
        targetNumber: integer(args.require("target-number"), "target-number"),
        actor: args.require("actor"),
        authorizationMode: args.get("authorization-mode", "owner"),
        expectedHead: args.get("expected-head", ""),
        reviewThreadIds: stringList(
          args.get("review-thread-ids", ""),
          "review-thread-ids",
        ),
        directory,
        config,
        token,
        toolingSha,
        configSha256,
        ...(await agentProfileInputs(args, toolingSha)),
      });
      break;
    case "validate-review":
      result = await validateReview({
        directory,
        contextPath,
        resultPath: bundleFile(directory, args.require("result"), "result"),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        config,
        configSha256,
      });
      break;
    case "validate-audit":
      result = await validateAudit({
        directory,
        contextPath,
        resultPath: bundleFile(directory, args.require("result"), "result"),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        config,
        configSha256,
      });
      break;
    case "validate-issue":
      result = await validateIssue({
        directory,
        contextPath,
        resultPath: bundleFile(directory, args.require("result"), "result"),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        config,
        configSha256,
      });
      break;
    case "validate-fix":
      result = await validateFix({
        directory,
        contextPath,
        resultPath: bundleFile(directory, args.require("result"), "result"),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        config,
        configSha256,
        targetNumber: integer(args.require("target-number"), "target-number"),
      });
      break;
    case "seal-review":
      result = await sealReview({
        candidateDirectory: assertRunnerOwnedDirectory(
          args.require("candidate"),
        ),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        expectedContextSha256: args.require("expected-context-sha"),
        config,
        configSha256,
      });
      break;
    case "seal-audit":
      result = await sealAudit({
        candidateDirectory: assertRunnerOwnedDirectory(
          args.require("candidate"),
        ),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        expectedContextSha256: args.require("expected-context-sha"),
        config,
        configSha256,
      });
      break;
    case "seal-issue":
      result = await sealIssue({
        candidateDirectory: assertRunnerOwnedDirectory(
          args.require("candidate"),
        ),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        expectedContextSha256: args.require("expected-context-sha"),
        config,
        configSha256,
      });
      break;
    case "seal-fix":
      result = await sealFix({
        candidateDirectory: assertRunnerOwnedDirectory(
          args.require("candidate"),
        ),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        expectedContextSha256: args.require("expected-context-sha"),
        config,
        configSha256,
      });
      break;
    case "verify-audit":
      result = await verifyAudit({
        candidateDirectory: assertRunnerOwnedDirectory(
          args.require("candidate"),
        ),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        config,
        configSha256,
      });
      break;
    case "verify-fix":
      result = await verifyFix({
        candidateDirectory: assertRunnerOwnedDirectory(
          args.require("candidate"),
        ),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        config,
        configSha256,
      });
      break;
    case "publish-review":
      result = await publishReview({
        artifactDirectory,
        config,
        configSha256,
        expectedManifestSha256,
        ...(await agentProfileInputs(args, toolingSha)),
        token,
        dryRun,
      });
      break;
    case "publish-audit":
      result = await publishAudit({
        artifactDirectory,
        config,
        configSha256,
        expectedManifestSha256,
        ...(await agentProfileInputs(args, toolingSha)),
        token,
        dryRun,
      });
      break;
    case "publish-issue":
      result = await publishIssue({
        artifactDirectory,
        config,
        configSha256,
        expectedManifestSha256,
        ...(await agentProfileInputs(args, toolingSha)),
        token,
        dryRun,
      });
      break;
    case "publish-fix":
      result = await publishFix({
        artifactDirectory,
        config,
        configSha256,
        expectedManifestSha256,
        ...(await agentProfileInputs(args, toolingSha)),
        token,
        dryRun,
      });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  await setGitHubOutput("result", JSON.stringify(result));
  if (command === "agent-settings") {
    for (const [name, value] of Object.entries(result)) {
      const outputName = name.replace(
        /[A-Z]/g,
        (character) => `_${character.toLowerCase()}`,
      );
      await setGitHubOutput(outputName, value);
    }
  }
  if (result?.candidateSha256)
    await setGitHubOutput("candidate_sha256", result.candidateSha256);
  if (result?.manifestSha256)
    await setGitHubOutput("manifest_sha256", result.manifestSha256);
  if (result?.handoffManifestSha256)
    await setGitHubOutput(
      "handoff_manifest_sha256",
      result.handoffManifestSha256,
    );
  if (result?.contextSha256)
    await setGitHubOutput("context_sha256", result.contextSha256);
  if (result?.login) await setGitHubOutput("login", result.login);
  if (result?.id !== undefined) await setGitHubOutput("id", result.id);
  log(`${command} completed`);

  if (
    (command === "publish-review" ||
      (command === "stage" &&
        args.positional[1] === "publish" &&
        args.get("mode") === "review")) &&
    result.blocking
  ) {
    throw new Error(
      "Codekeeper review found blocking findings for the current pull request head",
    );
  }
}

export function runCli() {
  return main().catch((error) => {
    console.error(
      `::error::${workflowCommandValue(error.stack || error.message)}`,
    );
    if (isProviderCleanupTimeout(error)) process.exit(1);
    process.exitCode = 1;
  });
}
