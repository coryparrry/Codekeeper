import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommandRunner, resolveRepositoryBoundary, sanitizedEnvironment } from "./command-runner.mjs";
import { PACKAGE_NAME } from "./constants.mjs";
import { InstallerError } from "./errors.mjs";
import { RELEASE_VERSION, validSha512Integrity } from "./package-release.mjs";

const NPM_TIMEOUT_MS = 5 * 60 * 1000;
const NPM_ENV_NAMES = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "NPM_CONFIG_CACHE", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_CAFILE", "NPM_CONFIG_STRICT_SSL",
  "npm_config_cache", "npm_config_userconfig", "npm_config_registry",
  "npm_config_proxy", "npm_config_https_proxy", "npm_config_cafile", "npm_config_strict_ssl"
]);
const DEFAULT_FILE_SYSTEM = Object.freeze({ access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat });

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isNpmCliPath(target) {
  const normalized = target.replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith("/node_modules/npm/bin/npm-cli.js")
    || normalized.endsWith("/corepack/dist/npm.js");
}

async function verifiedNpmCli(candidate, repositoryRoot, fsImpl) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  try {
    const resolved = await fsImpl.realpath(candidate);
    const metadata = await fsImpl.stat(resolved);
    if (!metadata.isFile() || isWithin(repositoryRoot, resolved) || !isNpmCliPath(resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function pathEntries(environment, platform) {
  const pathValue = platform === "win32"
    ? environment.Path ?? environment.PATH ?? ""
    : environment.PATH ?? "";
  return String(pathValue).split(platform === "win32" ? ";" : path.delimiter).filter((entry) => path.isAbsolute(entry));
}

export async function resolveNpmCliPath({
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  fsImpl = DEFAULT_FILE_SYSTEM
} = {}) {
  const repositoryRoot = await resolveRepositoryBoundary({ cwd, fsImpl });
  const explicit = await verifiedNpmCli(environment.npm_execpath, repositoryRoot, fsImpl);
  if (explicit) return explicit;
  const executableNames = platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  for (const directory of pathEntries(environment, platform)) {
    for (const executableName of executableNames) {
      const executable = path.join(directory, executableName);
      const direct = await verifiedNpmCli(executable, repositoryRoot, fsImpl);
      if (direct) return direct;
      const sibling = await verifiedNpmCli(path.join(directory, "node_modules", "npm", "bin", "npm-cli.js"), repositoryRoot, fsImpl);
      if (sibling) return sibling;
    }
  }
  throw new InstallerError("Could not safely locate npm. Run the update through a trusted npm or npx installation.", {
    code: "NPM_UNAVAILABLE"
  });
}

function updateEnvironment(environment, platform, expectedVersion, expectedIntegrity) {
  const updated = { ...sanitizedEnvironment(environment, { platform }) };
  for (const name of NPM_ENV_NAMES) {
    if (typeof environment[name] === "string") updated[name] = environment[name];
  }
  updated.CODEKEEPER_UPDATE_EXPECTED_VERSION = expectedVersion;
  if (expectedIntegrity !== undefined) updated.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY = expectedIntegrity;
  updated.npm_config_audit = "false";
  updated.npm_config_fund = "false";
  updated.npm_config_ignore_scripts = "true";
  updated.npm_config_prefer_online = "true";
  updated.npm_config_yes = "true";
  return updated;
}

function requireCommandSuccess(result, message) {
  if (!result || result.status !== 0 || result.timedOut || result.truncated || typeof result.stdout !== "string") {
    throw new InstallerError(message, { code: "UPDATE_BOOTSTRAP_FAILED" });
  }
  return result.stdout.trim();
}

function failReleaseResolution(message) {
  throw new InstallerError(message, { code: "UPDATE_BOOTSTRAP_FAILED" });
}

function releaseSelector(value) {
  if (value === "latest") return value;
  if (typeof value === "string" && RELEASE_VERSION.test(value)) return value;
  failReleaseResolution("Codekeeper updates require the latest tag or an exact semantic version.");
}

function releaseReceipt(source, requestedVersion) {
  let metadata;
  try {
    metadata = JSON.parse(source);
  } catch {
    failReleaseResolution("npm returned invalid Codekeeper release metadata.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    failReleaseResolution("npm returned invalid Codekeeper release metadata.");
  }
  const version = metadata.version;
  const integrity = metadata.dist?.integrity ?? metadata["dist.integrity"];
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    failReleaseResolution("npm returned an invalid Codekeeper release version.");
  }
  if (!validSha512Integrity(integrity)) {
    failReleaseResolution("npm returned a missing or invalid Codekeeper release integrity.");
  }
  if (requestedVersion !== "latest" && version !== requestedVersion) {
    failReleaseResolution("npm returned a different Codekeeper release than the exact version requested.");
  }
  return Object.freeze({ version, integrity });
}

export async function verifyDownloadedTarball({ downloadRoot, reportSource, receipt, fsImpl = DEFAULT_FILE_SYSTEM }) {
  let report;
  try {
    report = JSON.parse(reportSource);
  } catch {
    failReleaseResolution("npm pack returned an invalid report.");
  }
  if (!Array.isArray(report) || report.length !== 1) failReleaseResolution("npm pack returned an invalid report.");
  const entry = report[0];
  if (
    entry?.name !== PACKAGE_NAME
    || entry.version !== receipt.version
    || entry.integrity !== receipt.integrity
    || typeof entry.filename !== "string"
    || path.basename(entry.filename) !== entry.filename
    || !entry.filename.endsWith(".tgz")
  ) {
    failReleaseResolution("npm pack did not return the exact Codekeeper release.");
  }
  const root = await fsImpl.realpath(downloadRoot);
  const requestedTarball = path.join(root, entry.filename);
  const metadata = await fsImpl.lstat(requestedTarball);
  const tarball = await fsImpl.realpath(requestedTarball);
  if (!isWithin(root, tarball) || metadata.isSymbolicLink() || !metadata.isFile()) {
    failReleaseResolution("npm pack returned an unsafe Codekeeper tarball.");
  }
  const actualIntegrity = `sha512-${createHash("sha512").update(await fsImpl.readFile(tarball)).digest("base64")}`;
  if (actualIntegrity !== receipt.integrity) {
    failReleaseResolution("The downloaded Codekeeper tarball does not match the resolved SHA-512 integrity.");
  }
  return tarball;
}

export async function stageVerifiedPackage({
  cwd,
  environment,
  platform,
  receipt,
  npmCli,
  runner,
  fsImpl = DEFAULT_FILE_SYSTEM,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  const root = await fsImpl.mkdtemp(path.join(temporaryDirectory, "codekeeper-update-"));
  try {
    const downloadRoot = path.join(root, "download");
    const installRoot = path.join(root, "install");
    await fsImpl.mkdir(downloadRoot, { recursive: true });
    await fsImpl.mkdir(installRoot, { recursive: true });
    const packResult = await runner.run("node", [
      npmCli,
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      downloadRoot,
      `${PACKAGE_NAME}@${receipt.version}`,
    ], {
      cwd,
      env: updateEnvironment(environment, platform, receipt.version, receipt.integrity),
      timeoutMs: NPM_TIMEOUT_MS,
    });
    const reportSource = requireCommandSuccess(packResult, "Could not download the exact Codekeeper release from npm.");
    const tarball = await verifyDownloadedTarball({ downloadRoot, reportSource, receipt, fsImpl });
    const installResult = await runner.run("node", [
      npmCli,
      "install",
      "--prefix",
      installRoot,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      tarball,
    ], {
      cwd,
      env: updateEnvironment(environment, platform, receipt.version, receipt.integrity),
      timeoutMs: NPM_TIMEOUT_MS,
    });
    requireCommandSuccess(installResult, "Could not install the verified Codekeeper release.");
    const packageRoot = await fsImpl.realpath(path.join(installRoot, "node_modules", PACKAGE_NAME));
    const requestedExecutable = path.join(packageRoot, "bin", "codekeeper.mjs");
    const executableStat = await fsImpl.lstat(requestedExecutable);
    const executable = await fsImpl.realpath(requestedExecutable);
    if (!isWithin(packageRoot, executable) || executableStat.isSymbolicLink() || !executableStat.isFile()) {
      failReleaseResolution("The verified Codekeeper release has an unsafe CLI entrypoint.");
    }
    return Object.freeze({ executable, root });
  } catch (error) {
    await fsImpl.rm(root, { force: true, recursive: true });
    throw error;
  }
}

export async function resolveNpmRelease({
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  version = "latest",
  requestedVersion,
  resolveNpm = resolveNpmCliPath,
  runner = createCommandRunner({ commandPaths: { node: process.execPath }, environment, platform })
} = {}) {
  const requested = releaseSelector(requestedVersion ?? version);
  const npmCli = await resolveNpm({ cwd, environment, platform });
  const metadataResult = await runner.run("node", [
    npmCli, "view", `${PACKAGE_NAME}@${requested}`, "version", "dist.integrity", "--json"
  ], {
    cwd,
    env: updateEnvironment(environment, platform, "resolving"),
    timeoutMs: NPM_TIMEOUT_MS
  });
  const metadataSource = requireCommandSuccess(metadataResult, "Could not resolve the Codekeeper release metadata from npm.");
  const receipt = releaseReceipt(metadataSource, requested);
  return Object.freeze({ npmCli, ...receipt });
}

export const resolvePackageRelease = resolveNpmRelease;

export async function runLatestCommand(command, {
  cwd = process.cwd(),
  output = process.stdout,
  environment = process.env,
  platform = process.platform,
  resolveNpm = resolveNpmCliPath,
  stagePackage = stageVerifiedPackage,
  fsImpl = DEFAULT_FILE_SYSTEM,
  runner = createCommandRunner({ commandPaths: { node: process.execPath }, environment, platform })
} = {}) {
  if (!new Set(["init", "update"]).has(command)) throw new TypeError("command must be init or update");
  output.write("Resolving the latest Codekeeper CLI and dependency release from npm...\n");
  const receipt = await resolveNpmRelease({
    cwd,
    environment,
    platform,
    resolveNpm,
    runner,
    version: "latest"
  });
  output.write(`Launching Codekeeper ${receipt.version} with its locked CLI dependencies...\n`);
  const staged = await stagePackage({
    cwd,
    environment,
    platform,
    receipt,
    npmCli: receipt.npmCli,
    runner,
    fsImpl,
  });
  try {
    const commandResult = await runner.run("node", [
      staged.executable,
      command,
      "--current-package",
      "--package-integrity",
      receipt.integrity,
    ], {
      cwd,
      env: updateEnvironment(environment, platform, receipt.version, receipt.integrity),
      stdio: "inherit",
      timeoutMs: NPM_TIMEOUT_MS
    });
    if (commandResult.status !== 0 || commandResult.timedOut) {
      throw new InstallerError(`The latest Codekeeper CLI did not complete ${command}.`, {
        code: "UPDATE_BOOTSTRAP_FAILED"
      });
    }
    return 0;
  } finally {
    await fsImpl.rm(staged.root, { force: true, recursive: true });
  }
}

export function runLatestUpdate(options = {}) {
  return runLatestCommand("update", options);
}

export function runLatestInit(options = {}) {
  return runLatestCommand("init", options);
}
