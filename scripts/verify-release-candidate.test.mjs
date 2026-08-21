import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildCodekeeperPackageStage } from "./build-codekeeper-package.mjs";
import { runCommand } from "./release-candidate-lifecycle.mjs";
import {
  assertRequiredCandidatePaths,
  runLiteralNpxLifecycle,
  verifyTarballReceipt,
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
