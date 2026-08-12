import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const PINNED_COMMIT = "0c06445f0ac2988b6ffc5ef89d423efbcfdb72c9";
export const HEAD_SHA = "a".repeat(40);

export function result(stdout = "", overrides = {}) {
  return {
    status: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    truncated: false,
    ...overrides
  };
}

export function createRecordingRunner(handler = () => result()) {
  const calls = [];
  return {
    calls,
    async run(command, args = [], options = {}) {
      const call = { command, args: [...args], options: { ...options } };
      calls.push(call);
      return await handler(call, calls.length - 1);
    }
  };
}

export function textSink({ isTTY = true } = {}) {
  const chunks = [];
  return {
    isTTY,
    write(value) {
      chunks.push(String(value));
      return true;
    },
    toString() {
      return chunks.join("");
    }
  };
}

export async function temporaryDirectory(t, prefix = "codekeeper-test-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull
    }
  });
}

export function assertInstallerCode(assert, code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

export function commandKey(command, args) {
  return `${command}\0${args.join("\0")}`;
}
