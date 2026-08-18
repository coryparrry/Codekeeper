import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function missing(filePath) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-cli-boundary-"));
  await mkdir(path.join(root, "lib"));
  await cp(path.join(fixtureRoot, "src/cli.mjs"), path.join(root, "cli.mjs"));
  await writeFile(path.join(root, "lib/config.mjs"), `
export async function loadConfig() { return { config: { version: 7 } }; }
export function getAgentRuntimeSettings(_config, mode, options) {
  return { mode, mutationAuthorized: options.mutationAuthorized, modelName: "fixture" };
}
`);
  await writeFile(path.join(root, "lib/io.mjs"), `
import { appendFile } from "node:fs/promises";
export function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) positional.push(value);
    else { flags.set(value.slice(2), argv[i + 1]); i += 1; }
  }
  return {
    positional,
    assertKnown(names) { for (const key of flags.keys()) if (!names.includes(key)) throw new Error("unknown"); },
    get(name, fallback) { return flags.has(name) ? flags.get(name) : fallback; },
    require(name) { if (!flags.has(name)) throw new Error("missing"); return flags.get(name); }
  };
}
export async function setGitHubOutput(name, value) { await appendFile(process.env.GITHUB_OUTPUT, name + "=" + value + "\\n"); }
export function log(message) { console.log(message); }
export function workflowCommandValue(value) { return String(value).split("\\n")[0]; }
`);
  await writeFile(path.join(root, "cli-heavy.mjs"), `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.HEAVY_MARKER, "loaded");
`);
  return root;
}

test("check-config and agent-settings do not load heavy runtime modules", async () => {
  const root = await createFixture();
  try {
    for (const args of [
      ["check-config", "--config", "fixture.json"],
      ["agent-settings", "--mode", "audit", "--mutation-authorized", "true"]
    ]) {
      const marker = path.join(root, `${args[0]}.heavy`);
      const output = path.join(root, `${args[0]}.output`);
      await execFileAsync(process.execPath, [path.join(root, "cli.mjs"), ...args], {
        env: { ...process.env, GITHUB_OUTPUT: output, HEAVY_MARKER: marker }
      });
      assert.equal(await missing(marker), true);
      assert.match(await readFile(output, "utf8"), /result=/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-light commands are delegated to the heavy entry point", async () => {
  const root = await createFixture();
  try {
    const marker = path.join(root, "heavy.marker");
    await execFileAsync(process.execPath, [path.join(root, "cli.mjs"), "prepare-review"], {
      env: { ...process.env, HEAVY_MARKER: marker, GITHUB_OUTPUT: path.join(root, "output") }
    });
    assert.equal(await readFile(marker, "utf8"), "loaded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the lightweight entry point has no static heavyweight imports", async () => {
  const source = await readFile(path.join(fixtureRoot, "src/cli.mjs"), "utf8");
  assert.match(source, /await import\("\.\/cli-heavy\.mjs"\)/);
  assert.doesNotMatch(source, /from "\.\/lib\/(?:agents-runtime|commands|git|prepare|publish|validate)\.mjs"/);
});
