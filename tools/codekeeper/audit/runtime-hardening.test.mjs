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

async function processExecutionState(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return "missing";
    throw error;
  }
  if (process.platform !== "linux") return "running";
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd >= 0 ? stat.slice(commandEnd + 2).split(" ", 1)[0] : "running";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function readFileWhenReady(filePath, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return readFile(filePath, "utf8");
}

test("validation commands cannot inherit Codekeeper provider credentials", async () => {
  const restoreModel = setEnvironment("CODEKEEPER_MODEL_API_KEY", "audit-canary-model");
  const restoreTrace = setEnvironment("CODEKEEPER_TRACE_API_KEY", "audit-canary-trace");
  const restoreAws = setEnvironment("AWS_SECRET_ACCESS_KEY", "audit-canary-aws");
  const restoreDatabase = setEnvironment("DATABASE_URL", "postgres://user:audit-canary@db.example/app");
  try {
    const results = await runValidationCommands([
      "test -n \"$PATH\" && test -z \"$CODEKEEPER_MODEL_API_KEY\" && test -z \"$CODEKEEPER_TRACE_API_KEY\" && test -z \"$AWS_SECRET_ACCESS_KEY\" && test -z \"$DATABASE_URL\""
    ]);
    assert.equal(results[0].success, true);
  } finally {
    restoreDatabase();
    restoreAws();
    restoreTrace();
    restoreModel();
  }
});

test("validation command output retains bounded tails", async () => {
  const script = [
    'process.stdout.write("o".repeat(16000) + "stdout-tail")',
    'process.stderr.write("e".repeat(16000) + "stderr-tail")'
  ].join(";");
  const [result] = await runValidationCommands([
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
  ]);
  assert.ok(Buffer.byteLength(result.stdout) <= 12000);
  assert.ok(Buffer.byteLength(result.stderr) <= 12000);
  assert.match(result.stdout, /stdout-tail$/);
  assert.match(result.stderr, /stderr-tail$/);
});

test("successful validation launchers clean up detached descendants", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-successful-validation-descendant-"));
  const fixturePath = path.join(directory, "successful-background.mjs");
  const sentinelPath = path.join(directory, "survived.txt");
  await writeFile(fixturePath, `
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "survived"), 400)`).replaceAll("`", "\\`")}], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  `);
  try {
    const results = await runValidationCommands([
      `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`
    ], repositoryRoot, { timeoutMs: 1_000 });
    assert.equal(results[0].success, true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(readFile(sentinelPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
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
      setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "escaped"), 1000);
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
    const started = Date.now();
    const validation = runValidationCommands([
      `${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)}`
    ], repositoryRoot, { timeoutMs: 500 }).then(
      () => null,
      (error) => error
    );
    descendantPid = Number(await readFileWhenReady(pidPath));
    const readyAt = Date.now();
    const error = await validation;
    assert.ok(error, "validation command unexpectedly succeeded");
    assert.match(error.message, /timed out after 500ms/);
    assert.ok(
      Date.now() - readyAt < 700,
      `supervisor escalation exceeded its bounded grace period after fixture readiness (${Date.now() - started}ms total)`
    );
    await new Promise((resolve) => setTimeout(resolve, 550));
    await assert.rejects(readFile(sentinelPath), { code: "ENOENT" });
    assert.ok(
      ["missing", "Z"].includes(await processExecutionState(descendantPid)),
      "detached descendant remained capable of execution"
    );
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
