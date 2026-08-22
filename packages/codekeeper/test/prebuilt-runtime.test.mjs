import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  assertInstalledLockfileInventory,
  buildPrebuiltRuntimeArchive,
  installLockedRuntimeDependencies,
  installMatchingPlatformPackages,
  matchingPlatformLockEntries,
  platformSpecificLockPrefixes,
  skipRuntimeDependencyInstall,
} from "../src/prebuilt-runtime.mjs";
import { temporaryDirectory } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

function sha512Integrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

const LOCK = {
  packages: {
    "": { dependencies: { zod: "1.0.0", "@openai/codex": "0.1.0" } },
    "node_modules/zod": { version: "1.0.0", integrity: "sha512-abc" },
    "node_modules/@openai/codex-linux-x64": {
      name: "@openai/codex",
      version: "0.1.0-linux-x64",
      integrity: "sha512-abc",
      optional: true,
      os: ["linux"],
      cpu: ["x64"],
    },
    "node_modules/@openai/codex-darwin-arm64": {
      name: "@openai/codex",
      version: "0.1.0-darwin-arm64",
      integrity: "sha512-abc",
      optional: true,
      os: ["darwin"],
      cpu: ["arm64"],
    },
  },
};

test("platform lock prefixes exclude Codex native packages from the prebuilt archive", () => {
  assert.deepEqual(platformSpecificLockPrefixes(LOCK), [
    "node_modules/@openai/codex-darwin-arm64",
    "node_modules/@openai/codex-linux-x64",
  ]);
  assert.deepEqual(
    matchingPlatformLockEntries(LOCK, { platform: "linux", arch: "x64" }).map((entry) => entry.key),
    ["node_modules/@openai/codex-linux-x64"],
  );
});

test("skipRuntimeDependencyInstall leaves the staged runtime untouched", async () => {
  const runtimeRoot = "/tmp/codekeeper-staged-runtime";
  assert.equal(await skipRuntimeDependencyInstall({ runtimeRoot }), runtimeRoot);
});

test("lockfile inventory requires non-optional packages and ignores missing platform packages", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-lock-inventory-");
  await mkdir(path.join(root, "node_modules", "zod"), { recursive: true });
  await assertInstalledLockfileInventory(root, LOCK);
  await assert.rejects(assertInstalledLockfileInventory(root, {
    packages: {
      "node_modules/missing": { version: "1.0.0" },
    },
  }), /missing node_modules\/missing/);
});

test("locked runtime install uses npm ci without lifecycle scripts and rejects lockfile mutation", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-locked-install-");
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(LOCK)}\n`);
  const calls = [];
  await mkdir(path.join(root, "node_modules", "zod"), { recursive: true });
  await installLockedRuntimeDependencies({
    runtimeRoot: root,
    async runCommand(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
    },
  });
  assert.deepEqual(calls, [{
    command: "npm",
    args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: root,
  }]);

  await assert.rejects(installLockedRuntimeDependencies({
    runtimeRoot: root,
    async runCommand() {
      await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({ packages: {} })}\n`);
    },
  }), /mutated the runtime lockfile/);
});

test("platform package acquisition verifies the lockfile integrity and extracts into node_modules", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-platform-package-");
  const packageRoot = path.join(root, "npm-package", "package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"@openai/codex"}\n');
  const tarball = path.join(root, "openai-codex-0.1.0-linux-x64.tgz");
  await execFileAsync("tar", ["-czf", tarball, "-C", path.join(root, "npm-package"), "package"]);
  const tarballBytes = await readFile(tarball);
  const lock = {
    packages: {
      "node_modules/@openai/codex-linux-x64": {
        name: "@openai/codex",
        version: "0.1.0-linux-x64",
        integrity: sha512Integrity(tarballBytes),
        optional: true,
        os: ["linux"],
        cpu: ["x64"],
      },
    },
  };
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
  await installMatchingPlatformPackages({
    runtimeRoot: root,
    platform: "linux",
    arch: "x64",
    async runCommand(command, args) {
      if (command === "npm") {
        const destination = args[args.indexOf("--pack-destination") + 1];
        const filename = "openai-codex-0.1.0-linux-x64.tgz";
        await writeFile(path.join(destination, filename), tarballBytes);
        return { status: 0, signal: null, stdout: JSON.stringify([{ filename }]), stderr: "" };
      }
      const result = await execFileAsync(command, args);
      return { status: 0, signal: null, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    },
  });
  assert.equal(
    await readFile(path.join(root, "node_modules", "@openai", "codex-linux-x64", "package.json"), "utf8"),
    '{"name":"@openai/codex"}\n',
  );
});

test("platform package acquisition rejects an integrity mismatch", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-platform-integrity-");
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify({
    packages: {
      "node_modules/@openai/codex-linux-x64": {
        name: "@openai/codex",
        version: "0.1.0-linux-x64",
        integrity: sha512Integrity(Buffer.from("expected")),
        optional: true,
        os: ["linux"],
        cpu: ["x64"],
      },
    },
  })}\n`);
  await assert.rejects(installMatchingPlatformPackages({
    runtimeRoot: root,
    platform: "linux",
    arch: "x64",
    async runCommand(command, args) {
      if (command !== "npm") return { status: 0, signal: null, stdout: "", stderr: "" };
      const destination = args[args.indexOf("--pack-destination") + 1];
      const filename = "openai-codex-0.1.0-linux-x64.tgz";
      await writeFile(path.join(destination, filename), Buffer.from("tampered"));
      return { status: 0, signal: null, stdout: JSON.stringify([{ filename }]), stderr: "" };
    },
  }), /integrity mismatch/);
});

test("prebuilt archive build installs into a disposable copy and omits it from the source tree", async (t) => {
  const staged = await temporaryDirectory(t, "codekeeper-prebuilt-stage-");
  await mkdir(path.join(staged, "src"), { recursive: true });
  await writeFile(path.join(staged, "package.json"), '{"name":"runtime"}\n');
  await writeFile(path.join(staged, "package-lock.json"), `${JSON.stringify({ packages: { "": {} } })}\n`);
  await writeFile(path.join(staged, "src", "cli.mjs"), "export {};\n");
  let installedRoot;
  const { archiveBytes, manifest } = await buildPrebuiltRuntimeArchive({
    stagedRuntimeRoot: staged,
    async installRuntimeDependencies({ runtimeRoot }) {
      installedRoot = runtimeRoot;
      await mkdir(path.join(runtimeRoot, "node_modules", "zod"), { recursive: true });
      await writeFile(path.join(runtimeRoot, "node_modules", "zod", "index.js"), "js\n");
      return runtimeRoot;
    },
  });
  assert.ok(archiveBytes.length > 0);
  assert.equal(manifest.files.some((file) => file.path === "node_modules/zod/index.js"), true);
  await assert.rejects(access(installedRoot), /ENOENT/);
});
