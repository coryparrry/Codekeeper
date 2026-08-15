import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createCommandRunner, resolveRepositoryBoundary, sanitizedEnvironment } from "./command-runner.mjs";
import { PACKAGE_NAME } from "./constants.mjs";
import { InstallerError } from "./errors.mjs";

const NPM_TIMEOUT_MS = 5 * 60 * 1000;
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_ENV_NAMES = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "NPM_CONFIG_CACHE", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_REGISTRY",
  "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_CAFILE", "NPM_CONFIG_STRICT_SSL",
  "npm_config_cache", "npm_config_userconfig", "npm_config_registry",
  "npm_config_proxy", "npm_config_https_proxy", "npm_config_cafile", "npm_config_strict_ssl"
]);
const DEFAULT_FILE_SYSTEM = Object.freeze({ access, lstat, readFile, realpath, stat });

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

function updateEnvironment(environment, platform, expectedVersion) {
  const updated = { ...sanitizedEnvironment(environment, { platform }) };
  for (const name of NPM_ENV_NAMES) {
    if (typeof environment[name] === "string") updated[name] = environment[name];
  }
  updated.CODEKEEPER_UPDATE_EXPECTED_VERSION = expectedVersion;
  updated.npm_config_audit = "false";
  updated.npm_config_fund = "false";
  updated.npm_config_ignore_scripts = "true";
  updated.npm_config_prefer_online = "true";
  updated.npm_config_yes = "true";
  return updated;
}

function requireCommandSuccess(result, message) {
  if (result.status !== 0 || result.timedOut || result.truncated) {
    throw new InstallerError(message, { code: "UPDATE_BOOTSTRAP_FAILED" });
  }
  return result.stdout.trim();
}

export async function runLatestUpdate({
  cwd = process.cwd(),
  output = process.stdout,
  environment = process.env,
  platform = process.platform,
  resolveNpm = resolveNpmCliPath,
  runner = createCommandRunner({ commandPaths: { node: process.execPath }, environment, platform })
} = {}) {
  const npmCli = await resolveNpm({ cwd, environment, platform });
  output.write("Resolving the latest Codekeeper CLI and dependency release from npm...\n");
  const versionResult = await runner.run("node", [
    npmCli, "view", `${PACKAGE_NAME}@latest`, "version", "--json"
  ], {
    cwd,
    env: updateEnvironment(environment, platform, "resolving"),
    timeoutMs: NPM_TIMEOUT_MS
  });
  const versionSource = requireCommandSuccess(versionResult, "Could not resolve the latest Codekeeper release from npm.");
  let version;
  try {
    version = JSON.parse(versionSource);
  } catch {
    throw new InstallerError("npm returned an invalid Codekeeper release version.", { code: "UPDATE_BOOTSTRAP_FAILED" });
  }
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    throw new InstallerError("npm returned an invalid Codekeeper release version.", { code: "UPDATE_BOOTSTRAP_FAILED" });
  }
  output.write(`Launching Codekeeper ${version} with its locked CLI dependencies...\n`);
  const updateResult = await runner.run("node", [
    npmCli,
    "exec",
    "--yes",
    "--ignore-scripts",
    "--prefer-online",
    `--package=${PACKAGE_NAME}@${version}`,
    "--",
    PACKAGE_NAME,
    "update",
    "--current-package"
  ], {
    cwd,
    env: updateEnvironment(environment, platform, version),
    stdio: "inherit",
    timeoutMs: NPM_TIMEOUT_MS
  });
  if (updateResult.status !== 0 || updateResult.timedOut) {
    throw new InstallerError("The latest Codekeeper CLI did not complete the repository update.", {
      code: "UPDATE_BOOTSTRAP_FAILED"
    });
  }
  return 0;
}
