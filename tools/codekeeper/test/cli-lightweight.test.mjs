import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentRuntimeSettings, loadConfig } from "../src/lib/config.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");
const repositoryRoot = path.resolve(testDirectory, "../../..");
const cliPath = path.join(packageRoot, "src", "cli.mjs");
const heavyModulePath = path.join(packageRoot, "src", "cli-heavy.mjs");
const configPath = path.join(repositoryRoot, ".github", "codekeeper.json");
const heavyLoadMarkers = [
  "cli-heavy.mjs",
  "agents-runtime.mjs",
  "commands.mjs",
  "git.mjs",
  "prepare.mjs",
  "publish.mjs",
  "validate.mjs",
];

const loadHookSource = `import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

const logPath = process.env.CODEKEEPER_MODULE_LOAD_LOG;
registerHooks({
  load(url, context, nextLoad) {
    if (logPath) appendFileSync(logPath, \`\${url}\\n\`);
    return nextLoad(url, context);
  },
});
`;

function parseGitHubOutput(text) {
  const outputs = [];
  let remaining = text;
  while (remaining.length > 0) {
    const header = remaining.match(/^([^\n]+)<<([^\n]+)\n/);
    if (!header) {
      assert.equal(remaining, "", "GitHub output contained an unparseable trailer");
      break;
    }
    const [, name, delimiter] = header;
    remaining = remaining.slice(header[0].length);
    const end = remaining.indexOf(`\n${delimiter}\n`);
    assert.notEqual(end, -1, `unterminated GitHub output ${name}`);
    outputs.push([name, remaining.slice(0, end)]);
    remaining = remaining.slice(end + delimiter.length + 2);
  }
  return outputs;
}

async function runCli(args, { traceLoads = false, env = {}, cwd = repositoryRoot } = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-cli-lightweight-"));
  const loadLogPath = path.join(temporaryDirectory, "module-loads.log");
  const githubOutputPath = path.join(temporaryDirectory, "github-output");
  const hookPath = path.join(temporaryDirectory, "module-load-hook.mjs");
  await writeFile(loadLogPath, "", "utf8");
  await writeFile(hookPath, loadHookSource, "utf8");
  const nodeArgs = traceLoads
    ? ["--import", pathToFileURL(hookPath).href, cliPath, ...args]
    : [cliPath, ...args];
  try {
    const outcome = await new Promise((resolve, reject) => {
      const child = spawn("node", nodeArgs, {
        cwd,
        env: {
          ...process.env,
          ...env,
          GITHUB_OUTPUT: githubOutputPath,
          CODEKEEPER_MODULE_LOAD_LOG: loadLogPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const loads = traceLoads ? await readFile(loadLogPath, "utf8") : "";
    let githubOutput = "";
    try {
      githubOutput = await readFile(githubOutputPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { ...outcome, loads, githubOutput };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function assertDidNotEvaluateHeavy(loads) {
  for (const marker of heavyLoadMarkers) {
    assert.doesNotMatch(loads, new RegExp(marker.replaceAll(".", "\\.")), `${marker} was evaluated`);
  }
}

function assertEvaluatedHeavy(loads) {
  assert.match(loads, /cli-heavy\.mjs/);
  for (const marker of heavyLoadMarkers.slice(1)) {
    assert.match(loads, new RegExp(marker.replaceAll(".", "\\.")), `${marker} was not evaluated`);
  }
}

test("check-config does not evaluate the heavy CLI module", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.doesNotMatch(source, /^import .*agents-runtime/m);
  assert.doesNotMatch(source, /^import .*\/commands\.mjs/m);
  assert.doesNotMatch(source, /^import .*\/git\.mjs/m);
  assert.doesNotMatch(source, /^import .*\/prepare\.mjs/m);
  assert.doesNotMatch(source, /^import .*\/publish\.mjs/m);
  assert.doesNotMatch(source, /^import .*\/validate\.mjs/m);
  assert.match(source, /import\("\.\/cli-heavy\.mjs"\)/);

  const outcome = await runCli(["check-config", "--config", configPath], { traceLoads: true });
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0);
  assertDidNotEvaluateHeavy(outcome.loads);
});

test("agent-settings does not evaluate the heavy CLI module", async () => {
  const outcome = await runCli(["agent-settings", "--mode", "review", "--config", configPath], {
    traceLoads: true,
  });
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0);
  assertDidNotEvaluateHeavy(outcome.loads);
});

test("a normal heavy command evaluates the heavy CLI module", async () => {
  const outcome = await runCli(["prepare-review", "--config", configPath], { traceLoads: true });
  assert.equal(outcome.signal, null);
  assert.notEqual(outcome.code, 0);
  assert.match(outcome.stderr, /Missing required argument --directory/);
  assertEvaluatedHeavy(outcome.loads);
});

test("check-config output is byte-for-byte compatible", async () => {
  const { config } = await loadConfig(configPath);
  const outcome = await runCli(["check-config", "--config", configPath]);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout, "[codekeeper] check-config completed\n");
  assert.equal(outcome.stderr, "");
  assert.deepEqual(parseGitHubOutput(outcome.githubOutput), [
    ["result", JSON.stringify({ valid: true, version: config.version })],
  ]);
});

test("agent-settings output is byte-for-byte compatible", async () => {
  const { config } = await loadConfig(configPath);
  const settings = getAgentRuntimeSettings(config, "review", { mutationAuthorized: false });
  const outcome = await runCli(["agent-settings", "--mode", "review", "--config", configPath]);
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout, "[codekeeper] agent-settings completed\n");
  assert.equal(outcome.stderr, "");
  const expected = [["result", JSON.stringify(settings)]];
  for (const [name, value] of Object.entries(settings)) {
    const outputName = name.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
    expected.push([outputName, value === undefined || value === null ? "" : String(value)]);
  }
  assert.deepEqual(parseGitHubOutput(outcome.githubOutput), expected);
});

test("unknown commands still use the existing error path", async () => {
  const unknown = await runCli(["not-a-command", "--config", configPath], { traceLoads: true });
  assert.equal(unknown.signal, null);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /^::error::Error: Unknown command: not-a-command/);
  assertEvaluatedHeavy(unknown.loads);

  const missingConfig = await runCli([
    "not-a-command",
    "--config",
    path.join(os.tmpdir(), "codekeeper-missing-policy.json"),
  ]);
  assert.equal(missingConfig.signal, null);
  assert.equal(missingConfig.code, 1);
  assert.doesNotMatch(missingConfig.stderr, /Unknown command/);
  assert.match(missingConfig.stderr, /^::error::Error: ENOENT: no such file or directory, open /);
});
