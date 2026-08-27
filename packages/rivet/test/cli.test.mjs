import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/cli.mjs";

function output() {
  let value = "";
  return {
    stream: { write: (chunk) => (value += chunk) },
    read: () => value,
  };
}

test("runs an explicit review-only dry-run", async () => {
  const stdout = output();
  let options;
  const expected = { mode: "review", files: [] };
  const result = await runCli(
    ["init", "--review-only", "--repository", "/repo", "--dry-run"],
    {
      stdout: stdout.stream,
      installReviewImpl: async (value) => {
        options = value;
        return expected;
      },
    },
  );
  assert.deepEqual(options, { repositoryRoot: "/repo", dryRun: true });
  assert.equal(result, expected);
  assert.deepEqual(JSON.parse(stdout.read()), expected);
});

test("rejects implicit modes and unknown arguments", async () => {
  await assert.rejects(runCli(["init"]), /--review-only is required/);
  await assert.rejects(
    runCli(["init", "--review-only", "--repair"]),
    /unknown argument --repair/,
  );
  await assert.rejects(runCli(["install"]), /unknown command/);
});
