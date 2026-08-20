import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyInstalledPackage } from "../src/verification-adapters.mjs";
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const TEST_PACKAGE_RELEASE = Object.freeze({
  name: "@coryparry/codekeeper",
  version: PACKAGE_VERSION,
  integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
});

const INSTALLED_SOURCE = Object.freeze({
  repository: "coryparrry/Codekeeper",
  commit: "7".repeat(40),
});
const NPM_CLI = "/trusted/node_modules/npm/bin/npm-cli.js";

async function packageStage(t, source = INSTALLED_SOURCE) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-package-proof-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const packageRoot = path.join(
    root,
    "install",
    "node_modules",
    "@coryparry",
    "codekeeper",
  );
  await mkdir(path.join(packageRoot, "assets"), { recursive: true });
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(packageRoot, "release"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "assets", "metadata.json"),
    `${JSON.stringify({ version: 1, source })}\n`,
  );
  const executable = path.join(packageRoot, "bin", "codekeeper.mjs");
  await writeFile(executable, "#!/usr/bin/env node\n");
  return { executable, packageRoot, root };
}

function verificationDependencies(stage) {
  const calls = [];
  const runner = {
    calls,
    async run(command, args, options) {
      calls.push({ command, args: [...args], options: { ...options } });
      return {
        status: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    },
  };
  return {
    runner,
    options: {
      runner,
      environment: {},
      platform: "linux",
      resolveNpm: async ({ cwd }) => {
        assert.equal(cwd, "/repo/widget");
        return NPM_CLI;
      },
      resolveRelease: async ({ requestedVersion, resolveNpm }) => {
        assert.equal(requestedVersion, TEST_PACKAGE_RELEASE.version);
        assert.equal(await resolveNpm(), NPM_CLI);
        return {
          version: TEST_PACKAGE_RELEASE.version,
          integrity: TEST_PACKAGE_RELEASE.integrity,
        };
      },
      stagePackage: async ({ receipt, npmCli }) => {
        assert.equal(receipt.integrity, TEST_PACKAGE_RELEASE.integrity);
        assert.equal(npmCli, NPM_CLI);
        return { executable: stage.executable, root: stage.root };
      },
      verifyRelease: async (options) => {
        assert.equal(options.root, stage.packageRoot);
        assert.equal(options.expectedName, TEST_PACKAGE_RELEASE.name);
        assert.equal(options.expectedVersion, TEST_PACKAGE_RELEASE.version);
        assert.equal(options.expectedIntegrity, TEST_PACKAGE_RELEASE.integrity);
        assert.equal(Object.hasOwn(options, "expectedSourceCommit"), false);
        const receipt = JSON.parse(
          await readFile(
            path.join(stage.packageRoot, "release", "package-integrity.json"),
            "utf8",
          ),
        );
        assert.deepEqual(receipt, {
          version: 1,
          algorithm: "sha512",
          integrity: TEST_PACKAGE_RELEASE.integrity,
        });
      },
    },
  };
}

function installation(source = INSTALLED_SOURCE) {
  return {
    releaseManifest: { source },
  };
}

test("package verification keeps release provenance separate from installed asset provenance", async (t) => {
  const stage = await packageStage(t);
  const dependencies = verificationDependencies(stage);
  const verified = await verifyInstalledPackage(
    {
      packageRelease: TEST_PACKAGE_RELEASE,
      installation: installation(),
      root: "/repo/widget",
    },
    dependencies.options,
  );

  assert.equal(verified, true);
  assert.equal(dependencies.runner.calls.length, 2);
  assert.deepEqual(dependencies.runner.calls[0].args, [
    NPM_CLI,
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  assert.deepEqual(dependencies.runner.calls[1].args.slice(1), [
    "check-config",
    "--config",
    "/repo/widget/.github/codekeeper.json",
  ]);
});

test("package verification rejects a package built from different installed assets", async (t) => {
  const stage = await packageStage(t, {
    ...INSTALLED_SOURCE,
    commit: "8".repeat(40),
  });
  const dependencies = verificationDependencies(stage);
  const verified = await verifyInstalledPackage(
    {
      packageRelease: TEST_PACKAGE_RELEASE,
      installation: installation(),
      root: "/repo/widget",
    },
    dependencies.options,
  );

  assert.equal(verified, false);
  assert.equal(dependencies.runner.calls.length, 0);
});
