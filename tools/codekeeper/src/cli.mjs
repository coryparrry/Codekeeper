#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { getAgentRuntimeSettings, loadConfig } from "./lib/config.mjs";
import { log, parseArgs, readJson, readRegularFile, setGitHubOutput } from "./lib/io.mjs";
import { applyPatch, createPatch, currentHead } from "./lib/git.mjs";
import { prepareAudit, prepareFix, prepareIssue, prepareReview } from "./lib/prepare.mjs";
import { publishAudit, publishFix, publishIssue, publishReview } from "./lib/publish.mjs";
import { sealAudit, sealFix, sealIssue, sealReview, validateAudit, validateFix, validateIssue, validateReview, verifyAudit, verifyFix } from "./lib/validate.mjs";
import { assertRunnerOwnedDirectory } from "./lib/workspace.mjs";
import { sha256 } from "./lib/markers.mjs";
import { runAgentFromBundle } from "./lib/agents-runtime.mjs";
import { runOwnerCommand } from "./lib/commands.mjs";

function integer(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function strictBoolean(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
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
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

function bundleFile(directory, filePath, flag) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(directory, resolved);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === "..") {
    throw new Error(`--${flag} must be a file inside the runner-owned --directory`);
  }
  return resolved;
}

function runnerFile(filePath, flag) {
  const resolved = path.resolve(filePath);
  assertRunnerOwnedDirectory(path.dirname(resolved));
  return resolved;
}

function agentProfileInputs(args) {
  return {
    agentProfilePath: args.require("agent-profile"),
    agentProfileSourceSha: args.require("agent-profile-source-sha")
  };
}

async function applyUntrustedWorkspacePatch(patchPath) {
  const patch = await readRegularFile(patchPath);
  if (patch.length === 0) return;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-workspace-patch-"));
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
  const sealedPublishCommands = new Set(["publish-review", "publish-audit", "publish-issue", "publish-fix"]);
  const artifactDirectory = args.get("artifact")
    ? assertRunnerOwnedDirectory(args.get("artifact"))
    : sealedPublishCommands.has(command)
      ? assertRunnerOwnedDirectory(args.require("artifact"))
      : null;
  const configPath = sealedPublishCommands.has(command)
    ? args.require("config")
    : args.get("config", ".github/codekeeper.json");
  const { config, path: loadedConfigPath } = await loadConfig(configPath);
  const configSha256 = sha256(await readFile(loadedConfigPath));
  const usesRunnerDirectory = command.startsWith("prepare-") || command.startsWith("validate-") || command === "run-agent" || command === "capture-workspace-patch";
  const directory = usesRunnerDirectory
    ? assertRunnerOwnedDirectory(args.require("directory"))
    : null;
  const token = args.get("token", process.env.GITHUB_TOKEN);
  const contextPath = directory
    ? bundleFile(directory, args.get("context", path.join(directory, "context.json")), "context")
    : null;
  const dryRun = args.boolean("dry-run", false);
  const toolingSha = args.get("tooling-sha", process.env.CODEKEEPER_TOOLING_SHA ?? "");
  const expectedManifestSha256 = sealedPublishCommands.has(command) ? args.require("expected-manifest-sha") : undefined;

  let result;
  switch (command) {
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
          id: args.require("automation-bot-id")
        },
        installedModes: args.get("installed-modes", "review,maintain,issues,fix")
          .split(",")
          .map((mode) => mode.trim())
          .filter(Boolean)
      });
      break;
    case "agent-settings":
      {
        const mode = args.require("mode");
        result = getAgentRuntimeSettings(config, mode, {
          mutationAuthorized: mode === "audit"
            ? strictBoolean(args.get("mutation-authorized", "false"), "mutation-authorized")
            : true
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
          : undefined
      });
      break;
    case "capture-workspace-patch":
      {
        const context = await readJson(contextPath);
        const expectedHead = String(context.baseSha ?? "").trim();
        const actualHead = currentHead();
        if (!expectedHead || actualHead !== expectedHead) {
          throw new Error(`Workspace checkout HEAD ${actualHead} does not match frozen context.baseSha ${expectedHead || "missing"}`);
        }
      }
      result = await createPatch(bundleFile(directory, args.require("patch"), "patch"));
      break;
    case "apply-workspace-patch":
      await applyUntrustedWorkspacePatch(runnerFile(args.require("patch"), "patch"));
      result = { applied: true };
      break;
    case "prepare-review":
      result = await prepareReview({ eventPath: args.require("event"), directory, config, token, toolingSha, configSha256, ...agentProfileInputs(args) });
      break;
    case "prepare-audit":
      result = await prepareAudit({
        directory,
        config,
        toolingSha,
        configSha256,
        actor: args.require("actor"),
        repairAuthorized: strictBoolean(args.require("repair-authorized"), "repair-authorized"),
        ...agentProfileInputs(args)
      });
      break;
    case "prepare-issue":
      result = await prepareIssue({ eventPath: args.require("event"), actor: args.require("actor"), triageMode: args.require("triage-mode"), directory, config, token, toolingSha, configSha256, ...agentProfileInputs(args) });
      break;
    case "prepare-fix":
      result = await prepareFix({
        targetNumber: integer(args.require("target-number"), "target-number"),
        actor: args.require("actor"),
        authorizationMode: args.get("authorization-mode", "owner"),
        expectedHead: args.get("expected-head", ""),
        reviewThreadIds: stringList(args.get("review-thread-ids", ""), "review-thread-ids"),
        directory,
        config,
        token,
        toolingSha,
        configSha256,
        ...agentProfileInputs(args)
      });
      break;
    case "validate-review":
      result = await validateReview({ directory, contextPath, resultPath: bundleFile(directory, args.require("result"), "result"), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), config, configSha256 });
      break;
    case "validate-audit":
      result = await validateAudit({ directory, contextPath, resultPath: bundleFile(directory, args.require("result"), "result"), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), config, configSha256 });
      break;
    case "validate-issue":
      result = await validateIssue({ directory, contextPath, resultPath: bundleFile(directory, args.require("result"), "result"), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), config, configSha256 });
      break;
    case "validate-fix":
      result = await validateFix({
        directory,
        contextPath,
        resultPath: bundleFile(directory, args.require("result"), "result"),
        artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")),
        config,
        configSha256,
        targetNumber: integer(args.require("target-number"), "target-number")
      });
      break;
    case "seal-review":
      result = await sealReview({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "seal-audit":
      result = await sealAudit({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "seal-issue":
      result = await sealIssue({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "seal-fix":
      result = await sealFix({ candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")), artifactDirectory: assertRunnerOwnedDirectory(args.require("artifact")), expectedCandidateSha256: args.require("expected-candidate-sha"), expectedContextSha256: args.require("expected-context-sha"), config, configSha256 });
      break;
    case "verify-audit":
      result = await verifyAudit({
        candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        config,
        configSha256
      });
      break;
    case "verify-fix":
      result = await verifyFix({
        candidateDirectory: assertRunnerOwnedDirectory(args.require("candidate")),
        expectedCandidateSha256: args.require("expected-candidate-sha"),
        config,
        configSha256
      });
      break;
    case "publish-review":
      result = await publishReview({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath: args.require("agent-profile"), token, dryRun });
      break;
    case "publish-audit":
      result = await publishAudit({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath: args.require("agent-profile"), token, dryRun });
      break;
    case "publish-issue":
      result = await publishIssue({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath: args.require("agent-profile"), token, dryRun });
      break;
    case "publish-fix":
      result = await publishFix({ artifactDirectory, config, configSha256, expectedManifestSha256, agentProfilePath: args.require("agent-profile"), token, dryRun });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  await setGitHubOutput("result", JSON.stringify(result));
  if (command === "agent-settings") {
    for (const [name, value] of Object.entries(result)) {
      const outputName = name.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
      await setGitHubOutput(outputName, value);
    }
  }
  if (result?.candidateSha256) await setGitHubOutput("candidate_sha256", result.candidateSha256);
  if (result?.manifestSha256) await setGitHubOutput("manifest_sha256", result.manifestSha256);
  log(`${command} completed`);

  if (command === "publish-review" && result.blocking) {
    throw new Error("Codekeeper review found blocking findings for the current pull request head");
  }
}

main().catch((error) => {
  console.error(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
});
