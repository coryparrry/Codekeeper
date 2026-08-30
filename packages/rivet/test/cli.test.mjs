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
      createReviewSetupPullRequestImpl: async (value) => {
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

test("runs an explicit repair upgrade", async () => {
  const stdout = output();
  let options;
  const expected = { mode: "repair", files: [] };
  const result = await runCli(
    ["init", "--repair", "--repository", "/repo", "--dry-run"],
    {
      stdout: stdout.stream,
      installRepairImpl: async (value) => {
        options = value;
        return expected;
      },
    },
  );
  assert.deepEqual(options, { repositoryRoot: "/repo", dryRun: true });
  assert.equal(result, expected);
});

test("creates an explicit repair setup pull request", async () => {
  let options;
  const expected = { pullRequestUrl: "https://github.com/acme/repo/pull/2" };
  const result = await runCli(
    ["init", "--repair", "--repository", "/repo", "--setup-pr"],
    {
      stdout: output().stream,
      createRepairSetupPullRequestImpl: async (value) => {
        options = value;
        return expected;
      },
    },
  );
  assert.deepEqual(options, { repositoryRoot: "/repo", dryRun: false });
  assert.equal(result, expected);
});

test("prints a review-only GitHub App plan", async () => {
  const stdout = output();
  const result = await runCli(
    ["app-plan", "--repository", "Acme/Widget", "--owner-type", "Organization"],
    { stdout: stdout.stream },
  );
  assert.equal(result.repository, "Acme/Widget");
  assert.deepEqual(result.authority.permissions, {
    contents: "read",
    metadata: "read",
    pullRequests: "write",
  });
  assert.match(
    result.registrationUrl,
    /^https:\/\/github\.com\/organizations\/Acme\/settings\/apps\/new\?/,
  );
  assert.deepEqual(JSON.parse(stdout.read()), result);
});

for (const [command, dependency] of [
  ["app-configure", "configureReviewAppImpl"],
  ["app-verify", "verifyReviewAppImpl"],
]) {
  test(`runs ${command} with explicit credential inputs`, async () => {
    const stdout = output();
    let received;
    const expected = { repository: "Acme/Widget", verified: true };
    const result = await runCli(
      [
        command,
        "--repository",
        "Acme/Widget",
        "--client-id",
        "Iv123456789012345678",
        "--private-key-file",
        "/keys/rivet.pem",
      ],
      {
        stdout: stdout.stream,
        [dependency]: async (options) => {
          received = options;
          return expected;
        },
      },
    );
    assert.deepEqual(received, {
      repository: "Acme/Widget",
      clientId: "Iv123456789012345678",
      privateKeyPath: "/keys/rivet.pem",
    });
    assert.equal(result, expected);
    assert.deepEqual(JSON.parse(stdout.read()), expected);
  });
}

test("verifies an explicit repair App authority target", async () => {
  let received;
  const expected = { permissions: { contents: "write" } };
  const result = await runCli(
    [
      "app-verify",
      "--repository",
      "Acme/Widget",
      "--client-id",
      "Iv123456789012345678",
      "--private-key-file",
      "/keys/rivet.pem",
      "--repair",
    ],
    {
      stdout: output().stream,
      verifyRepairAppImpl: async (options) => {
        received = options;
        return expected;
      },
    },
  );
  assert.deepEqual(received, {
    repository: "Acme/Widget",
    clientId: "Iv123456789012345678",
    privateKeyPath: "/keys/rivet.pem",
  });
  assert.equal(result, expected);
});

test("rejects implicit modes and unknown arguments", async () => {
  await assert.rejects(runCli(["init"]), /an init mode is required/);
  await assert.rejects(
    runCli(["init", "--review-only", "--repair"]),
    /choose one init mode/,
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
  await assert.rejects(runCli(["app-plan"]), /--repository is required/);
  await assert.rejects(
    runCli(["app-configure", "--repository", "Acme/Widget"]),
    /--client-id is required/,
  );
  await assert.rejects(
    runCli([
      "app-configure",
      "--repository",
      "Acme/Widget",
      "--client-id",
      "Iv123456789012345678",
      "--private-key-file",
      "/keys/rivet.pem",
      "--repair",
    ]),
    /unknown argument --repair/,
  );
});
