import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRecordingRunner, result, temporaryDirectory, textSink } from "./helpers.mjs";
import { resolveNpmCliPath, resolveNpmRelease, runLatestInit, runLatestUpdate, verifyDownloadedTarball } from "../src/updater.mjs";

const RELEASE_INTEGRITY = `sha512-${Buffer.alloc(64, 0xab).toString("base64")}`;

test("the latest-release bootstrap resolves an exact receipt then runs that exact package", async () => {
  const calls = [];
  const runner = createRecordingRunner((call) => {
    calls.push(call);
    return calls.length === 1
      ? result(JSON.stringify({ version: "1.4.2", dist: { integrity: RELEASE_INTEGRITY } }))
      : result();
  });
  const output = textSink();
  const status = await runLatestUpdate({
    cwd: "/tmp/widget",
    output,
    environment: {
      PATH: "/trusted/bin",
      HOME: "/tmp/home",
      NPM_CONFIG_CACHE: "/tmp/npm-cache",
      OPENAI_API_KEY: "must-not-reach-the-new-cli"
    },
    platform: "linux",
    resolveNpm: async () => "/trusted/lib/node_modules/npm/bin/npm-cli.js",
    stagePackage: async ({ receipt }) => {
      assert.equal(receipt.integrity, RELEASE_INTEGRITY);
      return { executable: "/verified/codekeeper/bin/codekeeper.mjs", root: "/verified/codekeeper" };
    },
    fsImpl: { async rm() {} },
    runner
  });
  assert.equal(status, 0);
  assert.deepEqual(calls[0].args, [
    "/trusted/lib/node_modules/npm/bin/npm-cli.js",
    "view",
    "codekeeper@latest",
    "version",
    "dist.integrity",
    "--json"
  ]);
  assert.deepEqual(calls[1].args, [
    "/verified/codekeeper/bin/codekeeper.mjs",
    "update",
    "--current-package",
    "--package-integrity",
    RELEASE_INTEGRITY,
  ]);
  assert.equal(calls[1].options.stdio, "inherit");
  assert.equal(calls[1].options.timeoutMs, null);
  assert.equal(calls[1].options.env.CODEKEEPER_UPDATE_EXPECTED_VERSION, "1.4.2");
  assert.equal(calls[1].options.env.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY, RELEASE_INTEGRITY);
  assert.equal(calls[1].options.env.NPM_CONFIG_CACHE, "/tmp/npm-cache");
  assert.equal(calls[1].options.env.OPENAI_API_KEY, undefined);
  assert.match(output.toString(), /Resolving the latest.*Launching Codekeeper 1\.4\.2/s);
});

test("init also re-enters through the exact latest package receipt", async () => {
  const runner = createRecordingRunner((_call, index) => index === 0
    ? result(JSON.stringify({ version: "1.4.2", dist: { integrity: RELEASE_INTEGRITY } }))
    : result());
  assert.equal(await runLatestInit({
    cwd: "/tmp/widget",
    output: textSink(),
    environment: { PATH: "/trusted/bin" },
    platform: "linux",
    resolveNpm: async () => "/trusted/lib/node_modules/npm/bin/npm-cli.js",
    stagePackage: async () => ({ executable: "/verified/codekeeper/bin/codekeeper.mjs", root: "/verified/codekeeper" }),
    fsImpl: { async rm() {} },
    runner
  }), 0);
  assert.deepEqual(runner.calls[1].args.slice(-4), ["init", "--current-package", "--package-integrity", RELEASE_INTEGRITY]);
  assert.equal(runner.calls[1].options.env.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY, RELEASE_INTEGRITY);
});

test("the trusted launcher rejects changed tarball bytes for the same package version", async (t) => {
  const downloadRoot = await temporaryDirectory(t, "codekeeper-updater-download-");
  const filename = "codekeeper-1.4.2.tgz";
  await writeFile(path.join(downloadRoot, filename), "changed package bytes");
  const expectedBytes = Buffer.from("expected package bytes");
  const expectedIntegrity = `sha512-${createHash("sha512").update(expectedBytes).digest("base64")}`;
  await assert.rejects(
    verifyDownloadedTarball({
      downloadRoot,
      reportSource: JSON.stringify([{
        name: "codekeeper",
        version: "1.4.2",
        integrity: expectedIntegrity,
        filename,
      }]),
      receipt: { version: "1.4.2", integrity: expectedIntegrity },
    }),
    (error) => error.code === "UPDATE_BOOTSTRAP_FAILED" && /does not match.*SHA-512/.test(error.message),
  );
});

test("the latest-release bootstrap rejects invalid registry versions before execution", async () => {
  const runner = createRecordingRunner(() => result(JSON.stringify({
    version: "latest",
    dist: { integrity: RELEASE_INTEGRITY }
  })));
  await assert.rejects(
    runLatestUpdate({
      cwd: "/tmp/widget",
      output: textSink(),
      environment: { PATH: "/trusted/bin" },
      platform: "linux",
      resolveNpm: async () => "/trusted/lib/node_modules/npm/bin/npm-cli.js",
      runner
    }),
    (error) => error.code === "UPDATE_BOOTSTRAP_FAILED"
  );
  assert.equal(runner.calls.length, 1);
});

test("the release resolver queries an explicit version and requires an exact matching receipt", async () => {
  const runner = createRecordingRunner(() => result(JSON.stringify({
    version: "1.4.2",
    "dist.integrity": RELEASE_INTEGRITY
  })));
  const receipt = await resolveNpmRelease({
    cwd: "/tmp/widget",
    environment: { PATH: "/trusted/bin" },
    platform: "linux",
    version: "1.4.2",
    resolveNpm: async () => "/trusted/lib/node_modules/npm/bin/npm-cli.js",
    runner
  });
  assert.deepEqual(receipt, {
    npmCli: "/trusted/lib/node_modules/npm/bin/npm-cli.js",
    version: "1.4.2",
    integrity: RELEASE_INTEGRITY
  });
  assert.deepEqual(runner.calls[0].args, [
    "/trusted/lib/node_modules/npm/bin/npm-cli.js",
    "view",
    "codekeeper@1.4.2",
    "version",
    "dist.integrity",
    "--json"
  ]);
});

test("the release resolver rejects ranges before invoking npm", async () => {
  let resolveCalls = 0;
  const runner = createRecordingRunner();
  await assert.rejects(
    resolveNpmRelease({
      cwd: "/tmp/widget",
      environment: { PATH: "/trusted/bin" },
      platform: "linux",
      version: "^1.4.2",
      resolveNpm: async () => {
        resolveCalls += 1;
        return "/trusted/lib/node_modules/npm/bin/npm-cli.js";
      },
      runner
    }),
    (error) => error.code === "UPDATE_BOOTSTRAP_FAILED"
  );
  assert.equal(resolveCalls, 0);
  assert.equal(runner.calls.length, 0);
});

test("the release resolver rejects an exact-version mismatch before execution", async () => {
  const runner = createRecordingRunner(() => result(JSON.stringify({
    version: "1.4.3",
    dist: { integrity: RELEASE_INTEGRITY }
  })));
  await assert.rejects(
    resolveNpmRelease({
      cwd: "/tmp/widget",
      environment: { PATH: "/trusted/bin" },
      platform: "linux",
      version: "1.4.2",
      resolveNpm: async () => "/trusted/lib/node_modules/npm/bin/npm-cli.js",
      runner
    }),
    (error) => error.code === "UPDATE_BOOTSTRAP_FAILED"
  );
  assert.equal(runner.calls.length, 1);
});

for (const [description, metadata] of [
  ["missing integrity", { version: "1.4.2", dist: {} }],
  ["non-sha512 integrity", { version: "1.4.2", dist: { integrity: "sha256-abc" } }],
  ["wrong-length sha512 integrity", { version: "1.4.2", dist: { integrity: "sha512-abc" } }]
]) {
  test(`the latest-release bootstrap rejects ${description} before execution`, async () => {
    const runner = createRecordingRunner(() => result(JSON.stringify(metadata)));
    await assert.rejects(
      runLatestUpdate({
        cwd: "/tmp/widget",
        output: textSink(),
        environment: { PATH: "/trusted/bin" },
        platform: "linux",
        resolveNpm: async () => "/trusted/lib/node_modules/npm/bin/npm-cli.js",
        runner
      }),
      (error) => error.code === "UPDATE_BOOTSTRAP_FAILED"
    );
    assert.equal(runner.calls.length, 1);
  });
}

test("npm resolution accepts the package-manager CLI outside the checkout and rejects repository shadows", async (t) => {
  const repository = await temporaryDirectory(t, "codekeeper-updater-repository-");
  const trustedRoot = await temporaryDirectory(t, "codekeeper-updater-npm-");
  await mkdir(path.join(repository, ".git"));
  const trustedNpm = path.join(trustedRoot, "node_modules", "npm", "bin", "npm-cli.js");
  const shadowNpm = path.join(repository, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(path.dirname(trustedNpm), { recursive: true });
  await mkdir(path.dirname(shadowNpm), { recursive: true });
  await writeFile(trustedNpm, "// trusted test npm\n");
  await writeFile(shadowNpm, "// repository shadow\n");
  assert.equal(await resolveNpmCliPath({
    cwd: repository,
    environment: { npm_execpath: trustedNpm },
    platform: "linux"
  }), await realpath(trustedNpm));
  await assert.rejects(
    resolveNpmCliPath({
      cwd: repository,
      environment: { npm_execpath: shadowNpm, PATH: "" },
      platform: "linux"
    }),
    (error) => error.code === "NPM_UNAVAILABLE"
  );
});
