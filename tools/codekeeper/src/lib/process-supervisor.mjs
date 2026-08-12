import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_KILL_GRACE_MS = 100;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 12000;
const PROCESS_TABLE_TIMEOUT_MS = 1000;
const SUPERVISED_RUN_ID = "CODEKEEPER_SUPERVISED_RUN_ID";

function appendTail(current, chunk, maximumBytes) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (bytes.length >= maximumBytes) return Buffer.from(bytes.subarray(-maximumBytes));
  const retained = current.subarray(Math.max(0, current.length + bytes.length - maximumBytes));
  return Buffer.concat([retained, bytes]);
}

function ownedProcessIds(rootPid, runId) {
  if (process.platform === "win32" || !rootPid) return [];
  const result = spawnSync("ps", ["e", "-ww", "-Ao", "pid=,ppid=,command="], {
    encoding: "utf8",
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error("Could not inspect supervised process ownership", { cause: result.error });
  }

  const children = new Map();
  const marked = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (match[3]?.includes(`${SUPERVISED_RUN_ID}=${runId}`)) marked.push(pid);
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return [...new Set([...descendants.reverse(), ...marked])]
    .filter((pid) => pid !== rootPid && pid !== process.pid);
}

function signalProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw new Error(`Could not signal supervised process group ${child.pid}: ${error.message}`, { cause: error });
    }
  }
}

function signalProcessIds(processIds, signal) {
  for (const pid of new Set(processIds)) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw new Error(`Could not signal supervised descendant ${pid}: ${error.message}`, { cause: error });
      }
    }
  }
}

export function superviseProcess(command, args = [], {
  cwd = process.cwd(),
  environment = process.env,
  timeoutMs,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  maximumOutputBytes = DEFAULT_MAXIMUM_OUTPUT_BYTES
} = {}) {
  if (typeof command !== "string" || !command) throw new TypeError("command must be a non-empty string");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be strings");
  }
  for (const [name, value] of [
    ["timeoutMs", timeoutMs],
    ["killGraceMs", killGraceMs],
    ["maximumOutputBytes", maximumOutputBytes]
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  }

  return new Promise((resolve, reject) => {
    const runId = randomUUID();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...environment, [SUPERVISED_RUN_ID]: runId },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let status = null;
    let exitSignal = null;
    let timedOut = false;
    let cleanupStarted = false;
    let settled = false;
    let processIds = [];
    let killTimer;

    const result = () => ({ status, signal: exitSignal, stdout, stderr, timedOut });
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      callback();
    };
    const discoverOwnedProcesses = () => {
      processIds = ownedProcessIds(child.pid, runId);
    };
    const startCleanup = ({ becauseTimedOut }) => {
      if (cleanupStarted || settled) return;
      cleanupStarted = true;
      timedOut = becauseTimedOut;
      try { signalProcessGroup(child, "SIGTERM"); } catch {}
      try {
        discoverOwnedProcesses();
        signalProcessIds(processIds, "SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, "SIGKILL");
          discoverOwnedProcesses();
          signalProcessIds(processIds, "SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          settle(() => resolve(result()));
        } catch (error) {
          child.stdout.destroy();
          child.stderr.destroy();
          settle(() => reject(error));
        }
      }, killGraceMs);
    };
    const timeoutTimer = setTimeout(() => startCleanup({ becauseTimedOut: true }), timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk, maximumOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk, maximumOutputBytes);
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (exitStatus, signal) => {
      status = exitStatus;
      exitSignal = signal;
      if (timedOut) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    child.once("close", (closeStatus, signal) => {
      status = closeStatus;
      exitSignal = signal;
      if (cleanupStarted) return;
      clearTimeout(timeoutTimer);
      try {
        discoverOwnedProcesses();
      } catch (error) {
        startCleanup({ becauseTimedOut: false });
        return;
      }
      if (processIds.length > 0) {
        startCleanup({ becauseTimedOut: false });
        return;
      }
      settle(() => resolve(result()));
    });
  });
}
