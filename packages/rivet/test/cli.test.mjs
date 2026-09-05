import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";

function output() {
  let value = "";
  return {
    stream: { write: (chunk) => (value += chunk) },
    read: () => value,
  };
}

async function configuredRepository(t, configuration) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-cli-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".github"));
  await writeFile(
    path.join(root, ".github/rivet.json"),
    typeof configuration === "string"
      ? configuration
      : JSON.stringify(configuration),
  );
  return root;
}

test("preserves installed settings while applying explicit setup-PR overrides", async (t) => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.models.review.model = "custom-model";
  configuration.review.maximumFindings = 3;
  const root = await configuredRepository(t, configuration);
  let received;
  await runCli(
    [
      "init",
      "--repair",
      "--issues",
      "disabled",
      "--maintenance",
      "manual",
      "--setup-pr",
    ],
    {
      cwd: root,
      stdout: output().stream,
      createRepairSetupPullRequestImpl: async (options) => {
        received = options;
        return {};
      },
    },
  );
  assert.deepEqual(received.configuration, {
    ...configuration,
    repair: { authority: "owner" },
    issues: { ...configuration.issues, triage: "disabled" },
    maintenance: { mode: "manual" },
  });
  assert.equal(received.repositoryRoot, root);
});

test("bare init defers configuration loading until guided setup resolves the repository", async () => {
  let received;
  await runCli(["init"], {
    cwd: "/repo/nested/source",
    runGuidedInitImpl: async (options) => {
      received = options;
    },
  });
  assert.equal(received.cwd, "/repo/nested/source");
  assert.equal(received.configuration, undefined);
});

test("rejects malformed or invalid installed configuration before installation", async (t) => {
  for (const configuration of [
    "{",
    { ...DEFAULT_RIVET_CONFIG, schemaVersion: 999 },
  ]) {
    const root = await configuredRepository(t, configuration);
    let calls = 0;
    await assert.rejects(
      runCli(["init", "--review-only", "--dry-run"], {
        cwd: root,
        stdout: output().stream,
        installReviewImpl: async () => {
          calls += 1;
        },
      }),
      /invalid configuration at .*rivet\.json/,
    );
    assert.equal(calls, 0);
  }
});

test("routes bare init to the guided review-only setup", async () => {
  const stdout = output();
  const stderr = output();
  const stdin = { isTTY: true };
  const environment = { TERM: "xterm" };
  const expected = { pullRequestUrl: "https://github.com/acme/repo/pull/3" };
  let received;
  const result = await runCli(["init"], {
    cwd: "/repo",
    environment,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runGuidedInitImpl: async (options) => {
      received = options;
      return expected;
    },
  });

  assert.equal(result, expected);
  assert.equal(stdout.read(), "");
  assert.deepEqual(received, {
    cwd: "/repo",
    env: environment,
    stdio: { stdin, stdout: stdout.stream, stderr: stderr.stream },
  });
});

test("prints useful help without starting guided setup", async () => {
  for (const argv of [[], ["--help"], ["init", "--help"]]) {
    const stdout = output();
    let guidedCalls = 0;
    const result = await runCli(argv, {
      stdout: stdout.stream,
      runGuidedInitImpl: async () => {
        guidedCalls += 1;
      },
    });

    assert.equal(result, 0);
    assert.equal(guidedCalls, 0);
    assert.match(stdout.read(), /npx @coryparry\/rivet init/);
    assert.match(stdout.read(), /init --review-only/);
    assert.match(stdout.read(), /init --repair/);
    assert.match(stdout.read(), /--issues <disabled\|automatic>/);
  }
});

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

test("routes explicit init progress to TTY stderr while keeping stdout as JSON", async () => {
  const stdout = output();
  const stderr = output();
  stderr.stream.isTTY = true;
  const expected = { mode: "review", files: [] };

  await runCli(
    ["init", "--review-only", "--repository", "/repo", "--dry-run"],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      installReviewImpl: async (options) => {
        options.onProgress("Preparing Rivet installation");
        options.onProgress("Checking existing Rivet installation");
        return expected;
      },
    },
  );

  assert.deepEqual(JSON.parse(stdout.read()), expected);
  assert.equal(
    stderr.read(),
    "Rivet: Preparing Rivet installation...\n" +
      "Rivet: Checking existing Rivet installation...\n",
  );
});

test("does not add progress output or callback for non-TTY explicit init", async () => {
  const stderr = output();
  let received;
  await runCli(["init", "--review-only", "--dry-run"], {
    stdout: output().stream,
    stderr: stderr.stream,
    installReviewImpl: async (options) => {
      received = options;
      return { mode: "review", files: [] };
    },
  });

  assert.equal(received.onProgress, undefined);
  assert.equal(stderr.read(), "");
});

test("enables report-only maintenance through explicit init", async () => {
  for (const mode of ["disabled", "manual", "scheduled"]) {
    let options;
    await runCli(
      ["init", "--review-only", "--maintenance", mode, "--dry-run"],
      {
        stdout: output().stream,
        installReviewImpl: async (value) => {
          options = value;
          return { mode: "review", files: [] };
        },
      },
    );
    assert.equal(options.configuration.maintenance.mode, mode);
    assert.equal(options.configuration.models.review.model, "gpt-5.6-luna");
  }
});

test("passes explicit issue and maintenance modes through init", async () => {
  for (const issues of ["disabled", "automatic"]) {
    let options;
    await runCli(["init", "--review-only", "--issues", issues, "--dry-run"], {
      stdout: output().stream,
      installReviewImpl: async (value) => {
        options = value;
        return { mode: "review", files: [] };
      },
    });
    assert.equal(options.configuration.issues.triage, issues);
    assert.equal(options.configuration.maintenance.mode, "disabled");
  }

  let options;
  await runCli(
    [
      "init",
      "--repair",
      "--issues",
      "disabled",
      "--maintenance",
      "manual",
      "--dry-run",
    ],
    {
      stdout: output().stream,
      installRepairImpl: async (value) => {
        options = value;
        return { mode: "repair", files: [] };
      },
    },
  );
  assert.equal(options.configuration.issues.triage, "disabled");
  assert.equal(options.configuration.maintenance.mode, "manual");
  assert.equal(options.configuration.repair.authority, "owner");
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
    issues: "write",
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

test("rejects conflicting explicit modes and unknown arguments", async () => {
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
  await assert.rejects(
    runCli(["init", "--review-only", "--maintenance", "daily"]),
    /must be disabled, manual, or scheduled/,
  );
  await assert.rejects(
    runCli(["init", "--review-only", "--issues", "owner"]),
    /must be disabled or automatic/,
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
