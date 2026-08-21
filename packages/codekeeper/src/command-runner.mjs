import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, openSync } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { InstallerError } from "./errors.mjs";

const OUTPUT_LIMIT = 128 * 1024;
export const STDIN_FILE_LIMIT_BYTES = 48 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1_000;
const SAFE_ENV_NAMES = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM",
  "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME",
  "GH_CONFIG_DIR", "GH_HOST", "NO_COLOR", "FORCE_COLOR",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID"
]);
const WINDOWS_SAFE_ENV_NAMES = new Set(["APPDATA", "USERPROFILE", "SystemRoot"]);
const TRUSTED_COMMANDS = Object.freeze(["git", "gh"]);

const DEFAULT_TRUSTED_COMMAND_FILE_SYSTEM = Object.freeze({
  access,
  lstat,
  readFile,
  realpath,
  stat
});

function environmentPathName(environment, platform) {
  if (platform === "win32") {
    if (typeof environment.Path === "string") return "Path";
    if (typeof environment.PATH === "string") return "PATH";
    return Object.keys(environment).find((name) => name.toLowerCase() === "path" && typeof environment[name] === "string") ?? null;
  }
  return typeof environment.PATH === "string" ? "PATH" : null;
}

export function sanitizedEnvironment(environment = process.env, { platform = process.platform } = {}) {
  const sanitized = {};
  const pathName = environmentPathName(environment, platform);
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    if (name === pathName || (platform === "win32" && name.toLowerCase() === "path")) continue;
    if (
      SAFE_ENV_NAMES.has(name)
      || (platform === "win32" && WINDOWS_SAFE_ENV_NAMES.has(name))
      || /^LC_[A-Z_]+$/.test(name)
    ) sanitized[name] = value;
  }
  if (pathName) sanitized[pathName] = environment[pathName];
  sanitized.GH_HOST = "github.com";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  return sanitized;
}

const DEFAULT_FILE_OPERATIONS = Object.freeze({
  closeSync,
  fstatSync,
  openSync
});

function pathDelimiter(platform) {
  return platform === "win32" ? ";" : path.delimiter;
}

function isRepositoryControlledPath(target, repositoryRoot) {
  const relative = path.relative(repositoryRoot, target);
  if (relative === "") return true;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return true;
}

function hasNodeModulesAncestor(target) {
  const components = target.split(path.sep).map((component) => component.toLowerCase());
  return components.includes("node_modules");
}

function pathSegments(target) {
  const root = path.parse(target).root;
  return path.relative(root, target).split(path.sep).filter(Boolean);
}

function hasSameFilesystemIdentity(left, right) {
  return Number.isInteger(left.dev)
    && Number.isInteger(left.ino)
    && left.dev === right.dev
    && left.ino === right.ino
    && (left.dev !== 0 || left.ino !== 0);
}

async function hasOriginalRepositoryRootPrefix(original, originalRoot, fsImpl) {
  const resolvedOriginal = path.resolve(original);
  const resolvedRoot = path.resolve(originalRoot);
  const originalBase = path.parse(resolvedOriginal).root;
  const rootBase = path.parse(resolvedRoot).root;
  if (originalBase.toLowerCase() !== rootBase.toLowerCase()) return false;
  const rootParts = pathSegments(resolvedRoot);
  const originalParts = pathSegments(resolvedOriginal);
  if (originalParts.length < rootParts.length) return false;
  const originalPrefix = path.join(originalBase, ...originalParts.slice(0, rootParts.length));
  try {
    const [knownRoot, candidateRoot] = await Promise.all([
      fsImpl.lstat(resolvedRoot),
      fsImpl.lstat(originalPrefix)
    ]);
    return hasSameFilesystemIdentity(knownRoot, candidateRoot);
  } catch {
    return false;
  }
}

async function isOriginalRepositoryControlledPath(original, originalRoot, repositoryRoot, fsImpl) {
  if (isRepositoryControlledPath(original, originalRoot) || isRepositoryControlledPath(original, repositoryRoot)) return true;
  if (await hasOriginalRepositoryRootPrefix(original, originalRoot, fsImpl)) return true;
  try {
    const canonicalParent = await fsImpl.realpath(path.dirname(original));
    return isRepositoryControlledPath(canonicalParent, repositoryRoot);
  } catch {
    return false;
  }
}

async function hasSafeGitdirPointer(markerPath, marker, fsImpl) {
  if (!marker.isFile() || marker.isSymbolicLink() || marker.size <= 0 || marker.size > 4 * 1024) return false;
  let source;
  try {
    source = await fsImpl.readFile(markerPath, "utf8");
  } catch {
    return false;
  }
  const match = /^gitdir: ([^\u0000-\u001f\u007f]+)\r?\n?$/.exec(source);
  if (!match) return false;
  const target = path.isAbsolute(match[1]) ? match[1] : path.resolve(path.dirname(markerPath), match[1]);
  try {
    const resolved = await fsImpl.realpath(target);
    const gitdir = await fsImpl.lstat(resolved);
    const head = await fsImpl.lstat(path.join(resolved, "HEAD"));
    return gitdir.isDirectory() && !gitdir.isSymbolicLink() && head.isFile() && !head.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasSafeGitRootMarker(root, fsImpl) {
  const markerPath = path.join(root, ".git");
  try {
    const marker = await fsImpl.lstat(markerPath);
    if (marker.isDirectory() && !marker.isSymbolicLink()) return true;
    return hasSafeGitdirPointer(markerPath, marker, fsImpl);
  } catch {
    return false;
  }
}

async function findRepositoryRoot(cwd, fsImpl) {
  let current;
  try {
    current = await fsImpl.realpath(cwd);
  } catch {
    throw new InstallerError("Could not safely locate required commands.", { code: "TRUSTED_COMMAND_UNAVAILABLE" });
  }
  const resolvedCwd = current;
  let repositoryRoot = current;
  for (;;) {
    if (await hasSafeGitRootMarker(current, fsImpl)) repositoryRoot = current;
    const parent = path.dirname(current);
    if (parent === current) return Object.freeze({ repositoryRoot, resolvedCwd });
    current = parent;
  }
}

export async function resolveRepositoryBoundary({
  cwd = process.cwd(),
  fsImpl = DEFAULT_TRUSTED_COMMAND_FILE_SYSTEM
} = {}) {
  return (await findRepositoryRoot(cwd, fsImpl)).repositoryRoot;
}

function originalRepositoryRoot(cwd, resolvedCwd, repositoryRoot) {
  const suffix = path.relative(repositoryRoot, resolvedCwd);
  if (suffix === "" || suffix === "." || suffix === ".." || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) {
    return path.resolve(cwd);
  }
  return path.resolve(path.resolve(cwd), ...suffix.split(path.sep).map(() => ".."));
}

async function trustedPathEntries({ repositoryRoot, originalRoot, environment, platform, fsImpl }) {
  const sanitized = sanitizedEnvironment(environment, { platform });
  const pathName = environmentPathName(sanitized, platform);
  const rawPath = pathName ? sanitized[pathName] : "";
  const directories = [];
  for (const entry of rawPath.split(pathDelimiter(platform))) {
    if (!entry || !path.isAbsolute(entry)) continue;
    try {
      const original = path.resolve(entry);
      if (await isOriginalRepositoryControlledPath(original, originalRoot, repositoryRoot, fsImpl)) continue;
      const resolved = await fsImpl.realpath(entry);
      const metadata = await fsImpl.stat(resolved);
      if (!metadata.isDirectory() || isRepositoryControlledPath(resolved, repositoryRoot) || hasNodeModulesAncestor(resolved)) continue;
      if (!directories.includes(resolved)) directories.push(resolved);
    } catch {
      // Ignore unavailable PATH entries; a trusted executable still has to be found below.
    }
  }
  if (!pathName || !directories.length) {
    throw new InstallerError("Could not safely locate required commands.", { code: "TRUSTED_COMMAND_UNAVAILABLE" });
  }
  return {
    directories,
    environment: Object.freeze({
      ...sanitized,
      [pathName]: directories.join(pathDelimiter(platform))
    })
  };
}

function executableNames(command, platform) {
  return platform === "win32" ? [command, `${command}.exe`, `${command}.com`] : [command];
}

async function findTrustedExecutable(command, directories, repositoryRoot, platform, fsImpl) {
  for (const directory of directories) {
    for (const name of executableNames(command, platform)) {
      try {
        const candidate = path.join(directory, name);
        const resolved = await fsImpl.realpath(candidate);
        const metadata = await fsImpl.stat(resolved);
        if (!metadata.isFile() || isRepositoryControlledPath(resolved, repositoryRoot) || hasNodeModulesAncestor(resolved)) continue;
        await fsImpl.access(resolved, fsConstants.X_OK);
        // Trust the canonical target, but retain the selected path as argv0. Some
        // trusted multi-call executables choose their command from that identity.
        return candidate;
      } catch {
        // Continue looking without revealing candidate locations.
      }
    }
  }
  throw new InstallerError("Could not safely locate required commands.", { code: "TRUSTED_COMMAND_UNAVAILABLE" });
}

async function resolveTrustedCommandPaths({
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  fsImpl = DEFAULT_TRUSTED_COMMAND_FILE_SYSTEM,
  allowMissingCommands = []
} = {}) {
  if (!Array.isArray(allowMissingCommands) || allowMissingCommands.some((command) => !TRUSTED_COMMANDS.includes(command))) {
    throw new TypeError("allowMissingCommands must contain only trusted command names");
  }
  const allowedMissing = new Set(allowMissingCommands);
  const { repositoryRoot, resolvedCwd } = await findRepositoryRoot(cwd, fsImpl);
  const originalRoot = originalRepositoryRoot(cwd, resolvedCwd, repositoryRoot);
  const { directories, environment: trustedEnvironment } = await trustedPathEntries({ repositoryRoot, originalRoot, environment, platform, fsImpl });
  const commandPaths = {};
  for (const command of TRUSTED_COMMANDS) {
    try {
      commandPaths[command] = await findTrustedExecutable(command, directories, repositoryRoot, platform, fsImpl);
    } catch (error) {
      if (!allowedMissing.has(command) || error?.code !== "TRUSTED_COMMAND_UNAVAILABLE") throw error;
      commandPaths[command] = null;
    }
  }
  return Object.freeze({ commandPaths: Object.freeze(commandPaths), environment: trustedEnvironment });
}

function validateStdinFilePath(stdinFilePath) {
  if (
    typeof stdinFilePath !== "string"
    || !path.isAbsolute(stdinFilePath)
    || stdinFilePath.trim() !== stdinFilePath
    || /[\u0000-\u001f\u007f]/.test(stdinFilePath)
  ) {
    throw new InstallerError("The selected private-key file path must be an absolute path.", {
      code: "SECRET_INPUT_FILE_INVALID"
    });
  }
}

export function openSafeStdinFile(stdinFilePath, { fileOperations = DEFAULT_FILE_OPERATIONS } = {}) {
  validateStdinFilePath(stdinFilePath);
  let descriptor = null;
  let closed = false;
  try {
    descriptor = fileOperations.openSync(
      stdinFilePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    );
    const opened = fileOperations.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.size <= 0
      || opened.size > STDIN_FILE_LIMIT_BYTES
    ) {
      throw new InstallerError("The selected private-key input must be a nonempty regular file no larger than 48 KB.", {
        code: "SECRET_INPUT_FILE_INVALID"
      });
    }
    return Object.freeze({
      descriptor,
      close() {
        if (closed) return;
        closed = true;
        fileOperations.closeSync(descriptor);
      }
    });
  } catch (cause) {
    if (descriptor !== null) {
      try {
        fileOperations.closeSync(descriptor);
      } catch {
        // Preserve the safe generic error below without exposing local path data.
      }
    }
    if (cause instanceof InstallerError) throw cause;
    throw new InstallerError("The installer failed to open the selected private-key file safely.", {
      code: "SECRET_INPUT_FILE_INVALID",
      cause
    });
  }
}

function appendBounded(chunks, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = OUTPUT_LIMIT - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(buffer.length, remaining);
  if (buffer.length > remaining) state.truncated = true;
}

export function createCommandRunner({
  spawnImpl = spawn,
  environment = process.env,
  platform = process.platform,
  commandPaths = null
} = {}) {
  const frozenCommandPaths = commandPaths ? Object.freeze({ ...commandPaths }) : null;
  return Object.freeze({
    async resolveTrustedCommands({ cwd = process.cwd(), fsImpl = DEFAULT_TRUSTED_COMMAND_FILE_SYSTEM, allowMissingCommands = [] } = {}) {
      const trusted = await resolveTrustedCommandPaths({ cwd, environment, platform, fsImpl, allowMissingCommands });
      return createCommandRunner({
        spawnImpl,
        environment: trusted.environment,
        platform,
        commandPaths: trusted.commandPaths
      });
    },
    run(command, args = [], options = {}) {
      if (typeof command !== "string" || !command) throw new TypeError("command must be a non-empty string");
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new TypeError("args must be strings");
      const stdio = options.stdio ?? "capture";
      if (!["capture", "inherit", "ignore"].includes(stdio)) throw new TypeError(`Unsupported stdio mode: ${stdio}`);
      const timeoutMs = options.timeoutMs === null ? null : (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new TypeError("timeoutMs must be a positive finite number or null");
      }
      const stdinFd = options.stdinFd ?? null;
      if (stdinFd !== null && (!Number.isInteger(stdinFd) || stdinFd < 3)) {
        throw new TypeError("stdinFd must be an open non-standard file descriptor");
      }
      const provideInput = options.provideInput ?? null;
      if (provideInput !== null && typeof provideInput !== "function") throw new TypeError("provideInput must be a function");
      if (provideInput && stdinFd !== null) throw new TypeError("provideInput and stdinFd cannot be used together");
      const stdoutFd = options.stdoutFd ?? null;
      if (stdoutFd !== null && (!Number.isInteger(stdoutFd) || stdoutFd < 3)) {
        throw new TypeError("stdoutFd must be an open non-standard file descriptor");
      }
      if (stdoutFd !== null && stdio !== "capture") throw new TypeError("stdoutFd requires captured stdio");
      const env = options.env ?? sanitizedEnvironment(environment, { platform });
      const hasResolvedCommand = frozenCommandPaths !== null && Object.hasOwn(frozenCommandPaths, command);
      const executable = hasResolvedCommand ? frozenCommandPaths[command] : command;
      if (executable === null) {
        return Promise.reject(new InstallerError(`Could not run ${command}.`, { code: "TRUSTED_COMMAND_UNAVAILABLE" }));
      }

      return new Promise((resolve, reject) => {
        const stdout = [];
        const stderr = [];
        const stdoutState = { bytes: 0, truncated: false };
        const stderrState = { bytes: 0, truncated: false };
        let settled = false;
        let timedOut = false;
        let killTimer = null;
        let child;
        try {
          const childStdio = stdio === "capture"
            ? [provideInput ? "pipe" : (stdinFd ?? "ignore"), stdoutFd ?? "pipe", "pipe"]
            : stdinFd === null
              ? (provideInput ? ["pipe", stdio, stdio] : stdio)
              : [stdinFd, stdio, stdio];
          child = spawnImpl(executable, args, {
            cwd: options.cwd,
            env,
            shell: false,
            stdio: childStdio
          });
        } catch (cause) {
          reject(new InstallerError(`Could not start ${command}.`, { code: "COMMAND_START_FAILED", cause }));
          return;
        }

        if (stdio === "capture") {
          if (stdoutFd === null) child.stdout?.on("data", (chunk) => appendBounded(stdout, chunk, stdoutState));
          child.stderr?.on("data", (chunk) => appendBounded(stderr, chunk, stderrState));
        }

        let inputFailed = false;
        let inputSettled = !provideInput;
        let closeResult = null;
        const settleClosedCommand = () => {
          if (settled || closeResult === null || !inputSettled) return;
          settled = true;
          clearTimers();
          if (inputFailed) {
            reject(new InstallerError("The credential input was cancelled or failed to send safely.", { code: "COMMAND_INPUT_FAILED" }));
            return;
          }
          resolve(Object.freeze({
            status: closeResult.status ?? 1,
            signal: closeResult.signal,
            timedOut,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            truncated: stdoutState.truncated || stderrState.truncated
          }));
        };
        const inputPromise = provideInput
          ? Promise.resolve().then(() => provideInput((chunk) => {
            if (typeof chunk !== "string" || !chunk || /[\r\n\u0000]/.test(chunk)) {
              throw new TypeError("Credential input must be a nonempty single-line string");
            }
            if (!child.stdin?.writable) throw new Error("credential input is unavailable");
            child.stdin.write(chunk);
          })).then(() => {
            child.stdin?.end();
          }).catch(() => {
            inputFailed = true;
            child.stdin?.destroy();
            child.kill("SIGTERM");
          })
          : Promise.resolve();
        inputPromise.finally(() => {
          inputSettled = true;
          settleClosedCommand();
        });

        const timer = timeoutMs === null ? null : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          killTimer.unref?.();
        }, timeoutMs);
        timer?.unref?.();

        const clearTimers = () => {
          if (timer) clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
        };

        child.once("error", (cause) => {
          if (settled) return;
          settled = true;
          clearTimers();
          reject(new InstallerError(`Could not run ${command}.`, { code: "COMMAND_START_FAILED", cause }));
        });
        child.once("close", (status, signal) => {
          if (settled) return;
          closeResult = { status, signal };
          settleClosedCommand();
        });
      });
    }
  });
}

export async function requireSuccess(runner, command, args, options = {}, message = `${command} failed`) {
  const result = await runner.run(command, args, options);
  if (result.status !== 0 || result.timedOut || result.truncated) {
    throw new InstallerError(message, { code: result.timedOut ? "COMMAND_TIMEOUT" : "COMMAND_FAILED" });
  }
  return result.stdout.trim();
}
