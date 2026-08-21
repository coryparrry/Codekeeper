import assert from "node:assert/strict";
import { lstat, writeFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { runCli as runProductionCli } from "../src/cli.mjs";
import { discoverNpmPackageLockPreparation } from "../src/preflight.mjs";
import { prepareNpmPackageLock } from "../src/package-lock-preparation.mjs";
import { HEAD_SHA, loadVerifiedAssets, result, testPackageEnvironment, textSink, temporaryDirectory } from "./helpers.mjs";

async function hasFile(target) {
  try {
    const stat = await lstat(target);
    return stat.isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function promptAnswers(answers) {
  const calls = [];
  return {
    calls,
    async confirm(options) {
      calls.push(options);
      return answers.shift();
    },
  };
}

function recordingRunner(root, { npmStatus = 0, writesLockfile = true, lockfileSource = "{\"lockfileVersion\": 3}\n" } = {}) {
  const calls = [];
  return {
    calls,
    async run(command, args, options) {
      calls.push({ command, args: [...args], options: { ...options } });
      if (command === process.execPath) {
        if (writesLockfile) await writeFile(path.join(root, "package-lock.json"), lockfileSource);
        return result("", { status: npmStatus });
      }
      return result("diff --git a/package-lock.json b/package-lock.json\n", { status: 1 });
    },
  };
}

async function packageRoot(t, packageJson) {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(packageJson)}\n`);
  return root;
}

function setupPrompt(answers) {
  const confirmations = [];
  return {
    confirmations,
    async confirm(options) {
      confirmations.push(options);
      return answers.shift();
    },
  };
}

function repositorySnapshot(root) {
  return Object.freeze({
    root,
    originUrl: "https://github.com/acme/widget.git",
    repository: "acme/widget",
    defaultBranch: "main",
    currentBranch: "main",
    headSha: HEAD_SHA,
    remoteDefaultSha: HEAD_SHA,
    viewerLogin: "cory",
    displayName: "widget",
  });
}

test("init prepares an unlocked npm repository after repository confirmation and before App setup", async (t) => {
  const root = await packageRoot(t, { scripts: { check: "npm run lint" } });
  const runner = recordingRunner(root);
  const prompt = setupPrompt([true, true, true, true]);
  const output = textSink();
  const errorOutput = textSink();
  const status = await runProductionCli({
    argv: ["init"],
    cwd: root,
    output,
    errorOutput,
    runner,
    prompt,
    interactive: true,
    environment: testPackageEnvironment(),
    loadAssets: loadVerifiedAssets,
    inspect: async () => repositorySnapshot(root),
    resolveNpm: async ({ cwd }) => {
      assert.equal(cwd, root);
      return "/trusted/node_modules/npm/bin/npm-cli.js";
    },
    showDoctor: false,
  });
  assert.equal(status, 1);
  assert.deepEqual(prompt.confirmations.map(({ message }) => message), [
    "Install into acme/widget on default branch main?",
    "Use the recommended starter setup?",
    "Create package-lock.json for Codekeeper validation?",
    "Keep generated package-lock.json in this checkout?",
  ]);
  assert.equal(runner.calls[0].command, process.execPath);
  assert.deepEqual(runner.calls[0].args, [
    "/trusted/node_modules/npm/bin/npm-cli.js",
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  assert.equal(runner.calls[0].options.cwd, root);
  assert.match(output.toString(), /Generated package-lock\.json diff/);
  assert.match(output.toString(), /Commit or merge package-lock\.json/);
  assert.match(errorOutput.toString(), /clean, current default-branch checkout/);
  assert.equal(prompt.confirmations.some(({ message }) => message === "Have you chosen or created the App, installed it on this repository, and downloaded its private key?"), false);
});

test("npm lockfile preparation detects only an unlocked root npm package with check or test", async (t) => {
  const root = await packageRoot(t, {
    packageManager: "npm@11.0.0",
    scripts: { test: "node --test", check: "npm run lint" },
  });
  assert.deepEqual(await discoverNpmPackageLockPreparation(root), {
    command: "npm run check",
    packageManager: "npm",
    lockfile: "package-lock.json",
    script: "check",
  });

  const pnpmRoot = await packageRoot(t, { packageManager: "pnpm@9.0.0", scripts: { test: "node --test" } });
  assert.equal(await discoverNpmPackageLockPreparation(pnpmRoot), null);
  for (const declaration of ["pnpm", "garbage", "npm", null, 42]) {
    const invalidRoot = await packageRoot(t, { packageManager: declaration, scripts: { test: "node --test" } });
    assert.equal(await discoverNpmPackageLockPreparation(invalidRoot), null, `invalid packageManager declaration: ${String(declaration)}`);
  }
  const noScriptRoot = await packageRoot(t, { scripts: { lint: "eslint ." } });
  assert.equal(await discoverNpmPackageLockPreparation(noScriptRoot), null);
  const lockedRoot = await packageRoot(t, { scripts: { test: "node --test" } });
  await writeFile(path.join(lockedRoot, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  assert.equal(await discoverNpmPackageLockPreparation(lockedRoot), null);
});

test("first decline does not invoke npm", async (t) => {
  const root = await packageRoot(t, { scripts: { test: "node --test" } });
  const runner = recordingRunner(root);
  const prompt = promptAnswers([false]);
  const prepared = await prepareNpmPackageLock({ root, runner, prompt, output: textSink() });
  assert.equal(prepared, false);
  assert.equal(runner.calls.length, 0);
  assert.equal(await hasFile(path.join(root, "package-lock.json")), false);
  assert.equal(prompt.calls[0].message, "Create package-lock.json for Codekeeper validation?");
});

test("npm preparation uses the exact command, displays the diff, and rolls back on second decline", async (t) => {
  const root = await packageRoot(t, { scripts: { test: "node --test" } });
  const runner = recordingRunner(root);
  const prompt = promptAnswers([true, false]);
  const output = textSink({ isTTY: false });
  const prepared = await prepareNpmPackageLock({ root, runner, prompt, output, npmCli: "/trusted/node_modules/npm/bin/npm-cli.js" });
  assert.equal(prepared, false);
  assert.deepEqual(runner.calls[0], {
    command: process.execPath,
    args: ["/trusted/node_modules/npm/bin/npm-cli.js", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    options: { cwd: root },
  });
  assert.equal(runner.calls.length, 1, "full diff presentation must not use bounded command capture");
  assert.match(output.toString(), /Generated package-lock\.json diff/);
  assert.match(output.toString(), /\+\{"lockfileVersion": 3\}/);
  assert.equal(await hasFile(path.join(root, "package-lock.json")), false);
});

test("npm preparation resolves a trusted npm CLI before invoking Node", async (t) => {
  const root = await packageRoot(t, { scripts: { test: "node --test" } });
  const runner = recordingRunner(root);
  const prompt = promptAnswers([true, true]);
  let resolverOptions;
  const prepared = await prepareNpmPackageLock({
    root,
    runner,
    prompt,
    output: textSink(),
    resolveNpm: async (options) => {
      resolverOptions = options;
      return "/trusted/node_modules/npm/bin/npm-cli.js";
    },
  });
  assert.equal(prepared, true);
  assert.equal(resolverOptions.cwd, root);
  assert.deepEqual(runner.calls[0].args, [
    "/trusted/node_modules/npm/bin/npm-cli.js",
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  assert.equal(runner.calls[0].command, process.execPath);
});

test("an Ink-style suspended review writes the diff to the visible output before its terminal confirmation", async (t) => {
  const root = await packageRoot(t, { scripts: { test: "node --test" } });
  const runner = recordingRunner(root);
  const prompt = promptAnswers([true]);
  prompt.kind = "ink";
  const secondPrompt = promptAnswers([true]);
  const output = textSink();
  let suspended = 0;
  assert.equal(await prepareNpmPackageLock({
    root,
    runner,
    prompt,
    secondPrompt,
    output,
    npmCli: "/trusted/node_modules/npm/bin/npm-cli.js",
    withInteractiveTerminal: async (callback) => {
      suspended += 1;
      return callback();
    },
  }), true);
  assert.equal(suspended, 1);
  assert.match(output.toString(), /Generated package-lock\.json diff/);
  assert.match(output.toString(), /diff --git a\/package-lock\.json/);
});

test("large generated lockfiles are shown in full before retention confirmation", async (t) => {
  const root = await packageRoot(t, { scripts: { test: "node --test" } });
  const source = `{"lockfileVersion":3,"marker":"${"x".repeat(128 * 1024 + 17)}"}\n`;
  const runner = recordingRunner(root, { lockfileSource: source });
  const output = textSink();
  assert.equal(await prepareNpmPackageLock({
    root,
    runner,
    prompt: promptAnswers([true, true]),
    output,
    npmCli: "/trusted/node_modules/npm/bin/npm-cli.js",
  }), true);
  const rendered = output.toString();
  assert.ok(rendered.length > source.length, "the diff should include the full generated file");
  assert.ok(rendered.includes("x".repeat(128 * 1024 + 17)), "the diff must include its final content");
});

test("second acceptance retains the lockfile and stops with rerun guidance", async (t) => {
  const root = await packageRoot(t, { scripts: { check: "npm run lint" } });
  const runner = recordingRunner(root);
  const prompt = promptAnswers([true, true]);
  const output = textSink();
  const prepared = await prepareNpmPackageLock({ root, runner, prompt, output, npmCli: "/trusted/node_modules/npm/bin/npm-cli.js" });
  assert.equal(prepared, true);
  assert.equal(await hasFile(path.join(root, "package-lock.json")), true);
  assert.match(output.toString(), /Commit or merge package-lock\.json/);
  assert.match(output.toString(), /clean, current default-branch checkout/);
});

test("npm failure cleans up a partial generated lockfile", async (t) => {
  const root = await packageRoot(t, { scripts: { test: "node --test" } });
  const runner = recordingRunner(root, { npmStatus: 1, writesLockfile: true });
  const prompt = promptAnswers([true]);
  await assert.rejects(
    prepareNpmPackageLock({ root, runner, prompt, output: textSink(), npmCli: "/trusted/node_modules/npm/bin/npm-cli.js" }),
    (error) => error?.code === "COMMAND_FAILED",
  );
  assert.equal(await hasFile(path.join(root, "package-lock.json")), false);
});

test("cancelling the second confirmation rolls back the generated lockfile", async (t) => {
  const root = await packageRoot(t, { scripts: { test: "node --test" } });
  const runner = recordingRunner(root);
  let confirmations = 0;
  const prompt = {
    async confirm() {
      confirmations += 1;
      if (confirmations === 1) return true;
      const error = new Error("cancelled");
      error.code = "PROMPT_ABORTED";
      throw error;
    },
  };
  assert.equal(await prepareNpmPackageLock({ root, runner, prompt, output: textSink(), npmCli: "/trusted/node_modules/npm/bin/npm-cli.js" }), false);
  assert.equal(await hasFile(path.join(root, "package-lock.json")), false);
});
