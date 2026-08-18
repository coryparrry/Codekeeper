#!/usr/bin/env node
import { getAgentRuntimeSettings, loadConfig } from "./lib/config.mjs";
import {
  log,
  parseArgs,
  setGitHubOutput,
  workflowCommandValue
} from "./lib/io.mjs";

const LIGHT_COMMANDS = new Set(["check-config", "agent-settings"]);

function strictBoolean(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

async function runLightCommand(command) {
  const args = parseArgs(process.argv.slice(2));
  args.assertKnown(["config", "mode", "mutation-authorized"]);
  const { config } = await loadConfig(args.get("config", ".github/codekeeper.json"));
  let result;
  if (command === "check-config") {
    result = { valid: true, version: config.version };
  } else {
    const mode = args.require("mode");
    result = getAgentRuntimeSettings(config, mode, {
      mutationAuthorized: ["audit", "fix"].includes(mode)
        ? strictBoolean(args.get("mutation-authorized", "false"), "mutation-authorized")
        : false
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
  const command = process.argv[2];
  if (LIGHT_COMMANDS.has(command)) {
    await runLightCommand(command);
    return;
  }
  await import("./cli-heavy.mjs");
}

main().catch((error) => {
  console.error(`::error::${workflowCommandValue(error.stack || error.message)}`);
  process.exitCode = 1;
});
