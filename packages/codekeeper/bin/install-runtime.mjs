#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cp, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

function fail(message, cause) {
  throw new Error(`Codekeeper runtime installation failed: ${message}`, { cause });
}

async function requireDirectory(fsImpl, directory, label) {
  let information;
  try {
    information = await fsImpl.lstat(directory);
  } catch (cause) {
    fail(`${label} is missing.`, cause);
  }
  if (information.isSymbolicLink() || !information.isDirectory()) {
    fail(`${label} is not a regular directory.`);
  }
}

async function requireAbsent(fsImpl, target) {
  try {
    await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail("the runtime destination already exists.");
}

function runNpm(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0 && signal === null) resolve();
      else reject(new Error(`npm exited with ${signal ?? status}`));
    });
  });
}

export async function installRuntime({
  packageRoot = PACKAGE_ROOT,
  workspace = process.env.GITHUB_WORKSPACE,
  fsImpl = { cp, lstat, rm },
  runCommand = runNpm,
  platform = process.platform,
} = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || workspace.includes("\0")) {
    fail("GITHUB_WORKSPACE is invalid.");
  }
  const source = path.join(packageRoot, "runtime");
  const destination = path.join(workspace, "tooling", "codekeeper-runtime");
  await requireDirectory(fsImpl, workspace, "GitHub workspace");
  await requireDirectory(fsImpl, source, "verified package runtime");
  await requireAbsent(fsImpl, destination);
  try {
    await fsImpl.cp(source, destination, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    await runCommand(
      platform === "win32" ? "npm.cmd" : "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: destination, env: process.env },
    );
    return destination;
  } catch (cause) {
    await fsImpl.rm(destination, { force: true, recursive: true });
    fail("the locked dependency graph could not be installed.", cause);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  installRuntime().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
