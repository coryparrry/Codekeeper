import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { skipRuntimeDependencyInstall } from "../packages/codekeeper/src/prebuilt-runtime.mjs";
import { createRuntimeArchive } from "../packages/codekeeper/src/runtime-archive.mjs";
import { verifyCodekeeperRelease } from "../packages/codekeeper/src/release-verifier.mjs";
import { buildCodekeeperPackageStage } from "./build-codekeeper-package.mjs";
import { runCommand } from "./release-candidate-lifecycle.mjs";
import {
  assertRequiredCandidatePaths,
  exerciseProductionVerificationAdapters,
  runLiteralNpxLifecycle,
  verifyTarballReceipt,
  verifyReleaseCandidate,
} from "./verify-release-candidate.mjs";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function collectCandidateFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectCandidateFiles(root, child)));
    } else if (
      entry.isFile() &&
      child !== "release/manifest.json" &&
      child !== "release/package-integrity.json"
    ) {
      files.push(child);
    }
  }
  return files;
}

async function createCandidateTarball(
  t,
  { manifestSourceCommit = null } = {},
) {
  const root = await temporaryDirectory(t, "codekeeper-candidate-pipeline-");
  const packageRoot = path.join(root, "archive", "package");
  const sourceCommit = "a".repeat(40);
  const packageManifest = {
    name: "@coryparry/codekeeper",
    version: "9.8.7",
    type: "module",
    bin: {
      codekeeper: "bin/codekeeper.mjs",
      "codekeeper-verify-package": "bin/verify-package.mjs",
    },
    engines: { node: ">=22" },
  };
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );
  await cp(
    path.join(repositoryRoot, "packages", "codekeeper", "src"),
    path.join(packageRoot, "src"),
    { recursive: true },
  );

  const files = new Map([
    [
      "assets/metadata.json",
      `${JSON.stringify({
        source: {
          repository: "https://github.com/coryparrry/Codekeeper",
          commit: sourceCommit,
        },
      })}\n`,
    ],
    ["assets/workflows/codekeeper.yml", "name: candidate\n"],
    [
      "release/actions/acquire-package/action.yml",
      "name: candidate-acquire\nruns:\n  using: composite\n  steps: []\n",
    ],
    [
      "release/workflows/codekeeper-runtime.yml",
      "name: candidate-runtime\non: workflow_dispatch\njobs: {}\n",
    ],
    ["release/runtime-archive.bin", "candidate archive\n"],
    ["release/runtime-archive.manifest.json", '{"fixture":true}\n'],
    ["runtime/agents/pr-reviewer.md", "# Candidate reviewer\n"],
    [
      "runtime/package.json",
      `${JSON.stringify({
        name: "@coryparry/codekeeper-runtime",
        version: "1.0.0",
        type: "module",
      })}\n`,
    ],
    [
      "runtime/package-lock.json",
      `${JSON.stringify({
        name: "@coryparry/codekeeper-runtime",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "@coryparry/codekeeper-runtime",
            version: "1.0.0",
          },
        },
      })}\n`,
    ],
    ["runtime/presets/catalogue.mjs", "export const catalogue = {};\n"],
    ["runtime/scripts/verify-tooling-artifact.mjs", "process.exit(0);\n"],
    ["runtime/src/cli.mjs", "process.exit(0);\n"],
  ]);
  for (const [relativePath, contents] of files) {
    const target = path.join(packageRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "bin", "codekeeper.mjs"),
    `#!/usr/bin/env node
process.stdout.write("Repository identity: The checkout origin must be a credential-free GitHub.com repository URL.\\n");
process.stderr.write("Repository readiness checks failed\\n");
process.exitCode = 1;
`,
    { mode: 0o755 },
  );
  await cp(
    path.join(repositoryRoot, "packages", "codekeeper", "bin", "verify-package.mjs"),
    path.join(packageRoot, "bin", "verify-package.mjs"),
  );

  const runtimeArchive = await createRuntimeArchive(
    path.join(packageRoot, "runtime"),
  );
  await writeFile(
    path.join(packageRoot, "release", "runtime-archive.bin"),
    runtimeArchive.archiveBytes,
  );
  await writeFile(
    path.join(packageRoot, "release", "runtime-archive.manifest.json"),
    `${JSON.stringify(runtimeArchive.manifest, null, 2)}\n`,
  );
  const releaseManifest = {
    version: 1,
    package: { name: packageManifest.name, version: packageManifest.version },
    source: {
      repository: "https://github.com/coryparrry/Codekeeper",
      commit: manifestSourceCommit ?? sourceCommit,
    },
    files: [],
  };
  for (const relativePath of await collectCandidateFiles(packageRoot)) {
    releaseManifest.files.push({
      path: relativePath,
      sourcePath: `fixture/${relativePath}`,
      role: "production",
      sha256: createHash("sha256")
        .update(await readFile(path.join(packageRoot, ...relativePath.split("/"))))
        .digest("hex"),
    });
  }
  await writeFile(
    path.join(packageRoot, "release", "manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );

  const filename = "codekeeper-9.8.7.tgz";
  const tarball = path.join(root, filename);
  await execute("tar", [
    "-czf",
    tarball,
    "-C",
    path.join(root, "archive"),
    "package",
  ], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const bytes = await readFile(tarball);
  const expected = {
    filename,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    name: packageManifest.name,
    sourceCommit,
    version: packageManifest.version,
  };
  return { expected, packageManifest, root, tarball };
}

function candidateValues({ expected, tarball, manifestSha256 } = {}) {
  return {
    "expected-filename": expected.filename,
    "expected-integrity": expected.integrity,
    ...(manifestSha256 ? { "expected-manifest-sha256": manifestSha256 } : {}),
    "expected-name": expected.name,
    "expected-source-commit": expected.sourceCommit,
    "expected-version": expected.version,
    tarball,
  };
}

test("release candidate verification exercises the complete hermetic pipeline", async (t) => {
  const fixture = await createCandidateTarball(t);
  const commandCalls = [];
  const lifecycleCalls = [];
  const adapterCalls = [];
  const adapterVerifierCalls = [];
  const cleanupCalls = [];
  let temporaryRoot;
  const recordingRunner = async (command, args, options) => {
    commandCalls.push({ command, args: [...args], cwd: options?.cwd });
    return runCommand(command, args, options);
  };
  const result = await verifyReleaseCandidate({
    values: candidateValues(fixture),
    dependencies: {
      runCommand: recordingRunner,
      runLiteralNpxLifecycle: async (options) => {
        lifecycleCalls.push(options);
        return runLiteralNpxLifecycle(options);
      },
      exerciseProductionVerificationAdapters: async (options) => {
        adapterCalls.push(options);
        return exerciseProductionVerificationAdapters(options);
      },
      verifyRelease: async (options) => {
        adapterVerifierCalls.push(options);
        return verifyCodekeeperRelease(options);
      },
      mkdtemp: async (prefix) => {
        temporaryRoot = await mkdtemp(prefix);
        return temporaryRoot;
      },
      rm: async (...args) => {
        cleanupCalls.push(args);
        return rm(...args);
      },
    },
  });

  const manifestBytes = await readFile(
    path.join(fixture.root, "archive", "package", "release", "manifest.json"),
  );
  assert.deepEqual(result, {
    filename: fixture.expected.filename,
    integrity: fixture.expected.integrity,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    name: fixture.expected.name,
    sourceCommit: fixture.expected.sourceCommit,
    version: fixture.expected.version,
    yamlFiles: 3,
  });
  assert.equal(lifecycleCalls.length, 1);
  assert.equal(adapterCalls.length, 1);
  assert.equal(adapterVerifierCalls.length, 1);
  assert.equal(
    adapterVerifierCalls[0].expectedIntegrity,
    fixture.expected.integrity,
  );
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0][0], temporaryRoot);
  await assert.rejects(access(temporaryRoot), { code: "ENOENT" });

  assert.ok(
    commandCalls.some(
      ({ command, args }) => command === "tar" && args[0] === "-xzf",
    ),
    "tar extraction is exercised",
  );
  assert.ok(
    commandCalls.some(
      ({ command, args }) => command === "ruby" && args[0] === "-e",
    ),
    "Ruby/Psych YAML parsing is exercised",
  );
  assert.equal(
    commandCalls.filter(
      ({ command, args }) =>
        command === process.execPath &&
        args.some((argument) => argument.endsWith("/verify-package.mjs")),
    ).length,
    2,
    "the packaged verifier runs for both extracted and installed candidates",
  );
  assert.ok(
    commandCalls.some(
      ({ command, args }) =>
        command === "npm" &&
        args[0] === "install" &&
        args.includes(fixture.tarball),
    ),
    "the exact candidate tarball is installed",
  );
  assert.ok(
    commandCalls.some(
      ({ command, args, cwd }) =>
        command === "npm" &&
        args[0] === "ci" &&
        cwd?.endsWith(
          path.join(
            "installed",
            "node_modules",
            "@coryparry",
            "codekeeper",
            "runtime",
          ),
        ),
    ),
    "nested runtime dependencies are installed",
  );
});

test("release candidate verification rejects a manifest receipt mismatch and still cleans up", async (t) => {
  const fixture = await createCandidateTarball(t);
  let temporaryRoot;
  await assert.rejects(
    verifyReleaseCandidate({
      values: candidateValues({
        expected: fixture.expected,
        tarball: fixture.tarball,
        manifestSha256: "0".repeat(64),
      }),
      dependencies: {
        mkdtemp: async (prefix) => {
          temporaryRoot = await mkdtemp(prefix);
          return temporaryRoot;
        },
        rm: async (...args) => rm(...args),
      },
    }),
    /release manifest SHA-256 does not match/,
  );
  await assert.rejects(access(temporaryRoot), { code: "ENOENT" });
});

test("release candidate verification fails closed when the packaged verifier rejects the release identity", async (t) => {
  const fixture = await createCandidateTarball(t, {
    manifestSourceCommit: "b".repeat(40),
  });
  await assert.rejects(
    verifyReleaseCandidate({ values: candidateValues(fixture) }),
    /packaged release verifier failed: .*source commit does not match/,
  );
});

test("candidate tarball verification rejects changed bytes before extraction", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-candidate-tamper-");
  const filename = "coryparry-codekeeper-1.2.3.tgz";
  const tarball = path.join(root, filename);
  const original = Buffer.from("candidate bytes");
  const integrity = `sha512-${createHash("sha512")
    .update(original)
    .digest("base64")}`;
  await writeFile(tarball, Buffer.from("tampered candidate bytes"));

  await assert.rejects(
    verifyTarballReceipt({
      tarball,
      expectedFilename: filename,
      expectedIntegrity: integrity,
    }),
    /candidate tarball integrity mismatch/,
  );
});

test("candidate structure verification fails closed when nested runtime is missing", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-candidate-runtime-");
  const stage = path.join(root, "stage");
  await buildCodekeeperPackageStage({
    repositoryRoot,
    destination: stage,
    sourceCommit: "a".repeat(40),
    requireClean: false,
    installRuntimeDependencies: skipRuntimeDependencyInstall,
  });
  await rm(path.join(stage, "runtime", "src", "cli.mjs"));

  await assert.rejects(
    assertRequiredCandidatePaths(stage),
    /runtime\/src\/cli\.mjs/,
  );
});

test(
  "command timeout terminates descendants that retain captured stdio",
  { skip: process.platform === "win32" },
  async () => {
    const descendantSource = "setInterval(() => {}, 1_000);";
    const launcherSource = `
const { spawn } = require("node:child_process");
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  stdio: ["ignore", "inherit", "inherit"],
});
descendant.unref();
process.stdout.write(String(descendant.pid) + "\\n", () => process.exit(0));
`;
    const started = Date.now();
    const result = await runCommand(process.execPath, ["-e", launcherSource], {
      env: process.env,
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;
    const descendantPid = Number.parseInt(result.stdout.trim(), 10);

    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 2_000, `process tree cleanup took ${elapsed}ms`);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
    let descendantAlive = true;
    for (let attempt = 0; attempt < 20 && descendantAlive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
        descendantAlive = false;
      }
    }
    assert.equal(descendantAlive, false, "timed-out descendant must not survive");
  },
);

test("literal npx acquires the exact local candidate and observes the readiness stop", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-candidate-npx-");
  const archive = path.join(root, "archive");
  const packageRoot = path.join(archive, "package");
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  const packageManifest = {
    name: "@coryparry/codekeeper",
    version: "9.8.7",
    type: "module",
    bin: { codekeeper: "bin/codekeeper.mjs" },
    engines: { node: ">=22" },
  };
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
  );
  await writeFile(
    path.join(packageRoot, "bin", "codekeeper.mjs"),
    `#!/usr/bin/env node
process.stdout.write("Repository identity: The checkout origin must be a credential-free GitHub.com repository URL.\\n");
process.stderr.write("Repository readiness checks failed\\n");
process.exitCode = 1;
`,
    { mode: 0o755 },
  );
  const filename = "coryparry-codekeeper-9.8.7.tgz";
  const tarball = path.join(root, filename);
  await execute("tar", ["-czf", tarball, "-C", archive, "package"]);
  const bytes = await readFile(tarball);
  const expected = {
    filename,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    name: packageManifest.name,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    version: packageManifest.version,
  };

  await runLiteralNpxLifecycle({
    bytes,
    expected,
    packageManifest,
    root: path.join(root, "lifecycle"),
  });
});
