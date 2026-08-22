#!/usr/bin/env node

import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installMatchingPlatformPackages } from "../src/prebuilt-runtime.mjs";
import {
  extractRuntimeArchive,
  RUNTIME_ARCHIVE_MANIFEST_PATH,
  RUNTIME_ARCHIVE_PATH,
} from "../src/runtime-archive.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

function fail(message, cause) {
  throw new Error(`Codekeeper runtime installation failed: ${message}`, cause ? { cause } : undefined);
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

async function requireRegularFile(fsImpl, file, label) {
  let information;
  try {
    information = await fsImpl.lstat(file);
  } catch (cause) {
    fail(`${label} is missing.`, cause);
  }
  if (information.isSymbolicLink() || !information.isFile()) {
    fail(`${label} is not a regular file.`);
  }
  return fsImpl.readFile(file);
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

export async function installRuntime({
  packageRoot = PACKAGE_ROOT,
  workspace = process.env.GITHUB_WORKSPACE,
  fsImpl = { lstat, readFile, rm },
  extractArchive = extractRuntimeArchive,
  installPlatformPackages = installMatchingPlatformPackages,
} = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || workspace.includes("\0")) {
    fail("GITHUB_WORKSPACE is invalid.");
  }
  const destination = path.join(workspace, "tooling", "codekeeper-runtime");
  await requireDirectory(fsImpl, workspace, "GitHub workspace");
  await requireDirectory(fsImpl, packageRoot, "verified package root");
  await requireAbsent(fsImpl, destination);
  const archiveBytes = await requireRegularFile(
    fsImpl,
    path.join(packageRoot, ...RUNTIME_ARCHIVE_PATH.split("/")),
    "prebuilt runtime archive",
  );
  const manifestSource = await requireRegularFile(
    fsImpl,
    path.join(packageRoot, ...RUNTIME_ARCHIVE_MANIFEST_PATH.split("/")),
    "prebuilt runtime archive manifest",
  );
  try {
    await extractArchive({ archiveBytes, manifestSource, destination });
    await installPlatformPackages({ runtimeRoot: destination });
    return destination;
  } catch (cause) {
    await fsImpl.rm(destination, { force: true, recursive: true });
    if (cause?.message?.startsWith("Codekeeper runtime installation failed:")) throw cause;
    fail("the prebuilt runtime could not be installed.", cause);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  installRuntime().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
