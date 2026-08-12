import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runConfiguredAgent } from "../src/lib/agents-runtime.mjs";
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

test("a validation descendant cannot escape the deadline in a new process group", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-validation-descendant-"));
  const fixturePath = path.join(directory, "escaped-descendant.mjs");
  const gitModuleUrl = new URL("../src/lib/git.mjs", import.meta.url).href;
  await writeFile(fixturePath, `
    import { spawn } from "node:child_process";
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], {
      detached: true,
      stdio: ["ignore", 1, 2]
    });
    setTimeout(() => {}, 2000);
  `);
  const validationCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`;
  const script = `import { runValidationCommands } from ${JSON.stringify(gitModuleUrl)}; await runValidationCommands([${JSON.stringify(validationCommand)}], process.cwd(), { timeoutMs: 25 });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "ignore"]
  });
  try {
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
    assert.equal(outcome.timedOut, false, "escaped validation descendant exceeded its bounded deadline");
    assert.equal(outcome.signal, null, "validation execution was killed instead of failing closed");
    assert.notEqual(outcome.code, null, "validation execution did not report a bounded exit");
  } finally {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exited validation launcher cannot leave a background session holding the deadline open", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-exited-validation-launcher-"));
  const fixturePath = path.join(directory, "background-session.mjs");
  const sentinelPath = path.join(directory, "escaped.txt");
  await writeFile(fixturePath, `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "escaped"), 400)`).replaceAll("`", "\\`")}], {
      detached: true,
      stdio: ["ignore", 1, 2]
    });
    child.unref();
  `);
  try {
    const started = Date.now();
    await assert.rejects(
      runValidationCommands([
        `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`
      ], repositoryRoot, { timeoutMs: 100 }),
      /timed out after 100ms/
    );
    assert.ok(Date.now() - started < 350, "background validation session held inherited pipes open");
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(readFile(sentinelPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validation escalation kills a detached descendant after launcher pipes close", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-validation-escalation-"));
  const fixturePath = path.join(directory, "detached-descendant.mjs");
  const pidPath = path.join(directory, "descendant.pid");
  const sentinelPath = path.join(directory, "escaped.txt");
  await writeFile(fixturePath, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
      process.on("SIGTERM", () => {});
      setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "escaped"), 400);
      setTimeout(() => {}, 2000);
    `).replaceAll("`", "\\`")}], {
      detached: true,
      stdio: "ignore"
    });
    writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
    child.unref();
    setTimeout(() => {}, 2000);
  `);
  let descendantPid;
  try {
    await assert.rejects(
      runValidationCommands([
        `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`
      ], repositoryRoot, { timeoutMs: 25 }),
      /timed out after 25ms/
    );
    descendantPid = Number(await readFile(pidPath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(readFile(sentinelPath), { code: "ENOENT" });
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    if (Number.isSafeInteger(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
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

test("model-provider cleanup cannot exceed the provider deadline", async () => {
  const config = JSON.parse(await readFile(path.join(repositoryRoot, ".github/codekeeper.json"), "utf8"));
  config.ai.tracing.enabled = false;
  config.ai.agents.issue.maximumAttempts = 1;
  const sdkLoader = async () => ({
    Agent: class Agent {},
    OpenAIProvider: class OpenAIProvider {
      close() { return new Promise(() => {}); }
    },
    Runner: class Runner {
      async run() { return { finalOutput: JSON.stringify({ mode: "issue", summary: "No action." }) }; }
    }
  });
  await assert.rejects(
    runConfiguredAgent({
      mode: "issue",
      config,
      prompt: "audit",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { mode: { type: "string" }, summary: { type: "string" } },
        required: ["mode", "summary"]
      },
      apiKey: "audit-model-key",
      sdkLoader,
      profile: "Issue triager profile",
      turnTimeoutMs: 25
    }),
    (error) => {
      assert.match(error.message, /provider cleanup timed out after 25ms/);
      assert.equal(error.code, "CODEKEEPER_PROVIDER_CLEANUP_TIMEOUT");
      return true;
    }
  );
});

test("provider cleanup timeout forces the CLI boundary to exit despite retained handles", async () => {
  const runtimeModuleUrl = new URL("../src/lib/agents-runtime.mjs", import.meta.url).href;
  const configPath = path.join(repositoryRoot, ".github/codekeeper.json");
  const script = `
    import { readFile } from "node:fs/promises";
    import { isProviderCleanupTimeout, runConfiguredAgent } from ${JSON.stringify(runtimeModuleUrl)};
    const config = JSON.parse(await readFile(${JSON.stringify(configPath)}, "utf8"));
    config.ai.tracing.enabled = false;
    config.ai.agents.issue.maximumAttempts = 1;
    const sdkLoader = async () => ({
      Agent: class Agent {},
      OpenAIProvider: class OpenAIProvider {
        constructor() { process.stdout.write("provider-started\\n"); }
        close() {
          setInterval(() => {}, 1000);
          return new Promise(() => {});
        }
      },
      Runner: class Runner {
        async run() { return { finalOutput: JSON.stringify({ mode: "issue", summary: "No action." }) }; }
      }
    });
    try {
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
        apiKey: "audit-model-key",
        sdkLoader,
        profile: "Issue triager profile",
        turnTimeoutMs: 25
      });
    } catch (error) {
      if (isProviderCleanupTimeout(error)) process.exit(1);
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
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
  assert.match(stdout, /provider-started/, "the provider fixture did not reach cleanup");
  assert.equal(outcome.timedOut, false, "provider-owned handles kept the CLI boundary alive");
  assert.equal(outcome.signal, null, "the cleanup fixture required an external kill");
  assert.equal(outcome.code, 1);
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
