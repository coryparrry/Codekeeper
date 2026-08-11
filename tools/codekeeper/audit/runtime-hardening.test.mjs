import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runValidationCommands } from "../src/lib/git.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function setEnvironment(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test("validation commands cannot inherit Codekeeper provider credentials", async () => {
  const restoreModel = setEnvironment("CODEKEEPER_MODEL_API_KEY", "audit-canary-model");
  const restoreTrace = setEnvironment("CODEKEEPER_TRACE_API_KEY", "audit-canary-trace");
  try {
    const results = await runValidationCommands([
      "test -z \"$CODEKEEPER_MODEL_API_KEY\" && test -z \"$CODEKEEPER_TRACE_API_KEY\""
    ]);
    assert.equal(results[0].success, true);
  } finally {
    restoreTrace();
    restoreModel();
  }
});

test("a hung validation command is terminated within the workflow budget", async () => {
  const gitModuleUrl = new URL("../src/lib/git.mjs", import.meta.url).href;
  const script = `import { runValidationCommands } from ${JSON.stringify(gitModuleUrl)}; await runValidationCommands(["trap '' TERM; sleep 2"], process.cwd(), { timeoutMs: 25 });`;
  const child = spawn("node", ["--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "ignore"]
  });
  const outcome = await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 750);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  assert.equal(outcome.timedOut, false, "validation execution exceeded its bounded deadline");
  assert.equal(outcome.signal, null, "validation execution was killed instead of failing closed");
  assert.notEqual(outcome.code, null, "validation execution did not report a bounded exit");
});

test("a hung model-provider turn is terminated within the workflow budget", async () => {
  const runtimeModuleUrl = new URL("../src/lib/agents-runtime.mjs", import.meta.url).href;
  const configPath = path.join(repositoryRoot, ".github/codekeeper.json");
  const script = `
    import { readFile } from "node:fs/promises";
    import { runConfiguredAgent } from ${JSON.stringify(runtimeModuleUrl)};
    const config = JSON.parse(await readFile(${JSON.stringify(configPath)}, "utf8"));
    config.ai.tracing.enabled = false;
    config.ai.agents.issue.maximumAttempts = 1;
    const sdkLoader = async () => ({
      Agent: class Agent {},
      OpenAIProvider: class OpenAIProvider {},
      Runner: class Runner {
        run(_agent, _input, options = {}) {
          return new Promise((resolve, reject) => {
            const keepAlive = setInterval(() => {}, 1000);
            options.signal?.addEventListener("abort", () => {
              clearInterval(keepAlive);
              reject(new Error("provider turn aborted"));
            }, { once: true });
          });
        }
      }
    });
    await runConfiguredAgent({
      mode: "issue",
      config,
      prompt: "audit",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { mode: { type: "string" }, summary: { type: "string" } },
        required: ["mode", "summary"]
      },
      specialistResult: {},
      apiKey: "audit-model-key",
      sdkLoader,
      profile: "Issue triager profile",
      turnTimeoutMs: 25
    });
  `;
  const child = spawn("node", ["--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "ignore"]
  });
  const outcome = await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 750);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  assert.equal(outcome.timedOut, false, "model-provider execution exceeded its bounded deadline");
  assert.equal(outcome.signal, null, "model-provider execution was killed instead of failing closed");
  assert.notEqual(outcome.code, null, "model-provider execution did not report a bounded exit");
});

test("CLI errors cannot inject additional GitHub workflow commands", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-cli-annotation-audit-"));
  try {
    const maliciousConfig = path.join(temporaryDirectory, "invalid\n::warning::injected.json");
    await writeFile(maliciousConfig, "{", "utf8");
    const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
    const outcome = await new Promise((resolve) => {
      const child = spawn("node", [cliPath, "check-config", "--config", maliciousConfig], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      child.once("close", (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 1);
    assert.doesNotMatch(outcome.stderr, /\n::/u, "an untrusted error line became a second workflow command");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("CLI rejects unknown flags before it can perform a live command", async () => {
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const outcome = await new Promise((resolve) => {
    const child = spawn("node", [cliPath, "check-config", "--dry-rnu", "true"], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  assert.equal(outcome.signal, null);
  assert.notEqual(outcome.code, 0, "a typo in a safety flag was silently accepted");
  assert.match(`${outcome.stdout}\n${outcome.stderr}`, /unknown|unsupported|unexpected|argument|flag/i);
});
