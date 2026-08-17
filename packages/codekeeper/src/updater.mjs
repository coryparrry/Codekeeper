import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommandRunner, resolveRepositoryBoundary, sanitizedEnvironment } from "./command-runner.mjs";
import { PACKAGE_NAME, RELEASE_MANIFEST_TARGET } from "./constants.mjs";
import { InstallerError } from "./errors.mjs";
import { RELEASE_VERSION, validSha512Integrity } from "./package-release.mjs";
import { parseReleaseManifest } from "./preflight.mjs";

const NPM_TIMEOUT_MS = 5 * 60 * 1000;
const NPM_ENV_NAMES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NPM_CONFIG_CACHE", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_CAFILE", "NPM_CONFIG_STRICT_SSL", "npm_config_cache", "npm_config_userconfig", "npm_config_registry", "npm_config_proxy", "npm_config_https_proxy", "npm_config_cafile", "npm_config_strict_ssl"]);
const DEFAULT_FILE_SYSTEM = Object.freeze({
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat
});

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isNpmCliPath(target) {
  const normalized = target.replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith("/node_modules/npm/bin/npm-cli.js") || normalized.endsWith("/corepack/dist/npm.js");
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
  const pathValue = platform === "win32" ? (environment.Path ?? environment.PATH ?? "") : (environment.PATH ?? "");
  return String(pathValue)
    .split(platform === "win32" ? ";" : path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
}

export async function resolveNpmCliPath({ cwd = process.cwd(), environment = process.env, platform = process.platform, fsImpl = DEFAULT_FILE_SYSTEM } = {}) {
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

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function parsedReleaseVersion(value) {
  if (typeof value !== "string" || !RELEASE_VERSION.test(value)) {
    failReleaseResolution("Codekeeper release comparison requires exact semantic versions.");
  }
  const withoutBuild = value.split("+", 1)[0];
  const prereleaseIndex = withoutBuild.indexOf("-");
  const core = (prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex)).split(".");
  const prerelease = prereleaseIndex === -1 ? [] : withoutBuild.slice(prereleaseIndex + 1).split(".");
  return { core, prerelease };
}

function compareReleaseVersions(left, right) {
  const a = parsedReleaseVersion(left);
  const b = parsedReleaseVersion(right);
  for (let index = 0; index < a.core.length; index += 1) {
    const compared = compareNumericIdentifier(a.core[index], b.core[index]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return compareNumericIdentifier(aPart, bPart);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

export async function installedReleaseVersion({ cwd = process.cwd(), fsImpl = DEFAULT_FILE_SYSTEM } = {}) {
  try {
    const root = await resolveRepositoryBoundary({ cwd, fsImpl });
    const requestedManifest = path.join(root, ...RELEASE_MANIFEST_TARGET.split("/"));
    const metadata = await fsImpl.lstat(requestedManifest);
    const manifestPath = await fsImpl.realpath(requestedManifest);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !isWithin(root, manifestPath)) {
      throw new Error("unsafe release manifest");
    }
    return parseReleaseManifest(await fsImpl.readFile(manifestPath, "utf8")).package.version;
  } catch (cause) {
    if (cause instanceof InstallerError && cause.code === "EXISTING_INSTALLATION_INVALID") throw cause;
    throw new InstallerError("Could not read a valid installed Codekeeper release manifest.", {
      code: "EXISTING_INSTALLATION_INVALID",
      cause
    });
  }
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

function normalizeNpmPackReport(report) {
  if (Array.isArray(report)) {
    if (report.length !== 1) failReleaseResolution("npm pack returned an invalid report.");
    return report[0];
  }
  if (!report || typeof report !== "object") failReleaseResolution("npm pack returned an invalid report.");
  const keys = Object.keys(report);
  const directReportFields = ["name", "version", "integrity", "filename"];
  if (directReportFields.every((field) => Object.hasOwn(report, field))) {
    if (Object.values(report).some((value) => value && typeof value === "object" && !Array.isArray(value))) {
      failReleaseResolution("npm pack returned an invalid report.");
    }
    return report;
  }
  if (keys.length !== 1) failReleaseResolution("npm pack returned an invalid report.");
  return report[keys[0]];
}

export async function verifyDownloadedTarball({ downloadRoot, reportSource, receipt, fsImpl = DEFAULT_FILE_SYSTEM }) {
  let report;
  try {
    report = JSON.parse(reportSource);
  } catch {
    failReleaseResolution("npm pack returned an invalid report.");
  }
  const entry = normalizeNpmPackReport(report);
  if (entry?.name !== PACKAGE_NAME || entry.version !== receipt.version || entry.integrity !== receipt.integrity || typeof entry.filename !== "string" || path.basename(entry.filename) !== entry.filename || !entry.filename.endsWith(".tgz")) {
    failReleaseResolution("npm pack did not return the exact Codekeeper release.");
  }
  const root = await fsImpl.realpath(downloadRoot);
  const requestedTarball = path.join(root, entry.filename);
  const metadata = await fsImpl.lstat(requestedTarball);
  const tarball = await fsImpl.realpath(requestedTarball);
  if (!isWithin(root, tarball) || metadata.isSymbolicLink() || !metadata.isFile()) {
    failReleaseResolution("npm pack returned an unsafe Codekeeper tarball.");
  }
  const actualIntegrity = `sha512-${createHash("sha512")
    .update(await fsImpl.readFile(tarball))
    .digest("base64")}`;
  if (actualIntegrity !== receipt.integrity) {
    failReleaseResolution("The downloaded Codekeeper tarball does not match the resolved SHA-512 integrity.");
  }
  return tarball;
}

export async function stageVerifiedPackage({ cwd, environment, platform, receipt, npmCli, runner, fsImpl = DEFAULT_FILE_SYSTEM, temporaryDirectory = os.tmpdir() } = {}) {
  const root = await fsImpl.mkdtemp(path.join(temporaryDirectory, "codekeeper-update-"));
  try {
    const downloadRoot = path.join(root, "download");
    const installRoot = path.join(root, "install");
    await fsImpl.mkdir(downloadRoot, { recursive: true });
    await fsImpl.mkdir(installRoot, { recursive: true });
    const packResult = await runner.run("node", [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", downloadRoot, `${PACKAGE_NAME}@${receipt.version}`], {
      cwd,
      env: updateEnvironment(environment, platform, receipt.version, receipt.integrity),
      timeoutMs: NPM_TIMEOUT_MS
    });
    const reportSource = requireCommandSuccess(packResult, "Could not download the exact Codekeeper release from npm.");
    const tarball = await verifyDownloadedTarball({
      downloadRoot,
      reportSource,
      receipt,
      fsImpl
    });
    const installResult = await runner.run("node", [npmCli, "install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", tarball], {
      cwd,
      env: updateEnvironment(environment, platform, receipt.version, receipt.integrity),
      timeoutMs: NPM_TIMEOUT_MS
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
  runner = createCommandRunner({
    commandPaths: { node: process.execPath },
    environment,
    platform
  })
} = {}) {
  const requested = releaseSelector(requestedVersion ?? version);
  const npmCli = await resolveNpm({ cwd, environment, platform });
  const metadataResult = await runner.run("node", [npmCli, "view", `${PACKAGE_NAME}@${requested}`, "version", "dist.integrity", "--json"], {
    cwd,
    env: updateEnvironment(environment, platform, "resolving"),
    timeoutMs: NPM_TIMEOUT_MS
  });
  const metadataSource = requireCommandSuccess(metadataResult, "Could not resolve the Codekeeper release metadata from npm.");
  const receipt = releaseReceipt(metadataSource, requested);
  return Object.freeze({ npmCli, ...receipt });
}

export const resolvePackageRelease = resolveNpmRelease;

async function runVerifiedCommand(
  command,
  {
    cwd = process.cwd(),
    output = process.stdout,
    environment = process.env,
    platform = process.platform,
    requestedVersion = "latest",
    version,
    requireNewerInstalledVersion = false,
    readInstalledVersion = installedReleaseVersion,
    resolveNpm = resolveNpmCliPath,
    stagePackage = stageVerifiedPackage,
    fsImpl = DEFAULT_FILE_SYSTEM,
    runner = createCommandRunner({
      commandPaths: { node: process.execPath },
      environment,
      platform
    })
  } = {}
) {
  if (!new Set(["init", "update", "rollback"]).has(command)) throw new TypeError("command must be init, update, or rollback");
  const requested = requestedVersion ?? version ?? "latest";
  const exactTarget = requested !== "latest";
  output.write(exactTarget ? `Resolving Codekeeper ${requested} and its dependency release from npm...\n` : "Resolving the latest Codekeeper CLI and dependency release from npm...\n");
  const receipt = await resolveNpmRelease({
    cwd,
    environment,
    platform,
    resolveNpm,
    runner,
    requestedVersion: requested
  });
  if (requireNewerInstalledVersion) {
    const current = await readInstalledVersion({ cwd, fsImpl });
    if (compareReleaseVersions(receipt.version, current) <= 0) {
      throw new InstallerError(`Update target ${receipt.version} must be newer than the installed Codekeeper release ${current}.`, {
        code: "UPDATE_BOOTSTRAP_FAILED"
      });
    }
  }
  output.write(command === "rollback" ? `Launching verified Codekeeper ${receipt.version} for a forward rollback plan with its locked CLI dependencies...\n` : `Launching Codekeeper ${receipt.version} with its locked CLI dependencies...\n`);
  const staged = await stagePackage({
    cwd,
    environment,
    platform,
    receipt,
    npmCli: receipt.npmCli,
    runner,
    fsImpl
  });
  try {
    // Rollback is an installer-side alias for the target release's existing
    // forward update protocol. This keeps rollback compatible with releases
    // published before the alias was added while retaining the normal commit
    // and pull-request safeguards in the target CLI.
    const childCommand = command === "rollback" ? "update" : command;
    const commandResult = await runner.run("node", [staged.executable, childCommand, "--current-package", "--package-integrity", receipt.integrity], {
      cwd,
      env: updateEnvironment(environment, platform, receipt.version, receipt.integrity),
      stdio: "inherit",
      timeoutMs: null
    });
    if (commandResult.status !== 0 || commandResult.timedOut) {
      const message = command === "rollback" ? `The verified Codekeeper ${receipt.version} CLI could not perform a forward rollback. The target release does not support rollback or could not complete it; no successful setup plan was completed.` : exactTarget ? `The Codekeeper ${receipt.version} CLI did not complete ${command}.` : `The latest Codekeeper CLI did not complete ${command}.`;
      throw new InstallerError(message, {
        code: "UPDATE_BOOTSTRAP_FAILED"
      });
    }
    return 0;
  } finally {
    await fsImpl.rm(staged.root, { force: true, recursive: true });
  }
}

export async function runLatestCommand(command, { readInstalledVersion = installedReleaseVersion, ...options } = {}) {
  if (!new Set(["init", "update"]).has(command)) {
    throw new TypeError("latest command must be init or update");
  }
  return runVerifiedCommand(command, {
    ...options,
    requestedVersion: "latest",
    requireNewerInstalledVersion: command === "update",
    readInstalledVersion
  });
}

export async function runVersionedUpdate({ requestedVersion, version, readInstalledVersion = installedReleaseVersion, ...options } = {}) {
  const requested = requestedVersion ?? version;
  if (!requested || requested === "latest") {
    return runLatestUpdate({ ...options, readInstalledVersion });
  }
  releaseSelector(requested);
  const current = await readInstalledVersion(options);
  if (compareReleaseVersions(requested, current) <= 0) {
    throw new InstallerError(`Update target ${requested} must be newer than the installed Codekeeper release ${current}.`, {
      code: "UPDATE_BOOTSTRAP_FAILED"
    });
  }
  return runVerifiedCommand("update", {
    ...options,
    requestedVersion: requested
  });
}

export async function runRollback({ targetVersion, requestedVersion, version, readInstalledVersion = installedReleaseVersion, ...options } = {}) {
  const requested = targetVersion ?? requestedVersion ?? version;
  if (!requested || requested === "latest") {
    throw new InstallerError("Rollback requires an exact Codekeeper version.", {
      code: "UPDATE_BOOTSTRAP_FAILED"
    });
  }
  releaseSelector(requested);
  const current = await readInstalledVersion(options);
  if (compareReleaseVersions(requested, current) >= 0) {
    throw new InstallerError(`Rollback target ${requested} must be older than the installed Codekeeper release ${current}.`, {
      code: "UPDATE_BOOTSTRAP_FAILED"
    });
  }
  return runVerifiedCommand("rollback", {
    ...options,
    requestedVersion: requested
  });
}

export async function runUpdateCheck({
  cwd = process.cwd(),
  output = process.stdout,
  environment = process.env,
  platform = process.platform,
  readInstalledVersion = installedReleaseVersion,
  resolveNpm = resolveNpmCliPath,
  runner = createCommandRunner({
    commandPaths: { node: process.execPath },
    environment,
    platform
  })
} = {}) {
  output.write("Checking the latest Codekeeper release metadata from npm (read-only)...\n");
  const currentVersion = await readInstalledVersion({
    cwd,
    fsImpl: DEFAULT_FILE_SYSTEM
  });
  const receipt = await resolveNpmRelease({
    cwd,
    environment,
    platform,
    resolveNpm,
    runner,
    requestedVersion: "latest"
  });
  output.write(`Installed Codekeeper release: ${currentVersion}\n`);
  output.write(`Latest published Codekeeper release: ${receipt.version}\n`);
  const comparison = compareReleaseVersions(receipt.version, currentVersion);
  if (comparison === 0) {
    output.write("Codekeeper is up to date. No files, settings, or pull requests were changed.\n");
  } else if (comparison < 0) {
    output.write("The installed Codekeeper release is newer than the registry's latest release. No downgrade was suggested.\n");
    output.write("No files, settings, or pull requests were changed.\n");
  } else {
    output.write(`Update available: codekeeper update --to ${receipt.version}\n`);
    output.write("No files, settings, or pull requests were changed.\n");
  }
  return 0;
}

export function runLatestUpdate(options = {}) {
  return runLatestCommand("update", options);
}

export function runLatestInit(options = {}) {
  return runLatestCommand("init", options);
}
