#!/usr/bin/env node
import { getAgentRuntimeSettings, loadConfig } from "./lib/config.mjs";
import {
  log,
  parseArgs,
  setGitHubOutput,
  workflowCommandValue,
} from "./lib/io.mjs";
import { assertRunnerOwnedDirectory } from "./lib/workspace.mjs";

const LIGHTWEIGHT_COMMANDS = new Set(["check-config", "agent-settings"]);

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
  "config",
  "context",
  "directory",
  "dry-run",
  "event",
  "expected-candidate-sha",
  "expected-context-sha",
  "expected-head",
  "expected-manifest-sha",
  "installed-modes",
  "mode",
  "mutation-authorized",
  "patch",
  "repair-authorized",
  "result",
  "review-thread-ids",
  "target-number",
  "token",
  "tooling-sha",
  "triage-mode",
  "workspace-result",
]);

function strictBoolean(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

async function runLightweightCommand(args, command) {
  args.assertKnown(KNOWN_FLAGS);
  if (args.get("artifact")) assertRunnerOwnedDirectory(args.get("artifact"));
  const { config } = await loadConfig(args.get("config", ".github/codekeeper.json"));

  let result;
  if (command === "check-config") {
    result = { valid: true, version: config.version };
  } else {
    const mode = args.require("mode");
    result = getAgentRuntimeSettings(config, mode, {
      mutationAuthorized: ["audit", "fix"].includes(mode)
        ? strictBoolean(args.get("mutation-authorized", "false"), "mutation-authorized")
        : false,
    });
  }

  await setGitHubOutput("result", JSON.stringify(result));
  if (command === "agent-settings") {
    for (const [name, value] of Object.entries(result)) {
      const outputName = name.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
      await setGitHubOutput(outputName, value);
    }
  }
  log(`${command} completed`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  if (!command) throw new Error("A command is required");
  if (LIGHTWEIGHT_COMMANDS.has(command)) {
    await runLightweightCommand(args, command);
    return;
  }
  const { runCli } = await import("./cli-heavy.mjs");
  await runCli();
}

main().catch((error) => {
  console.error(`::error::${workflowCommandValue(error.stack || error.message)}`);
  process.exitCode = 1;
});
