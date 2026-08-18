import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  githubOutputPayload,
  setGitHubOutput,
  workflowCommandValue
} from "../src/lib/io.mjs";

function entropy(byte) {
  return Buffer.alloc(18, byte);
}

test("GitHub output delimiter retries when the value contains the candidate line", () => {
  const first = `CODEKEEPER_${entropy(0).toString("hex")}`;
  const values = [entropy(0), entropy(1)];
  const payload = githubOutputPayload("result", `before\n${first}\nafter`, {
    randomBytesImpl: () => values.shift()
  });
  const safe = `CODEKEEPER_${entropy(1).toString("hex")}`;
  assert.match(payload, new RegExp(`result<<${safe}`));
  assert.ok(payload.endsWith(`\n${safe}\n`));
});

test("GitHub output names and entropy are validated", () => {
  assert.throws(() => githubOutputPayload("bad-name", "value"), /name is invalid/);
  assert.throws(
    () => githubOutputPayload("result", "value", { randomBytesImpl: () => Buffer.alloc(4) }),
    /18-byte Buffer/
  );
});

test("setGitHubOutput appends one complete multiline record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-output-"));
  const outputPath = path.join(root, "output.txt");
  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputPath;
  try {
    await setGitHubOutput("result", "line one\nline two");
    const source = await readFile(outputPath, "utf8");
    const [header, ...rest] = source.split("\n");
    const delimiter = header.slice("result<<".length);
    assert.deepEqual(rest, ["line one", "line two", delimiter, ""]);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow annotations hide stacks by default and expose them only in debug mode", () => {
  const stack = "Error: failed safely\n    at main (file:///home/runner/work/repo/src/cli.mjs:10:2)";
  assert.equal(workflowCommandValue(stack), "Error: failed safely");
  const debug = workflowCommandValue(stack, { debug: true });
  assert.match(debug, /%0A/);
  assert.match(debug, /file:\/\/\/home\/runner/);
});

test("ordinary multiline warnings keep their content", () => {
  assert.equal(workflowCommandValue("first\nsecond"), "first%0Asecond");
});
