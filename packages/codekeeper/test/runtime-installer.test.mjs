import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { installRuntime } from "../bin/install-runtime.mjs";
import { temporaryDirectory } from "./helpers.mjs";

async function fixture(t) {
  const root = await temporaryDirectory(t, "codekeeper-runtime-installer-");
  const packageRoot = path.join(root, "package");
  const workspace = path.join(root, "workspace");
  await mkdir(path.join(packageRoot, "runtime", "src"), { recursive: true });
  await mkdir(path.join(workspace, "tooling"), { recursive: true });
  await writeFile(path.join(packageRoot, "runtime", "package.json"), "{}\n");
  await writeFile(path.join(packageRoot, "runtime", "src", "agent.mjs"), "export {};\n");
  return { packageRoot, workspace };
}

test("the runtime installer copies one verified graph and installs it without lifecycle scripts", async (t) => {
  const { packageRoot, workspace } = await fixture(t);
  const calls = [];
  const destination = await installRuntime({
    packageRoot,
    workspace,
    platform: "linux",
    async runCommand(command, args, options) {
      calls.push({ command, args, options });
    },
  });
  assert.equal(destination, path.join(workspace, "tooling", "codekeeper-runtime"));
  assert.equal(await readFile(path.join(destination, "src", "agent.mjs"), "utf8"), "export {};\n");
  assert.deepEqual(calls[0].command, "npm");
  assert.deepEqual(calls[0].args, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(calls[0].options.cwd, destination);
});

test("the runtime installer preserves an existing destination and cleans a failed new install", async (t) => {
  const { packageRoot, workspace } = await fixture(t);
  const destination = path.join(workspace, "tooling", "codekeeper-runtime");
  await mkdir(destination);
  await writeFile(path.join(destination, "owner.txt"), "preserve\n");
  await assert.rejects(
    installRuntime({ packageRoot, workspace, async runCommand() {} }),
    /destination already exists/,
  );
  assert.equal(await readFile(path.join(destination, "owner.txt"), "utf8"), "preserve\n");

  const cleanWorkspace = path.join(path.dirname(workspace), "clean-workspace");
  await mkdir(path.join(cleanWorkspace, "tooling"), { recursive: true });
  await assert.rejects(
    installRuntime({
      packageRoot,
      workspace: cleanWorkspace,
      async runCommand() {
        throw new Error("test install failure");
      },
    }),
    /locked dependency graph could not be installed/,
  );
  await assert.rejects(access(path.join(cleanWorkspace, "tooling", "codekeeper-runtime")), /ENOENT/);
});
