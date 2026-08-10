import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCommandRunner, sanitizedEnvironment } from "../src/command-runner.mjs";
import { temporaryDirectory } from "./helpers.mjs";

test("Windows-safe environments retain command discovery and gh configuration without unrelated secrets", () => {
  const environment = sanitizedEnvironment({
    Path: "C:\\Program Files\\Git\\cmd;C:\\Program Files\\GitHub CLI",
    APPDATA: "C:\\Users\\Cory\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\Cory",
    SystemRoot: "C:\\Windows",
    OPENAI_API_KEY: "canary-never-forward"
  }, { platform: "win32" });
  assert.deepEqual(environment, {
    Path: "C:\\Program Files\\Git\\cmd;C:\\Program Files\\GitHub CLI",
    APPDATA: "C:\\Users\\Cory\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\Cory",
    SystemRoot: "C:\\Windows",
    GH_HOST: "github.com",
    GIT_TERMINAL_PROMPT: "0"
  });
});

async function writeCommandFiles(directory) {
  await mkdir(directory, { recursive: true });
  for (const command of ["git", "gh"]) {
    const executable = path.join(directory, command);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(executable, 0o700);
  }
}

function recordingRunner(environment, calls) {
  return createCommandRunner({
    environment,
    spawnImpl(command, args, options) {
      calls.push({ command, args: [...args], options: { ...options } });
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });
}

async function assertTrustedCommands({ runner, root, safeBin, calls }) {
  const trusted = await runner.resolveTrustedCommands({ cwd: root });
  assert.deepEqual(calls, [], "path resolution must not execute a repository command");
  await trusted.run("git", ["--version"], { cwd: root });
  await trusted.run("gh", ["secret", "set", "OPENAI_API_KEY"], { cwd: root, stdio: "ignore", timeoutMs: null });
  const resolvedSafeBin = await realpath(safeBin);
  assert.deepEqual(calls.map((call) => call.command), [path.join(resolvedSafeBin, "git"), path.join(resolvedSafeBin, "gh")]);
}

test("trusted command resolution rejects repository shadows and freezes absolute Git and gh paths", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-trusted-command-");
  const shadowBin = path.join(root, "node_modules", ".bin");
  const safeBin = await temporaryDirectory(t, "codekeeper-safe-command-");
  await writeCommandFiles(shadowBin);
  await writeCommandFiles(safeBin);
  await mkdir(path.join(root, ".git"));

  const calls = [];
  const runner = recordingRunner({
    PATH: `${shadowBin}${path.delimiter}${safeBin}`,
    HOME: root,
    OPENAI_API_KEY: "canary-never-forward"
  }, calls);

  await assertTrustedCommands({ runner, root, safeBin, calls });
  assert.ok(calls.every((call) => !call.command.startsWith(shadowBin)));
  assert.ok(calls.every((call) => !call.options.env.PATH.includes(shadowBin)));
  assert.ok(calls.every((call) => call.options.env.OPENAI_API_KEY === undefined));
  assert.ok(calls.every((call) => call.options.shell === false));
});

test("trusted command resolution rejects checkout PATH symlinks before canonicalization", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-checkout-path-");
  const escapedBin = await temporaryDirectory(t, "codekeeper-escaped-command-");
  const safeBin = await temporaryDirectory(t, "codekeeper-safe-command-");
  const checkoutSymlink = path.join(root, "escaped-bin");
  await mkdir(path.join(root, ".git"));
  await writeCommandFiles(escapedBin);
  await writeCommandFiles(safeBin);
  await symlink(escapedBin, checkoutSymlink);

  const calls = [];
  const runner = recordingRunner({ PATH: `${checkoutSymlink}${path.delimiter}${safeBin}`, HOME: root }, calls);
  await assertTrustedCommands({ runner, root, safeBin, calls });
  assert.ok(calls.every((call) => !call.command.startsWith(escapedBin)));
  assert.ok(calls.every((call) => !call.options.env.PATH.includes(escapedBin)));
});

test("case-variant checkout PATH symlinks are rejected before their final target is resolved", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-case-checkout-");
  const basename = path.basename(root);
  const index = basename.search(/[A-Za-z]/);
  assert.notEqual(index, -1, "temporary checkout name must contain a letter");
  const flipped = `${basename.slice(0, index)}${basename[index] === basename[index].toLowerCase() ? basename[index].toUpperCase() : basename[index].toLowerCase()}${basename.slice(index + 1)}`;
  const caseVariantRoot = path.join(path.dirname(root), flipped);
  try {
    const [actual, variant] = await Promise.all([lstat(root), lstat(caseVariantRoot)]);
    if (actual.dev !== variant.dev || actual.ino !== variant.ino) {
      t.skip("filesystem does not resolve case variants to the same checkout");
      return;
    }
  } catch {
    t.skip("filesystem is case-sensitive");
    return;
  }

  const escapedBin = await temporaryDirectory(t, "codekeeper-escaped-command-");
  const safeBin = await temporaryDirectory(t, "codekeeper-safe-command-");
  await mkdir(path.join(root, ".git"));
  await writeCommandFiles(escapedBin);
  await writeCommandFiles(safeBin);
  await symlink(escapedBin, path.join(root, "escaped-bin"));

  const calls = [];
  const runner = recordingRunner({ PATH: `${path.join(caseVariantRoot, "escaped-bin")}${path.delimiter}${safeBin}`, HOME: root }, calls);
  await assertTrustedCommands({ runner, root, safeBin, calls });
  assert.ok(calls.every((call) => !call.command.startsWith(escapedBin)));
});

test("a forged nested gitdir file cannot shrink the protected checkout boundary", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-forged-gitdir-");
  const nested = path.join(root, "nested");
  const shadowBin = path.join(root, "repository-bin");
  const safeBin = await temporaryDirectory(t, "codekeeper-safe-command-");
  await mkdir(path.join(root, ".git"));
  await mkdir(nested);
  await writeFile(path.join(nested, ".git"), "not a gitdir pointer\n");
  await writeCommandFiles(shadowBin);
  await writeCommandFiles(safeBin);

  const calls = [];
  const runner = recordingRunner({ PATH: `${shadowBin}${path.delimiter}${safeBin}`, HOME: root }, calls);
  await assertTrustedCommands({ runner, root: nested, safeBin, calls });
  assert.ok(calls.every((call) => !call.command.startsWith(shadowBin)));
});

test("trusted command resolution rejects global npm shims whose executable resolves below node_modules", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-global-npm-");
  const shimBin = await temporaryDirectory(t, "codekeeper-npm-shims-");
  const globalRoot = await temporaryDirectory(t, "codekeeper-global-npm-prefix-");
  const packageBin = path.join(globalRoot, "lib", "node_modules", "codekeeper-tools", "bin");
  const safeBin = await temporaryDirectory(t, "codekeeper-safe-command-");
  await mkdir(path.join(root, ".git"));
  await writeCommandFiles(packageBin);
  await writeCommandFiles(safeBin);
  for (const command of ["git", "gh"]) {
    await symlink(path.join(packageBin, command), path.join(shimBin, command));
  }

  const calls = [];
  const runner = recordingRunner({ PATH: `${shimBin}${path.delimiter}${safeBin}`, HOME: root }, calls);
  await assertTrustedCommands({ runner, root, safeBin, calls });
  assert.ok(calls.every((call) => !call.command.includes(`${path.sep}node_modules${path.sep}`)));
});

test("trusted command resolution preserves multi-call symlink identities after validating their targets", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-multicall-checkout-");
  const commandBin = await temporaryDirectory(t, "codekeeper-multicall-bin-");
  const dispatcherBin = await temporaryDirectory(t, "codekeeper-multicall-dispatcher-");
  await mkdir(path.join(root, ".git"));
  await writeCommandFiles(dispatcherBin);
  for (const command of ["git", "gh"]) {
    await symlink(path.join(dispatcherBin, command), path.join(commandBin, command));
  }

  const calls = [];
  const trusted = await recordingRunner({ PATH: commandBin, HOME: root }, calls)
    .resolveTrustedCommands({ cwd: root });
  await trusted.run("git", ["--version"], { cwd: root });
  await trusted.run("gh", ["--version"], { cwd: root });

  const resolvedCommandBin = await realpath(commandBin);
  assert.deepEqual(calls.map((call) => call.command), [
    path.join(resolvedCommandBin, "git"),
    path.join(resolvedCommandBin, "gh")
  ]);
});
