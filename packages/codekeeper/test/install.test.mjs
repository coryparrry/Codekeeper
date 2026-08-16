import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../src/assets.mjs";
import { createCommandRunner } from "../src/command-runner.mjs";
import { configureRepositorySettings, createSetupCommit, pushAndOpenSetupPullRequest, remoteSetupRecovery, SECRET_UPLOAD_TIMEOUT_MS } from "../src/install.mjs";
import { buildInstallPlan } from "../src/plan.mjs";
import {
  assertInstallerCode,
  createRecordingRunner,
  git,
  HEAD_SHA,
  loadVerifiedAssets,
  result,
  temporaryDirectory,
  textSink
} from "./helpers.mjs";

const COMMIT_SHA = "c".repeat(40);
const SECRET_CANARY = "sk-secret-value-must-never-appear";

async function completePlan(overrides = {}) {
  const bundle = await loadVerifiedAssets();
  return buildInstallPlan({
    bundle,
    snapshot: {
      root: "/tmp/widget",
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: HEAD_SHA
    },
    answers: {
      modes: ["review", "issues", "fix"],
      preset: "mixed",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]",
      enabled: true
    },
    ...overrides
  });
}

function simplePlan(root, originalHead, fileContents = [
  [".github/codekeeper.json", "{}\n"],
  [".github/workflows/codekeeper-review.yml", "name: Codekeeper review\n"]
]) {
  const files = fileContents.map(([filePath, contents]) => ({
    path: filePath,
    contents,
    bytes: Buffer.byteLength(contents),
    sha256: sha256(contents)
  }));
  return {
    root,
    repository: "acme/widget",
    defaultBranch: "main",
    originalHead,
    files,
    variables: [
      { name: "CODEKEEPER_ENABLED", value: "false" },
      { name: "CODEKEEPER_APP_CLIENT_ID", value: "Iv123456789012345678" }
    ],
    secrets: [{ name: "OPENAI_API_KEY" }, { name: "OPENAI_TRACE_API_KEY" }, { name: "CODEKEEPER_APP_PRIVATE_KEY" }],
    branch: "codekeeper/setup",
    commitMessage: "chore(codekeeper): add setup",
    pullRequest: {
      title: "chore(codekeeper): add setup",
      body: "Setup only. Cory's approval is still required."
    }
  };
}

async function committedRepository(t) {
  const root = await temporaryDirectory(t, "codekeeper-git-");
  git(root, ["init", "--template=", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Codekeeper Test"]);
  git(root, ["config", "user.email", "codekeeper@example.test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  git(root, ["config", "core.fsmonitor", "false"]);
  await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]).trim() };
}

function isolatedCommandRunner(root) {
  return createCommandRunner({
    environment: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, ".config"),
      LANG: "C"
    }
  });
}

test("repository settings set secrets and non-startup variables before startup through private stdin", async () => {
  const basePlan = await completePlan();
  const plan = {
    ...basePlan,
    secrets: basePlan.secrets.map((secret) => ({
      ...secret,
      value: SECRET_CANARY
    }))
  };
  const output = textSink();
  const enteredSecrets = [];
  const runner = createRecordingRunner(async (call) => {
    if (typeof call.options.provideInput === "function") {
      let received = "";
      await call.options.provideInput((value) => { received += value; });
      assert.equal(received, SECRET_CANARY);
    }
    return result();
  });
  const privateKeyPath = "/private/tmp/codekeeper-secret-path-canary.pem";
  let closed = 0;
  const progressEvents = [];
  const openInputFile = (selectedPath) => {
    assert.equal(selectedPath, privateKeyPath);
    return { descriptor: 37, close() { closed += 1; } };
  };
  await configureRepositorySettings(plan, {
    runner,
    output,
    appPrivateKeyPath: privateKeyPath,
    openInputFile,
    onProgress(event) {
      progressEvents.push(event);
    },
    async withSecretInput({ name, purpose, write }) {
      enteredSecrets.push({ name, purpose });
      write(SECRET_CANARY);
    },
    resumeCommand: "'node' 'codekeeper.mjs' 'init'"
  });

  const secretCalls = runner.calls.filter((call) => call.args[0] === "secret");
  assert.equal(runner.calls[0].command, "gh");
  assert.equal(runner.calls[0].args[0], "secret");
  assert.deepEqual(secretCalls.map((call) => call.args[2]), [
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_TRACE_API_KEY",
    "CODEKEEPER_APP_PRIVATE_KEY"
  ]);
  for (const call of secretCalls.filter((call) => call.args[2] !== "CODEKEEPER_APP_PRIVATE_KEY")) {
    assert.deepEqual(call.args.slice(0, 2), ["secret", "set"]);
    assert.deepEqual(call.args.slice(3), ["--app", "actions", "--repo", "acme/widget"]);
    assert.equal(call.options.cwd, "/tmp/widget");
    assert.equal(call.options.stdio, "ignore");
    assert.equal(call.options.timeoutMs, SECRET_UPLOAD_TIMEOUT_MS);
    assert.equal(typeof call.options.provideInput, "function");
    assert.ok(!Object.hasOwn(call.options, "env"));
    assert.ok(!Object.hasOwn(call.options, "input"));
    assert.ok(!call.args.includes("--body"));
  }
  const appSecretCall = secretCalls.find((call) => call.args[2] === "CODEKEEPER_APP_PRIVATE_KEY");
  assert.deepEqual(appSecretCall.options, {
    cwd: "/tmp/widget",
    stdio: "ignore",
    stdinFd: 37,
    timeoutMs: SECRET_UPLOAD_TIMEOUT_MS
  });
  assert.equal(closed, 1);
  assert.deepEqual(enteredSecrets.map(({ name }) => name), ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_TRACE_API_KEY"]);
  assert.ok(enteredSecrets.every(({ purpose }) => typeof purpose === "string" && purpose.length > 20));
  const providerDone = progressEvents.findIndex((event) => event.id === "secret:provider" && event.status === "done");
  const appActive = progressEvents.findIndex((event) => event.id === "secret:app" && event.status === "active");
  assert.ok(providerDone >= 0 && providerDone < appActive, "provider prompts must complete before App fd progress starts");
  assert.deepEqual(
    progressEvents.filter((event) => ["settings:disable", "secret:app", "variables:configure"].includes(event.id)),
    [
      {
        id: "secret:app",
        status: "active",
        detail: "CODEKEEPER_APP_PRIVATE_KEY — downloaded GitHub App PEM private key used to mint App installation tokens"
      },
      { id: "secret:app", status: "done" },
      { id: "variables:configure", status: "active" },
      { id: "variables:configure", status: "done" },
      { id: "settings:disable", status: "active" },
      { id: "settings:disable", status: "done" }
    ]
  );
  assert.deepEqual(runner.calls.slice(secretCalls.length).map((call) => call.args.slice(0, 4)), [
    ["variable", "set", "CODEKEEPER_APP_CLIENT_ID", "--body"],
    ["variable", "set", "CODEKEEPER_AUTOMATION_BOT_LOGIN", "--body"],
    ["variable", "set", "CODEKEEPER_ENABLED", "--body"]
  ]);
  const transcript = JSON.stringify(runner.calls) + output.toString();
  assert.doesNotMatch(transcript, new RegExp(SECRET_CANARY));
  assert.doesNotMatch(transcript, /codekeeper-secret-path-canary/);
  assert.equal(runner.calls.at(-1).args.includes("true"), true);
});

test("invalid plans stop before mutation and startup failure occurs after settings", async () => {
  const valid = await completePlan();
  const invalid = {
    ...valid,
    variables: [{ name: "CODEKEEPER_ENABLED", value: "sometimes" }, ...valid.variables.slice(1)]
  };
  const invalidRunner = createRecordingRunner(() => result());
  await assert.rejects(
    configureRepositorySettings(invalid, {
      runner: invalidRunner,
      output: textSink(),
      appPrivateKeyPath: "/private/tmp/unused.pem",
      openInputFile() {
        throw new Error("invalid plan must be rejected before opening the key");
      }
    }),
    assertInstallerCode(assert, "PLAN_INVALID")
  );
  assert.deepEqual(invalidRunner.calls, []);

  const runner = createRecordingRunner((call) => call.args.includes("CODEKEEPER_ENABLED") ? result("", { status: 1 }) : result());
  let closed = 0;
  await assert.rejects(
    configureRepositorySettings(valid, {
      runner,
      output: textSink(),
      appPrivateKeyPath: "/private/tmp/codekeeper-test.pem",
      openInputFile: () => ({ descriptor: 38, close() { closed += 1; } }),
      resumeCommand: "safe resume"
    }),
    (error) => error.code === "EXTERNAL_MUTATION_FAILED" && error.resume === "safe resume"
  );
  assert.equal(runner.calls.length, 7);
  assert.ok(runner.calls.at(-1).args.includes("CODEKEEPER_ENABLED"));
  assert.equal(closed, 1);
});

test("secret or variable failure stops later settings", async () => {
  const plan = await completePlan();
  for (const failedName of ["DEEPSEEK_API_KEY", "CODEKEEPER_APP_CLIENT_ID"]) {
    const runner = createRecordingRunner((call) => call.args.includes(failedName) ? result("", { status: 1 }) : result());
    let closed = 0;
    await assert.rejects(
      configureRepositorySettings(plan, {
        runner,
        output: textSink(),
        appPrivateKeyPath: "/private/tmp/codekeeper-test.pem",
        openInputFile: () => ({ descriptor: 39, close() { closed += 1; } }),
        resumeCommand: "resume exactly"
      }),
      (error) => error.code === "EXTERNAL_MUTATION_FAILED" && error.resume === "resume exactly" && error.receipt.unknownMutation === true && error.receipt.phase === `settings:${failedName.includes("API_KEY") ? "secret" : "variable"}:${failedName}`
    );
    const failedIndex = runner.calls.findIndex((call) => call.args.includes(failedName));
    assert.equal(failedIndex, runner.calls.length - 1);
    assert.equal(runner.calls.some((call) => call.args.includes("CODEKEEPER_ENABLED")), false);
    assert.equal(closed, 1);
  }
});

test("a pushed setup failure returns durable manual recovery instead of an unusable init rerun", () => {
  const plan = simplePlan("/tmp/widget", HEAD_SHA);
  const recovery = remoteSetupRecovery(
    plan,
    {
      remoteSha: COMMIT_SHA,
      branch: plan.branch,
      unknownMutation: true,
      pendingSecrets: ["OPENAI_API_KEY"],
      pendingVariables: ["CODEKEEPER_APP_CLIENT_ID", "CODEKEEPER_ENABLED"]
    },
    "linux"
  );
  assert.match(recovery, /already pushed.*Do not rerun Codekeeper init/s);
  assert.match(recovery, /OPENAI_API_KEY/);
  assert.match(recovery, /'gh' 'variable' 'set' 'CODEKEEPER_APP_CLIENT_ID'/);
  assert.match(recovery, /Set the startup choice last/);
  assert.match(recovery, /'gh' 'variable' 'set' 'CODEKEEPER_ENABLED'/);
  assert.match(recovery, /'gh' 'pr' 'list'/);
  assert.match(recovery, /If no pull request is listed: 'gh' 'pr' 'create'/);
});

test("push uses the verified full SHA and verifies the remote branch both before and after PR creation", async () => {
  const plan = simplePlan("/tmp/widget", HEAD_SHA);
  let remoteReads = 0;
  const progressEvents = [];
  const runner = createRecordingRunner((call) => {
    if (call.command === "git" && call.args[0] === "push") return result();
    if (call.command === "git" && call.args[0] === "ls-remote") {
      remoteReads += 1;
      return result(`${COMMIT_SHA}\trefs/heads/codekeeper/setup\n`);
    }
    if (call.command === "gh" && call.args[0] === "pr") return result("https://github.com/acme/widget/pull/42\n");
    throw new Error(`Unexpected publication call: ${call.command} ${call.args.join(" ")}`);
  });
  const url = await pushAndOpenSetupPullRequest(plan, COMMIT_SHA, {
    runner,
    platform: "linux",
    onProgress(event) {
      progressEvents.push(event);
    }
  });
  assert.equal(url, "https://github.com/acme/widget/pull/42");
  assert.equal(remoteReads, 2);
  assert.deepEqual(runner.calls.map((call) => [call.command, ...call.args.slice(0, 2)]), [
    ["git", "push", "origin"],
    ["git", "ls-remote", "--refs"],
    ["gh", "pr", "create"],
    ["git", "ls-remote", "--refs"]
  ]);
  assert.deepEqual(runner.calls[0].args, ["push", "origin", `${COMMIT_SHA}:refs/heads/codekeeper/setup`]);
  assert.deepEqual(progressEvents, [
    { id: "git:push", status: "active" },
    { id: "git:push", status: "done" },
    { id: "github:pull-request", status: "active" },
    { id: "github:pull-request", status: "done" }
  ]);
  const serialized = JSON.stringify(runner.calls);
  assert.doesNotMatch(serialized, /--force|--set-upstream|\bmerge\b|workflow.*run|dispatch|CODEKEEPER_ENABLED|enable/i);
});

test("publication refuses invalid SHA, push failure, remote mismatch, PR failure, and post-PR drift with recovery commands", async (t) => {
  const plan = simplePlan("/tmp/widget", HEAD_SHA);
  await t.test("invalid SHA", async () => {
    const runner = createRecordingRunner(() => result());
    await assert.rejects(
      pushAndOpenSetupPullRequest(plan, "HEAD", { runner }),
      assertInstallerCode(assert, "COMMIT_SHA_INVALID")
    );
    assert.deepEqual(runner.calls, []);
  });
  await t.test("push failure", async () => {
    const runner = createRecordingRunner(() => result("", { status: 1 }));
    await assert.rejects(
      pushAndOpenSetupPullRequest(plan, COMMIT_SHA, {
        runner,
        platform: "linux"
      }),
      (error) => error.code === "EXTERNAL_MUTATION_FAILED" && error.resume.includes(`'${COMMIT_SHA}:refs/heads/codekeeper/setup'`) && error.resume.includes("'gh' 'pr' 'create'")
    );
    assert.equal(runner.calls.length, 1);
  });
  await t.test("pre-PR remote mismatch", async () => {
    const runner = createRecordingRunner((call) => call.args[0] === "ls-remote"
      ? result(`${HEAD_SHA}\trefs/heads/codekeeper/setup\n`)
      : result());
    await assert.rejects(
      pushAndOpenSetupPullRequest(plan, COMMIT_SHA, { runner }),
      assertInstallerCode(assert, "REMOTE_COMMIT_MISMATCH")
    );
    assert.equal(runner.calls.some((call) => call.command === "gh"), false);
  });
  await t.test("PR creation failure", async () => {
    const runner = createRecordingRunner((call) => {
      if (call.args[0] === "ls-remote") return result(`${COMMIT_SHA}\trefs/heads/codekeeper/setup\n`);
      if (call.command === "gh") return result("", { status: 1 });
      return result();
    });
    await assert.rejects(
      pushAndOpenSetupPullRequest(plan, COMMIT_SHA, {
        runner,
        platform: "win32"
      }),
      (error) => error.code === "EXTERNAL_MUTATION_FAILED" && error.resume.startsWith("& 'gh' 'pr' 'list'") && error.resume.includes("If no pull request is listed: & 'gh' 'pr' 'create'") && error.resume.includes("Cory''s approval")
    );
  });
  await t.test("post-PR remote drift", async () => {
    let remoteReads = 0;
    const runner = createRecordingRunner((call) => {
      if (call.args[0] === "ls-remote") {
        remoteReads += 1;
        const sha = remoteReads === 1 ? COMMIT_SHA : HEAD_SHA;
        return result(`${sha}\trefs/heads/codekeeper/setup\n`);
      }
      if (call.command === "gh") return result("https://github.com/acme/widget/pull/42\n");
      return result();
    });
    await assert.rejects(
      pushAndOpenSetupPullRequest(plan, COMMIT_SHA, { runner }),
      (error) => error.code === "REMOTE_COMMIT_MISMATCH" && error.resume.includes("gh' 'pr' 'view")
    );
  });
});

test("real Git integration creates one exact generated-only commit without broad staging", async (t) => {
  const { root, head } = await committedRepository(t);
  const plan = await completePlan({
    snapshot: {
      root,
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: head,
      viewerLogin: "cory"
    }
  });
  const actual = isolatedCommandRunner(root);
  const calls = [];
  const progressEvents = [];
  const runner = {
    async run(command, args, options) {
      calls.push({ command, args: [...args], options: { ...options } });
      return actual.run(command, args, options);
    }
  };
  const commit = await createSetupCommit(plan, {
    runner,
    resumeCommand: "codekeeper init",
    onProgress(event) {
      progressEvents.push(event);
    }
  });
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(git(root, ["branch", "--show-current"]).trim(), "codekeeper/setup");
  assert.equal(git(root, ["rev-parse", "HEAD^"]).trim(), head);
  assert.deepEqual(git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n").sort(), plan.files.map((file) => file.path).sort());
  assert.deepEqual(plan.files.filter((file) => file.path.startsWith(".github/codekeeper/agents/")), []);
  assert.equal(git(root, ["status", "--porcelain=v1"]), "");
  assert.deepEqual(calls.find((call) => call.command === "git" && call.args[0] === "add").args, [
    "add", "--", ...plan.files.map((file) => file.path)
  ]);
  assert.deepEqual(calls.find((call) => call.command === "git" && call.args[0] === "commit").args, [
    "commit", "--only", "-m", plan.commitMessage, "--", ...plan.files.map((file) => file.path)
  ]);
  assert.deepEqual(progressEvents, [
    { id: "git:commit", status: "active" },
    { id: "git:commit", status: "done" }
  ]);
  assert.ok(calls.every((call) => !call.args.includes("-A") && !call.args.includes("--all") && !call.args.includes("--force")));
});

test("real Git integration reruns can change configuration and remove a workflow exactly", async (t) => {
  const { root, head } = await committedRepository(t);
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: {
      root,
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: head,
      viewerLogin: "cory"
    },
    answers: {
      modes: ["review", "maintain"],
      preset: "openai",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]",
      enabled: true
    }
  });
  for (const file of initial.files) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.contents);
  }
  const profileTarget = ".github/codekeeper/agents/pr-reviewer.md";
  const profileContents = `${bundle.contents["agents/pr-reviewer.md"]}\nTeam preference: report API regressions first.\n`;
  await mkdir(path.dirname(path.join(root, profileTarget)), {
    recursive: true
  });
  await writeFile(path.join(root, profileTarget), profileContents);
  git(root, ["add", ".github"]);
  git(root, ["commit", "-m", "install codekeeper"]);
  const installedHead = git(root, ["rev-parse", "HEAD"]).trim();
  const contents = {};
  for (const file of initial.files) contents[file.path] = await readFile(path.join(root, file.path), "utf8");
  contents[profileTarget] = profileContents;
  const update = buildInstallPlan({
    bundle,
    snapshot: {
      root,
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: installedHead,
      viewerLogin: "cory",
      installation: {
        policy: JSON.parse(contents[".github/codekeeper.json"]),
        policySource: contents[".github/codekeeper.json"],
        modes: ["review", "maintain"],
        contents
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-widget[bot]"
      },
      updateBranch: `codekeeper/update-${installedHead.slice(0, 12)}`
    },
    answers: {
      modes: ["review"],
      preset: "openai",
      models: { review: "luna-max" },
      tracing: true,
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]",
      enabled: true,
      capabilities: []
    }
  });
  const commit = await createSetupCommit(update, {
    runner: isolatedCommandRunner(root)
  });
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(git(root, ["branch", "--show-current"]).trim(), `codekeeper/update-${installedHead.slice(0, 12)}`);
  assert.deepEqual(git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n").sort(), [
    ".github/codekeeper-release.json",
    ".github/codekeeper.json",
    ".github/workflows/codekeeper-assistant.yml",
    ".github/workflows/codekeeper-maintain.yml"
  ]);
  assert.match(
    await readFile(path.join(root, ".github/workflows/codekeeper-assistant.yml"), "utf8"),
    /installed_modes: review/
  );
  await assert.rejects(readFile(path.join(root, ".github/workflows/codekeeper-maintain.yml"), "utf8"), /ENOENT/);
  assert.match(await readFile(path.join(root, ".github/codekeeper/agents/pr-reviewer.md"), "utf8"), /Team preference/);
  const policy = JSON.parse(await readFile(path.join(root, ".github/codekeeper.json"), "utf8"));
  assert.equal(policy.ai.agents.review.model, "gpt-5.6-luna");
});

test("pre-push commit trust checks reject parent, inventory, and blob mismatches", async (t) => {
  for (const [name, expectedCode, intercept] of [
    [
      "parent",
      "COMMIT_PARENT_MISMATCH",
      (command, args) => command === "git" && args.join(" ") === "rev-parse HEAD^" ? result(HEAD_SHA) : null
    ],
    [
      "inventory",
      "UNRELATED_PATH",
      (command, args, plan) => command === "git" && args[0] === "diff-tree"
        ? result(`${plan.files.map((file) => file.path).join("\0")}\0unrelated.txt\0`)
        : null
    ],
    [
      "blob",
      "COMMITTED_FILE_MISMATCH",
      (command, args) => command === "git" && args[0] === "show" && args[1].startsWith("HEAD:")
        ? result("tampered committed bytes\n")
        : null
    ]
  ]) {
    await t.test(name, async (t) => {
      const { root, head } = await committedRepository(t);
      const plan = simplePlan(root, head);
      const actual = isolatedCommandRunner(root);
      const calls = [];
      const runner = {
        async run(command, args, options) {
          calls.push([command, ...args]);
          const injected = intercept(command, args, plan);
          return injected ?? actual.run(command, args, options);
        }
      };
      await assert.rejects(
        createSetupCommit(plan, { runner, resumeCommand: "codekeeper init" }),
        assertInstallerCode(assert, expectedCode)
      );
      assert.equal(calls.some((call) => call[0] === "git" && call[1] === "push"), false);
    });
  }
});

test("real Git integration preserves unrelated staged work and removes only recoverable generated files", async (t) => {
  const { root, head } = await committedRepository(t);
  await writeFile(path.join(root, "notes.txt"), "private user work\n");
  git(root, ["add", "notes.txt"]);
  const plan = simplePlan(root, head);
  const runner = isolatedCommandRunner(root);
  await assert.rejects(
    createSetupCommit(plan, { runner, resumeCommand: "codekeeper init" }),
    (error) => error.code === "UNRELATED_PATH" && error.resume.includes("git") && error.resume.includes("status")
  );
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head);
  assert.equal(git(root, ["diff", "--cached", "--name-only"]).trim(), "notes.txt");
  assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "private user work\n");
  for (const file of plan.files) {
    await assert.rejects(readFile(path.join(root, file.path)), (error) => error.code === "ENOENT");
  }
});

test("real Git integration detects post-commit hook mutation before any push", async (t) => {
  const { root, head } = await committedRepository(t);
  const hook = path.join(root, ".git", "hooks", "post-commit");
  await writeFile(hook, "#!/bin/sh\nprintf 'hook mutation\\n' > hook-output.txt\n", { mode: 0o755 });
  const plan = simplePlan(root, head);
  const calls = [];
  const actual = isolatedCommandRunner(root);
  const runner = {
    async run(command, args, options) {
      calls.push([command, ...args]);
      return actual.run(command, args, options);
    }
  };
  await assert.rejects(
    createSetupCommit(plan, { runner, resumeCommand: "codekeeper init" }),
    (error) => error.code === "WORKTREE_CHANGED" && error.resume.includes("git") && error.resume.includes("status")
  );
  assert.equal(await readFile(path.join(root, "hook-output.txt"), "utf8"), "hook mutation\n");
  assert.equal(git(root, ["rev-parse", "HEAD^"]).trim(), head);
  assert.equal(calls.some((call) => call[0] === "git" && call[1] === "push"), false);
});

test("real Git integration rolls back a pre-commit generated-file failure to the clean default branch", async (t) => {
  const { root, head } = await committedRepository(t);
  const plan = simplePlan(root, head, [[".github/codekeeper.json", '{ "bad": true }   \n']]);
  await assert.rejects(
    createSetupCommit(plan, {
      runner: isolatedCommandRunner(root),
      resumeCommand: "'node' 'cli.mjs' 'init'"
    }),
    (error) => error.code === "COMMAND_FAILED" && error.resume === "'node' 'cli.mjs' 'init'"
  );
  assert.equal(git(root, ["branch", "--show-current"]).trim(), "main");
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head);
  assert.doesNotMatch(git(root, ["branch", "--list"]), /codekeeper\/setup/);
  assert.equal(git(root, ["status", "--porcelain=v1"]), "");
  await assert.rejects(readFile(path.join(root, ".github", "codekeeper.json")), (error) => error.code === "ENOENT");
});
