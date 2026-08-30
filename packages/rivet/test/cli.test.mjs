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

test("creates an explicit setup pull request", async () => {
  const stdout = output();
  let options;
  const expected = { pullRequestUrl: "https://github.com/acme/repo/pull/1" };
  const result = await runCli(
    [
      "init",
      "--review-only",
      "--repository",
      "/repo",
      "--setup-pr",
      "--setup-branch",
      "rivet/test",
    ],
    {
      stdout: stdout.stream,
      createSetupPullRequestImpl: async (value) => {
        options = value;
        return expected;
      },
    },
  );
  assert.deepEqual(options, {
    repositoryRoot: "/repo",
    dryRun: false,
    branch: "rivet/test",
  });
  assert.equal(result, expected);
});

test("rejects implicit modes and unknown arguments", async () => {
  await assert.rejects(runCli(["init"]), /--review-only is required/);
  await assert.rejects(
    runCli(["init", "--review-only", "--repair"]),
    /unknown argument --repair/,
  );
  await assert.rejects(
    runCli(["init", "--review-only", "--dry-run", "--setup-pr"]),
    /cannot be combined/,
  );
  await assert.rejects(
    runCli(["init", "--review-only", "--setup-branch", "rivet/test"]),
    /requires --setup-pr/,
  );
  await assert.rejects(runCli(["install"]), /unknown command/);
});
