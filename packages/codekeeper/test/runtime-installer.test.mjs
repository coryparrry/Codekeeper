import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { installRuntime } from "../bin/install-runtime.mjs";
import { createRuntimeArchive, RUNTIME_ARCHIVE_MANIFEST_PATH, RUNTIME_ARCHIVE_PATH } from "../src/runtime-archive.mjs";
import { temporaryDirectory } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t, "codekeeper-runtime-installer-");
  const packageRoot = path.join(root, "package");
  const workspace = path.join(root, "workspace");
  const stagedRuntime = path.join(root, "staged-runtime");
  await mkdir(path.join(packageRoot, "release"), { recursive: true });
  await mkdir(path.join(workspace, "tooling"), { recursive: true });
  await mkdir(path.join(stagedRuntime, "src"), { recursive: true });
  await writeFile(path.join(stagedRuntime, "package.json"), "{}\n");
  await writeFile(path.join(stagedRuntime, "src", "agent.mjs"), "export {};\n");
  const { archiveBytes, manifest } = await createRuntimeArchive(stagedRuntime);
  await writeFile(path.join(packageRoot, ...RUNTIME_ARCHIVE_PATH.split("/")), archiveBytes);
  await writeFile(
    path.join(packageRoot, ...RUNTIME_ARCHIVE_MANIFEST_PATH.split("/")),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { packageRoot, workspace };
}

test("the runtime installer extracts one verified archive and does not run npm ci", async (t) => {
  const { packageRoot, workspace } = await fixture(t);
  const platformCalls = [];
  const destination = await installRuntime({
    packageRoot,
    workspace,
    async installPlatformPackages(options) {
      platformCalls.push(options.runtimeRoot);
    },
  });
  assert.equal(destination, path.join(workspace, "tooling", "codekeeper-runtime"));
  assert.equal(await readFile(path.join(destination, "src", "agent.mjs"), "utf8"), "export {};\n");
  assert.deepEqual(platformCalls, [destination]);
});

test("the runtime installer preserves an existing destination and cleans a failed new install", async (t) => {
  const { packageRoot, workspace } = await fixture(t);
  const destination = path.join(workspace, "tooling", "codekeeper-runtime");
  await mkdir(destination);
  await writeFile(path.join(destination, "owner.txt"), "preserve\n");
  await assert.rejects(
    installRuntime({ packageRoot, workspace, async installPlatformPackages() {} }),
    /destination already exists/,
  );
  assert.equal(await readFile(path.join(destination, "owner.txt"), "utf8"), "preserve\n");

  const cleanWorkspace = path.join(path.dirname(workspace), "clean-workspace");
  await mkdir(path.join(cleanWorkspace, "tooling"), { recursive: true });
  await assert.rejects(
    installRuntime({
      packageRoot,
      workspace: cleanWorkspace,
      async installPlatformPackages() {
        throw new Error("test install failure");
      },
    }),
    /prebuilt runtime could not be installed/,
  );
  await assert.rejects(access(path.join(cleanWorkspace, "tooling", "codekeeper-runtime")), /ENOENT/);
});
