import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, fstatSync, openSync } from "node:fs";
import path from "node:path";
import { InstallerError } from "./errors.mjs";

const OUTPUT_LIMIT = 128 * 1024;
export const STDIN_FILE_LIMIT_BYTES = 48 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 1_000;
const SAFE_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM",
  "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME",
  "GH_CONFIG_DIR", "GH_HOST", "NO_COLOR", "FORCE_COLOR",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID"
]);

export function sanitizedEnvironment(environment = process.env) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    if (SAFE_ENV_NAMES.has(name) || /^LC_[A-Z_]+$/.test(name)) sanitized[name] = value;
  }
  sanitized.GH_HOST = "github.com";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  return sanitized;
}

const DEFAULT_FILE_OPERATIONS = Object.freeze({
  closeSync,
  fstatSync,
  openSync
});

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
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
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
    throw new InstallerError("The selected private-key file could not be opened safely.", {
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
  environment = process.env
} = {}) {
  return Object.freeze({
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
      const env = options.env ?? sanitizedEnvironment(environment);

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
            ? [stdinFd ?? "ignore", "pipe", "pipe"]
            : stdinFd === null
              ? stdio
              : [stdinFd, stdio, stdio];
          child = spawnImpl(command, args, {
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
          child.stdout?.on("data", (chunk) => appendBounded(stdout, chunk, stdoutState));
          child.stderr?.on("data", (chunk) => appendBounded(stderr, chunk, stderrState));
        }

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
          settled = true;
          clearTimers();
          resolve(Object.freeze({
            status: status ?? 1,
            signal,
            timedOut,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            truncated: stdoutState.truncated || stderrState.truncated
          }));
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
