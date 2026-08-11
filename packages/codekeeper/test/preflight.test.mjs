import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadVerifiedAssets } from "../src/assets.mjs";
import {
  assertNodeVersion,
  assertNoInstallationFiles,
  assertNoSetupBranch,
  inspectInstallationFiles,
  inspectRepository,
  parseGitHubRemote
} from "../src/preflight.mjs";
import {
  assertInstallerCode,
  commandKey,
  createRecordingRunner,
  HEAD_SHA,
  result,
  temporaryDirectory
} from "./helpers.mjs";

const OTHER_SHA = "b".repeat(40);

function preflightRunner(root, options = {}) {
  const settings = {
    originUrl: "https://github.com/acme/widget.git",
    repositoryData: {
      full_name: "acme/widget",
      default_branch: "main",
      owner: { type: "Organization" },
      permissions: { admin: true },
      archived: false,
      disabled: false
    },
    actions: { enabled: true },
    currentBranch: "main",
    status: "",
    headSha: HEAD_SHA,
    remoteSha: HEAD_SHA,
    viewerLogin: "cory",
    localRefs: "",
    remoteRefs: "",
    pulls: [],
    bare: "false",
    sparseStatus: 1,
    sparseValue: "",
    userName: "Cory",
    userEmail: "cory@example.test",
    variables: {
      CODEKEEPER_ENABLED: "true",
      CODEKEEPER_APP_CLIENT_ID: "Iv123456789012345678",
      CODEKEEPER_AUTOMATION_BOT_LOGIN: "codekeeper-widget[bot]"
    },
    failures: new Map(),
    ...options
  };

  return createRecordingRunner((call) => {
    const key = commandKey(call.command, call.args);
    if (settings.failures.has(key)) return result("", { status: settings.failures.get(key), stderr: "simulated failure" });
    const { command, args } = call;
    if (command === "git" && args[0] === "--version") return result("git version 2.50.0\n");
    if (command === "gh" && args[0] === "--version") return result("gh version 2.76.0\n");
    if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") return result(`${root}\n`);
    if (command === "git" && args.join(" ") === "rev-parse --is-bare-repository") return result(`${settings.bare}\n`);
    if (command === "git" && args.join(" ") === "config --bool core.sparseCheckout") {
      return result(`${settings.sparseValue}\n`, { status: settings.sparseStatus });
    }
    if (command === "git" && args[0] === "rev-parse" && args[1] === "--git-path") return result(`.git/${args[2]}\n`);
    if (command === "git" && args.join(" ") === "symbolic-ref --quiet --short HEAD") return result(`${settings.currentBranch}\n`);
    if (command === "git" && args.join(" ") === "remote get-url origin") return result(`${settings.originUrl}\n`);
    if (command === "gh" && args.join(" ") === "auth status --hostname github.com") return result();
    if (command === "gh" && args[0] === "api" && args.at(-1) === "repos/acme/widget") {
      return result(JSON.stringify(settings.repositoryData));
    }
    if (command === "gh" && args[0] === "api" && args.at(-1) === "repos/acme/widget/actions/permissions") {
      return result(JSON.stringify(settings.actions));
    }
    if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") return result(settings.status);
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return result(`${settings.headSha}\n`);
    if (command === "git" && args.join(" ") === "ls-remote origin refs/heads/main") {
      return result(`${settings.remoteSha}\trefs/heads/main\n`);
    }
    if (command === "gh" && args.join(" ") === "api --hostname github.com user --jq .login") return result(`${settings.viewerLogin}\n`);
    if (command === "git" && args.join(" ") === "config --get user.name") return result(`${settings.userName}\n`, { status: settings.userName ? 0 : 1 });
    if (command === "git" && args.join(" ") === "config --get user.email") return result(`${settings.userEmail}\n`, { status: settings.userEmail ? 0 : 1 });
    if (command === "git" && args[0] === "for-each-ref") return result(settings.localRefs);
    if (command === "git" && args[0] === "ls-remote" && args[1] === "--heads") return result(settings.remoteRefs);
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return result(JSON.stringify(settings.pulls));
    if (command === "gh" && args[0] === "variable" && args[1] === "get") return result(`${settings.variables[args[2]] ?? ""}\n`);
    if (command === "gh" && args.join(" ") === "variable list --repo acme/widget --json name,value") {
      return result(JSON.stringify(Object.entries(settings.variables).map(([name, value]) => ({ name, value }))));
    }
    throw new Error(`Unexpected preflight command: ${command} ${args.join(" ")}`);
  });
}

test("GitHub remote parsing accepts only credential-free GitHub.com HTTPS and SSH", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/Acme/Widget.git"), {
    host: "github.com",
    repository: "Acme/Widget",
    protocol: "https"
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/widget.git"), {
    host: "github.com",
    repository: "acme/widget",
    protocol: "ssh"
  });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/acme/widget.git"), {
    host: "github.com",
    repository: "acme/widget",
    protocol: "ssh"
  });
  for (const remote of [
    "https://github.example.com/acme/widget.git",
    "https://token@github.com/acme/widget.git",
    "https://github.com/acme/widget.git?token=secret",
    "ssh://root@github.com/acme/widget.git",
    "git://github.com/acme/widget.git",
    "git@git.example.com:acme/widget.git",
    "https://github.com/acme/nested/widget.git",
    ""
  ]) {
    assert.throws(() => parseGitHubRemote(remote), assertInstallerCode(assert, "UNSUPPORTED_ORIGIN"), remote);
  }
});

test("Node 22 is the minimum supported runtime", () => {
  assert.doesNotThrow(() => assertNodeVersion("22.0.0"));
  assert.doesNotThrow(() => assertNodeVersion("26.1.0"));
  assert.throws(() => assertNodeVersion("21.9.0"), assertInstallerCode(assert, "UNSUPPORTED_NODE"));
  assert.throws(() => assertNodeVersion("not-a-version"), assertInstallerCode(assert, "UNSUPPORTED_NODE"));
});

test("installation-file collision checks reject known, case-colliding, and disguised Codekeeper files", async (t) => {
  await t.test("empty repository passes", async (t) => {
    const root = await temporaryDirectory(t);
    await assertNoInstallationFiles(root);
  });
  await t.test("existing policy fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await writeFile(path.join(root, ".github", "codekeeper.json"), "{}\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "EXISTING_INSTALLATION"));
  });
  await t.test("case-colliding policy fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await writeFile(path.join(root, ".github", "CodeKeeper.JSON"), "{}\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("case-colliding GitHub directory fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".GitHub"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked workflows parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await symlink(outside, path.join(root, ".github", "workflows"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("existing agent profile fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper", "agents", "pr-reviewer.md"), "# Existing\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "EXISTING_INSTALLATION"));
  });
  await t.test("case-colliding agent profile fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper", "agents", "Issue-Triager.MD"), "# Existing\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("case-colliding Codekeeper profile parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "CodeKeeper", "agents"), { recursive: true });
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked Codekeeper profile parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await symlink(outside, path.join(root, ".github", "codekeeper"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked agents parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper"), { recursive: true });
    await symlink(outside, path.join(root, ".github", "codekeeper", "agents"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked agent profile fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(outside, "profile.md"), "# Outside\n");
    await symlink(path.join(outside, "profile.md"), path.join(root, ".github", "codekeeper", "agents", "fixer.md"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("renamed caller invoking Codekeeper fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "automation.yml"), "jobs:\n  call:\n    uses: coryparrry/Codekeeper/.github/workflows/codekeeper-review.yml@abc\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "EXISTING_INSTALLATION"));
  });
  await t.test("unrelated workflow passes", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
    await assertNoInstallationFiles(root);
  });
  await t.test("unrelated profile file passes", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper", "agents", "team-notes.md"), "# Notes\n");
    await assertNoInstallationFiles(root);
  });
});

test("existing generated files are recognized as a rerunnable installation", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await loadVerifiedAssets();
  await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  const legacyPolicy = JSON.parse(bundle.contents["policies/openai.json"]);
  legacyPolicy.ai.agents.plan = structuredClone(legacyPolicy.ai.agents.fix);
  for (const agent of Object.values(legacyPolicy.ai.agents)) agent.maxTurns = 2;
  await writeFile(path.join(root, ".github", "codekeeper.json"), `${JSON.stringify(legacyPolicy, null, 2)}\n`);
  await writeFile(path.join(root, ".github", "codekeeper", "agents", "maintenance-planner.md"), "# Legacy planner\n");
  for (const [name, asset] of [
    ["pr-reviewer.md", "agents/pr-reviewer.md"],
    ["repository-auditor.md", "agents/repository-auditor.md"],
    ["issue-triager.md", "agents/issue-triager.md"]
  ]) await writeFile(path.join(root, ".github", "codekeeper", "agents", name), bundle.contents[asset]);
  await writeFile(path.join(root, ".github", "workflows", "codekeeper-review.yml"), bundle.contents["workflows/review.yml"]);

  const installation = await inspectInstallationFiles(root);
  assert.deepEqual(installation.modes, ["review"]);
  assert.equal(installation.policy.version, 3);
  assert.deepEqual(installation.policy.automation, {
    automaticPrReview: true,
    reviewFeedbackTriage: true,
    issueTriage: true,
    ownerRequests: true,
    maintenanceSchedule: "17 7 * * *"
  });
  assert.equal(installation.policy.review.createDeferredIssues, false);
  assert.deepEqual(installation.policy.ai.providers.openrouter, {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "chat_completions",
    structuredOutputs: false,
    supportsReasoningEffort: false
  });
  assert.equal(installation.policy.labels["codekeeper:deferred"].color, "C5DEF5");
  assert.equal(installation.policy.ai.agents.review.model, "gpt-5.6-sol");
  assert.equal(installation.policy.ai.agents.plan, undefined);
  for (const agent of ["review", "audit", "issue", "fix"]) {
    assert.equal(installation.policy.ai.agents[agent].maxTurns, 1);
  }
  assert.deepEqual(installation.legacyFiles, [".github/codekeeper/agents/maintenance-planner.md"]);
  assert.equal(installation.contents[".github/codekeeper/agents/fixer.md"], undefined);
  const inspected = await inspectRepository({ runner: preflightRunner(root), cwd: root });
  assert.equal(inspected.updateBranch, `codekeeper/update-${HEAD_SHA.slice(0, 12)}`);
  assert.equal(inspected.existingSettings.enabled, true);
  assert.equal(inspected.existingSettings.appClientId, "Iv123456789012345678");
  assert.equal(inspected.existingSettings.automationBotLogin, "codekeeper-widget[bot]");
  const legacy = await inspectRepository({
    runner: preflightRunner(root, {
      variables: {
        CODEKEEPER_ENABLED: "true",
        CODEKEEPER_APP_CLIENT_ID: "Iv123456789012345678"
      }
    }),
    cwd: root
  });
  assert.equal(legacy.existingSettings.automationBotLogin, null);
});

test("setup branch collision detection covers local refs, remote refs, and prior pull requests", async () => {
  for (const [name, options] of [
    ["local", { localRefs: "refs/heads/codekeeper/setup\n" }],
    ["local namespace", { localRefs: "refs/heads/codekeeper/setup/child\n" }],
    ["remote", { remoteRefs: `${HEAD_SHA}\trefs/heads/codekeeper/setup\n` }],
    ["pull request", { pulls: [{ number: 7, url: "https://github.com/acme/widget/pull/7" }] }]
  ]) {
    const runner = preflightRunner("/tmp/widget", options);
    await assert.rejects(
      assertNoSetupBranch({ runner, root: "/tmp/widget", repository: "acme/widget" }),
      assertInstallerCode(assert, "SETUP_BRANCH_EXISTS"),
      name
    );
  }
});

test("repository preflight returns a frozen snapshot only after every local and GitHub check passes", async (t) => {
  const root = await temporaryDirectory(t);
  const resolvedRoot = await realpath(root);
  const runner = preflightRunner(root);
  const inspected = await inspectRepository({ runner, cwd: root, nodeVersion: "22.0.0", interactive: true });
  assert.deepEqual(inspected, {
    root: resolvedRoot,
    originUrl: "https://github.com/acme/widget.git",
    repository: "acme/widget",
    ownerType: "Organization",
    defaultBranch: "main",
    currentBranch: "main",
    headSha: HEAD_SHA,
    remoteDefaultSha: HEAD_SHA,
    viewerLogin: "cory",
    displayName: "widget"
  });
  assert.ok(Object.isFrozen(inspected));
  assert.ok(runner.calls.every((call) => !call.options.env));
  const ghCalls = runner.calls.filter((call) => call.command === "gh");
  assert.ok(ghCalls.some((call) => call.args.includes("--hostname") && call.args.includes("github.com")));
});

test("repository preflight rejects the v1 negative matrix before installation mutation", async (t) => {
  const root = await temporaryDirectory(t);
  const authKey = commandKey("gh", ["auth", "status", "--hostname", "github.com"]);
  const ghVersionKey = commandKey("gh", ["--version"]);
  const detachedKey = commandKey("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const cases = [
    ["non-interactive", { interactive: false }, {}, "NON_INTERACTIVE"],
    ["missing gh", {}, { failures: new Map([[ghVersionKey, 127]]) }, "COMMAND_FAILED"],
    ["failed authentication", {}, { failures: new Map([[authKey, 1]]) }, "COMMAND_FAILED"],
    ["GHES", {}, { originUrl: "https://github.acme.test/acme/widget.git" }, "UNSUPPORTED_ORIGIN"],
    ["detached HEAD", {}, { failures: new Map([[detachedKey, 1]]) }, "COMMAND_FAILED"],
    ["dirty checkout", {}, { status: "?? notes.txt\n" }, "DIRTY_CHECKOUT"],
    ["stale checkout", {}, { remoteSha: OTHER_SHA }, "STALE_CHECKOUT"],
    ["not admin", {}, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "Organization" }, permissions: { admin: false } } }, "ADMIN_REQUIRED"],
    ["origin/API mismatch", {}, { repositoryData: { full_name: "other/widget", default_branch: "main", owner: { type: "Organization" }, permissions: { admin: true } } }, "REPOSITORY_MISMATCH"],
    ["actions disabled", {}, { actions: { enabled: false } }, "ACTIONS_DISABLED"],
    ["wrong branch", {}, { currentBranch: "feature" }, "WRONG_BRANCH"],
    ["archived repository", {}, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "Organization" }, permissions: { admin: true }, archived: true } }, "UNSUPPORTED_REPOSITORY"],
    ["sparse checkout", {}, { sparseStatus: 0, sparseValue: "true" }, "UNSUPPORTED_CHECKOUT"],
    ["missing git identity", {}, { userEmail: "" }, "GIT_IDENTITY_REQUIRED"],
    ["setup branch exists", {}, { localRefs: "refs/heads/codekeeper/setup\n" }, "SETUP_BRANCH_EXISTS"]
  ];
  for (const [name, inspectOptions, runnerOptions, code] of cases) {
    await t.test(name, async () => {
      const runner = preflightRunner(root, runnerOptions);
      await assert.rejects(
        inspectRepository({ runner, cwd: root, nodeVersion: "22.0.0", interactive: true, ...inspectOptions }),
        assertInstallerCode(assert, code)
      );
      assert.ok(runner.calls.every((call) => !["push", "commit", "secret", "variable"].some((token) => call.args.includes(token))));
    });
  }
});

test("repository preflight accepts personal and organization owners and fails closed for an unknown owner type", async (t) => {
  const root = await temporaryDirectory(t);
  const personal = await inspectRepository({
    runner: preflightRunner(root, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "User" }, permissions: { admin: true } } }),
    cwd: root,
    nodeVersion: "22.0.0",
    interactive: true
  });
  assert.equal(personal.ownerType, "User");

  await assert.rejects(
    inspectRepository({
      runner: preflightRunner(root, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "Bot" }, permissions: { admin: true } } }),
      cwd: root,
      nodeVersion: "22.0.0",
      interactive: true
    }),
    assertInstallerCode(assert, "PREFLIGHT_INVALID_RESPONSE")
  );
});
