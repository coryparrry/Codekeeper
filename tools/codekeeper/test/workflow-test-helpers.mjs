import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(testDirectory, "../../..");
export const workflowDirectory = path.join(repositoryRoot, ".github/workflows");
export const modes = Object.freeze(["review", "maintain", "issues", "fix"]);
export const execFileAsync = promisify(execFile);
export const actionPins = Object.freeze({
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/attest-build-provenance": "4d101475d8b20a2381f78447822ac1eab6504dd8",
  "actions/create-github-app-token": "bcd2ba49218906704ab6c1aa796996da409d3eb1",
  "reviewdog/action-actionlint": "dbe5299849118fd6f099ba563d263d770955a64a",
  "peter-evans/create-pull-request": "22a9089034f40e5a961c8808d113e2c98fb63676",
  "googleapis/release-please-action":
    "45996ed1f6d02564a971a2fa1b5860e934307cf7",
});
export async function repositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

export async function workflow(mode) {
  return repositoryFile(`.github/workflows/codekeeper-${mode}.yml`);
}

export function jobSection(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const next = nextName
    ? source.indexOf(`  ${nextName}:\n`, start + 1)
    : source.length;
  assert.notEqual(next, -1, `missing ${nextName} job after ${name}`);
  return source.slice(start, next);
}

export function stepRunScript(source, stepName) {
  const step = source.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(step, -1, `missing ${stepName} step`);
  const run = source.indexOf("        run: |\n", step);
  assert.notEqual(run, -1, `missing ${stepName} run script`);
  const next = source.indexOf("\n      - name:", run + 1);
  return source
    .slice(run + "        run: |\n".length, next === -1 ? source.length : next)
    .split("\n")
    .map((line) => (line.length === 0 ? line : line.replace(/^ {10}/, "")))
    .join("\n");
}
