import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVerifiedAssets as loadProductionAssets } from "../src/assets.mjs";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
export const PINNED_COMMIT = "d7554d9d6482664499f4c2ea788b20542f743a2e";
export const HEAD_SHA = "a".repeat(40);
export const TEST_PACKAGE_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
export const TEST_PACKAGE_RELEASE = Object.freeze({
  name: "codekeeper",
  version: "0.2.0",
  integrity: TEST_PACKAGE_INTEGRITY
});

export function testPackageEnvironment(environment = {}) {
  return {
    CODEKEEPER_UPDATE_EXPECTED_VERSION: TEST_PACKAGE_RELEASE.version,
    CODEKEEPER_UPDATE_EXPECTED_INTEGRITY: TEST_PACKAGE_RELEASE.integrity,
    ...environment,
  };
}

export function loadVerifiedAssets(options = {}) {
  return loadProductionAssets({ packageRelease: TEST_PACKAGE_RELEASE, ...options });
}

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
