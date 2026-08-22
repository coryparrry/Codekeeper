import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRuntimeArchive,
  RUNTIME_ARCHIVE_MANIFEST_PATH,
  RUNTIME_ARCHIVE_MANIFEST_SOURCE_PATH,
  RUNTIME_ARCHIVE_PATH,
  RUNTIME_ARCHIVE_SOURCE_PATH,
} from "./runtime-archive.mjs";
import { validSha512Integrity } from "./package-release.mjs";

const NPM_CI_ARGS = Object.freeze(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
const NPM_PACK_ARGS = Object.freeze(["pack", "--json", "--ignore-scripts"]);
const PLATFORM_PACKAGE = /^node_modules\/@openai\/codex-(linux|darwin|win32)-(x64|arm64)$/;

function fail(message, cause) {
  throw new Error(`Codekeeper prebuilt runtime: ${message}`, cause ? { cause } : undefined);
}

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function npmCpu(arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  fail(`unsupported CPU architecture ${arch}`);
}

function npmOs(platform) {
  if (platform === "linux" || platform === "darwin" || platform === "win32") return platform;
  fail(`unsupported operating system ${platform}`);
}

export function isPlatformSpecificLockEntry(metadata) {
  return Array.isArray(metadata?.os) || Array.isArray(metadata?.cpu);
}

export function platformSpecificLockPrefixes(lock) {
  return Object.entries(lock?.packages ?? {})
    .filter(([key, metadata]) => key.startsWith("node_modules/") && isPlatformSpecificLockEntry(metadata))
    .map(([key]) => key)
    .sort();
}

export function matchingPlatformLockEntries(lock, { platform = process.platform, arch = process.arch } = {}) {
  const osName = npmOs(platform);
  const cpuName = npmCpu(arch);
  return Object.entries(lock?.packages ?? {})
    .filter(([key, metadata]) => {
      if (!key.startsWith("node_modules/") || !isPlatformSpecificLockEntry(metadata)) return false;
      if (Array.isArray(metadata.os) && !metadata.os.includes(osName)) return false;
      if (Array.isArray(metadata.cpu) && !metadata.cpu.includes(cpuName)) return false;
      return true;
    })
    .map(([key, metadata]) => ({ key, metadata }));
}

function parseLock(bytes, label) {
  try {
    const lock = JSON.parse(bytes.toString("utf8"));
    if (!lock || typeof lock !== "object" || !lock.packages || typeof lock.packages !== "object") {
      fail(`${label} is invalid`);
    }
    return lock;
  } catch (cause) {
    if (cause?.message?.startsWith("Codekeeper prebuilt runtime:")) throw cause;
    fail(`${label} is not valid JSON`, cause);
  }
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function assertInstalledLockfileInventory(runtimeRoot, lock) {
  for (const [key, metadata] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/")) continue;
    if (isPlatformSpecificLockEntry(metadata)) continue;
    const exists = await pathExists(path.join(runtimeRoot, ...key.split("/")));
    if (!exists && metadata.optional) continue;
    if (!exists) fail(`installed inventory is missing ${key}`);
  }
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function defaultRunCommand(command, args, options) {
  const result = await runProcess(command, args, options);
  if (result.status !== 0 || result.signal !== null) {
    fail(`${command} exited with ${result.signal ?? result.status}`);
  }
  return result;
}

export async function skipRuntimeDependencyInstall({ runtimeRoot }) {
  return runtimeRoot;
}

export async function installLockedRuntimeDependencies({
  runtimeRoot,
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  environment = process.env,
  runCommand = defaultRunCommand,
} = {}) {
  const lockPath = path.join(runtimeRoot, "package-lock.json");
  const lockBytes = await readFile(lockPath);
  const lock = parseLock(lockBytes, "runtime lockfile");
  await runCommand(npmCommand, [...NPM_CI_ARGS], { cwd: runtimeRoot, env: environment });
  const lockAfter = await readFile(lockPath);
  if (!lockBytes.equals(lockAfter)) fail("npm ci mutated the runtime lockfile");
  await assertInstalledLockfileInventory(runtimeRoot, lock);
  return runtimeRoot;
}

export async function buildPrebuiltRuntimeArchive({
  stagedRuntimeRoot,
  installRuntimeDependencies = installLockedRuntimeDependencies,
} = {}) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-prebuilt-runtime-"));
  const installedRuntime = path.join(temporaryRoot, "runtime");
  try {
    await cp(stagedRuntimeRoot, installedRuntime, { recursive: true, errorOnExist: true });
    await installRuntimeDependencies({ runtimeRoot: installedRuntime });
    const lock = parseLock(await readFile(path.join(installedRuntime, "package-lock.json")), "runtime lockfile");
    const { archiveBytes, manifest } = await createRuntimeArchive(installedRuntime, {
      skipPrefixes: platformSpecificLockPrefixes(lock),
    });
    return { archiveBytes, manifest };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export function generatedRuntimeArchiveEntries({ archiveBytes, manifestSource }) {
  return [
    {
      path: RUNTIME_ARCHIVE_PATH,
      sourcePath: RUNTIME_ARCHIVE_SOURCE_PATH,
      role: "production",
      sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    },
    {
      path: RUNTIME_ARCHIVE_MANIFEST_PATH,
      sourcePath: RUNTIME_ARCHIVE_MANIFEST_SOURCE_PATH,
      role: "production",
      sha256: createHash("sha256").update(manifestSource).digest("hex"),
    },
  ];
}

export async function writeGeneratedRuntimeArchive(destination, { archiveBytes, manifest }) {
  const manifestSource = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(path.join(destination, "release"), { recursive: true });
  await writeFile(path.join(destination, ...RUNTIME_ARCHIVE_PATH.split("/")), archiveBytes, { flag: "wx" });
  await writeFile(path.join(destination, ...RUNTIME_ARCHIVE_MANIFEST_PATH.split("/")), manifestSource, { flag: "wx" });
  return generatedRuntimeArchiveEntries({ archiveBytes, manifestSource });
}

function packageSpec(metadata) {
  if (typeof metadata?.name !== "string" || typeof metadata?.version !== "string") {
    fail("platform package identity is missing from the lockfile");
  }
  return `${metadata.name}@${metadata.version}`;
}

function parsePackReport(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (cause) {
    fail("npm pack report is not valid JSON", cause);
  }
  const report = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
  if (report.length !== 1 || !report[0] || typeof report[0].filename !== "string") {
    fail("npm pack returned an invalid report");
  }
  if (path.basename(report[0].filename) !== report[0].filename || !report[0].filename.endsWith(".tgz")) {
    fail("npm pack returned an unsafe filename");
  }
  return report[0];
}

async function extractVerifiedTarball({ tarball, destination, runCommand }) {
  await mkdir(destination, { recursive: true });
  const listed = await runCommand("tar", ["-tzf", tarball]);
  const names = listed.stdout.split("\n").filter(Boolean);
  if (names.length === 0 || names.length !== new Set(names).size) fail("platform package archive inventory is invalid");
  for (const name of names) {
    const parts = name.split("/");
    if (!name.startsWith("package/") || name.startsWith("/") || name.includes("\\") || parts.some((part) => part === "." || part === ".." || part.startsWith("."))) {
      fail(`platform package archive contains an unsafe path: ${name}`);
    }
  }
  const extracted = await runCommand("tar", [
    "-xzf",
    tarball,
    "--strip-components=1",
    "-C",
    destination,
  ]);
  return extracted;
}

export async function installMatchingPlatformPackages({
  runtimeRoot,
  platform = process.platform,
  arch = process.arch,
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  environment = process.env,
  runCommand = defaultRunCommand,
} = {}) {
  const lock = parseLock(await readFile(path.join(runtimeRoot, "package-lock.json")), "runtime lockfile");
  const matches = matchingPlatformLockEntries(lock, { platform, arch });
  if (matches.length === 0) fail("the runtime lockfile does not declare a Codex package for this platform");
  const downloadRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-platform-package-"));
  try {
    for (const { key, metadata } of matches) {
      if (!PLATFORM_PACKAGE.test(key)) fail(`refusing to acquire unexpected platform package ${key}`);
      if (!validSha512Integrity(metadata.integrity ?? "")) fail(`platform package ${key} is missing sha512 integrity`);
      const destination = path.join(runtimeRoot, ...key.split("/"));
      if (await pathExists(destination)) fail(`platform package destination already exists: ${key}`);
      const packed = await runCommand(npmCommand, [...NPM_PACK_ARGS, "--pack-destination", downloadRoot, packageSpec(metadata)], {
        cwd: downloadRoot,
        env: environment,
      });
      const report = parsePackReport(packed.stdout);
      const tarball = path.join(downloadRoot, report.filename);
      const bytes = await readFile(tarball);
      if (sha512Integrity(bytes) !== metadata.integrity) fail(`platform package integrity mismatch: ${key}`);
      await extractVerifiedTarball({ tarball, destination, runCommand });
    }
  } catch (cause) {
    for (const { key } of matches) {
      await rm(path.join(runtimeRoot, ...key.split("/")), { force: true, recursive: true });
    }
    if (cause?.message?.startsWith("Codekeeper prebuilt runtime:")) throw cause;
    fail("the platform runtime package could not be installed.", cause);
  } finally {
    await rm(downloadRoot, { force: true, recursive: true });
  }
}
