import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadVerifiedAssets } from "../src/assets.mjs";
import { currentResumeCommand, parseCliArgs, runCli, USAGE } from "../src/cli.mjs";
import { createCommandRunner } from "../src/command-runner.mjs";
import { buildInstallPlan, completionGuidance } from "../src/plan.mjs";
import { formatCommand } from "../src/shell-command.mjs";
import { createRecordingRunner, git, HEAD_SHA, result, temporaryDirectory, textSink } from "./helpers.mjs";

function guidedPrompt(confirmations = [true, true, true, true, true, true], { privateKeyPath = "/private/tmp/codekeeper-test-private-key.pem" } = {}) {
  const answers = [...confirmations];
  const prompt = {
    confirmations: [],
    async confirm(options) {
      prompt.confirmations.push(options);
      if (options.message === "Enable OpenAI traces?") return true;
      return answers.shift();
    },
    async multiselect({ message, defaultValues }) {
      if (message.startsWith("Choose capabilities")) return defaultValues;
      throw new Error("recommended setup must not ask for custom workflows");
    },
    async select({ message, defaultValue }) {
      if (message === "Choose a starting setup") return "recommended";
      if (message.startsWith("Assign a model to")) return defaultValue;
      if (message === "Enable OpenAI traces?") return "enabled";
      if (message.startsWith("Start Codekeeper")) return "enabled";
      throw new Error("recommended setup must not ask for a custom preset");
    },
    async inputText({ message }) {
      if (message.startsWith("Name to show")) return "Widget";
      if (message.startsWith("GitHub users")) return "cory";
      if (message.startsWith("GitHub App Client")) return "Iv123456789012345678";
      if (message.startsWith("GitHub App name")) return "codekeeper-widget";
      if (message.startsWith("GitHub App bot")) return "codekeeper-widget[bot]";
      if (message.startsWith("Full absolute path")) return privateKeyPath;
      throw new Error(`Unexpected prompt: ${message}`);
    }
  };
  return prompt;
}

function repositorySnapshot(root, headSha) {
  return Object.freeze({
    root,
    originUrl: "https://github.com/acme/widget.git",
    repository: "acme/widget",
    defaultBranch: "main",
    currentBranch: "main",
    headSha,
    remoteDefaultSha: headSha,
    viewerLogin: "cory",
    displayName: "widget"
  });
}

test("CLI accepts only the documented commands", () => {
  assert.deepEqual(parseCliArgs([]), { command: "help" });
  assert.deepEqual(parseCliArgs(["--help"]), { command: "help" });
  assert.deepEqual(parseCliArgs(["--version"]), { command: "version" });
  assert.deepEqual(parseCliArgs(["init"]), { command: "init" });
  assert.deepEqual(parseCliArgs(["update"]), { command: "update" });
  assert.deepEqual(parseCliArgs(["update", "--current-package"]), { command: "update", currentPackage: true });
  assert.throws(() => parseCliArgs(["init", "--force"]), (error) => error.code === "CLI_USAGE");
  assert.throws(() => parseCliArgs(["verify"]), (error) => error.code === "CLI_USAGE");
  assert.throws(() => parseCliArgs("init"), TypeError);
});

test("update bootstraps the latest CLI before loading assets or inspecting the repository", async () => {
  const output = textSink();
  const errorOutput = textSink();
  let launchOptions;
  const status = await runCli({
    argv: ["update"],
    cwd: "/tmp/widget",
    output,
    errorOutput,
    environment: { TERM: "xterm-256color" },
    platform: "linux",
    launchLatestUpdate: async (options) => {
      launchOptions = options;
      return 7;
    },
    loadAssets: async () => { throw new Error("the old package must not load assets"); },
    inspect: async () => { throw new Error("the old package must not inspect the repository"); }
  });
  assert.equal(status, 7);
  assert.equal(launchOptions.cwd, "/tmp/widget");
  assert.equal(launchOptions.output, output);
  assert.equal(launchOptions.environment.TERM, "xterm-256color");
  assert.equal(launchOptions.platform, "linux");
  assert.equal(errorOutput.toString(), "");
});

test("the npm bootstrap fails closed when it launches the wrong package version", async () => {
  const errorOutput = textSink();
  const status = await runCli({
    argv: ["update", "--current-package"],
    output: textSink(),
    errorOutput,
    environment: { CODEKEEPER_UPDATE_EXPECTED_VERSION: "9.9.9" },
    loadAssets: async () => { throw new Error("mismatched packages must fail before loading assets"); },
    inspect: async () => { throw new Error("mismatched packages must fail before preflight"); }
  });
  assert.equal(status, 1);
  assert.match(errorOutput.toString(), /different Codekeeper version than requested/);
});

test("help, version, and rejected arguments perform no installer side effects", async () => {
  for (const [argv, expectedStatus, expected] of [
    [["--help"], 0, USAGE],
    [[], 0, USAGE],
    [["--version"], 0, "0.2.0\n"],
    [["init", "--non-interactive"], 2, "Unsupported command or option"]
  ]) {
    const output = textSink();
    const errorOutput = textSink();
    const runner = createRecordingRunner(() => {
      throw new Error("runner must not be called");
    });
    let loads = 0;
    let inspections = 0;
    let opens = 0;
    const status = await runCli({
      argv,
      output,
      errorOutput,
      runner,
      loadAssets: async () => {
        loads += 1;
        throw new Error("assets must not load");
      },
      inspect: async () => {
        inspections += 1;
        throw new Error("preflight must not run");
      },
      openUrl: async () => {
        opens += 1;
      }
    });
    assert.equal(status, expectedStatus);
    assert.match(`${output}${errorOutput}`, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(loads, 0);
    assert.equal(inspections, 0);
    assert.equal(opens, 0);
    assert.deepEqual(runner.calls, []);
  }
});

test("app-registration abort prints the URL and an exact platform-safe resume command without mutation", async () => {
  const output = textSink();
  const errorOutput = textSink();
  const runner = createRecordingRunner(() => {
    throw new Error("no external command is expected before the App confirmation");
  });
  const prompt = guidedPrompt([true, true, true, true, false]);
  const snapshot = Object.freeze({
    root: "/tmp/acme widget",
    originUrl: "https://github.com/acme/widget.git",
    repository: "acme/widget",
    defaultBranch: "main",
    currentBranch: "main",
    headSha: HEAD_SHA,
    remoteDefaultSha: HEAD_SHA,
    viewerLogin: "coryparrry",
    displayName: "widget"
  });
  let openedUrl = null;
  const resumeCommand = currentResumeCommand("/opt/Node JS/node", "/opt/Codekeeper CLI/codekeeper.mjs", "linux");
  const status = await runCli({
    argv: ["init"],
    output,
    errorOutput,
    runner,
    prompt,
    interactive: true,
    loadAssets: loadVerifiedAssets,
    inspect: async () => snapshot,
    openUrl: async (url) => {
      openedUrl = url;
      throw new Error("simulated browser opener failure");
    },
    resumeCommand
  });
  assert.equal(status, 1);
  assert.match(openedUrl, /^https:\/\/github\.com\/settings\/apps\/new\?/);
  assert.match(output.toString(), new RegExp(openedUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(errorOutput.toString(), /Complete GitHub App creation/);
  assert.match(errorOutput.toString(), new RegExp(resumeCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(prompt.confirmations.length, 6);
  assert.deepEqual(runner.calls, []);
});

test("declining the repository confirmation performs no mutation or App navigation", async () => {
  const output = textSink();
  const errorOutput = textSink();
  const runner = createRecordingRunner(() => {
    throw new Error("no external command is expected before repository confirmation");
  });
  const prompt = guidedPrompt([false]);
  let opens = 0;
  const status = await runCli({
    argv: ["init"],
    output,
    errorOutput,
    runner,
    prompt,
    interactive: true,
    inspect: async () => repositorySnapshot("/tmp/widget", HEAD_SHA),
    openUrl: async () => {
      opens += 1;
    }
  });
  assert.equal(status, 1);
  assert.equal(opens, 0);
  assert.deepEqual(prompt.confirmations, [
    { message: "Install into acme/widget on default branch main?", defaultValue: false }
  ]);
  assert.match(errorOutput.toString(), /Setup was cancelled before any mutation/);
  assert.deepEqual(runner.calls, []);
});

test("declining conservative boundaries on the recommended path performs no mutation or App navigation", async () => {
  const output = textSink();
  const errorOutput = textSink();
  const runner = createRecordingRunner(() => {
    throw new Error("no external mutation is expected before boundary confirmation");
  });
  const prompt = guidedPrompt([true, true, true, false]);
  let opens = 0;
  const snapshot = repositorySnapshot("/tmp/widget", HEAD_SHA);
  const status = await runCli({
    argv: ["init"],
    output,
    errorOutput,
    runner,
    prompt,
    interactive: true,
    inspect: async () => snapshot,
    openUrl: async () => {
      opens += 1;
    }
  });
  assert.equal(status, 1);
  assert.equal(opens, 0);
  assert.deepEqual(prompt.confirmations, [
    { message: "Install into acme/widget on default branch main?", defaultValue: false },
    { message: "Use the recommended starter setup?", defaultValue: true },
    { message: "Enable OpenAI traces?", defaultValue: true },
    { message: "Start Codekeeper after the setup pull request merges?", defaultValue: true },
    { message: "Continue with these safety settings?", defaultValue: false }
  ]);
  assert.match(errorOutput.toString(), /Setup was cancelled before any mutation/);
  assert.deepEqual(runner.calls, []);
});

test("declining final setup confirmation leaves settings, Git, and files untouched", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-cli-final-abort-");
  git(root, ["init", "--template=", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Codekeeper Test"]);
  git(root, ["config", "user.email", "codekeeper@example.test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  git(root, ["config", "core.fsmonitor", "false"]);
  await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Widget\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const branch = git(root, ["branch", "--show-current"]).trim();
  const statusBefore = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const snapshot = repositorySnapshot(root, head);
  const output = textSink();
  const errorOutput = textSink();
  const runner = createRecordingRunner(() => {
    throw new Error("no repository setting, GitHub, or Git command is expected before final confirmation");
  });
  const prompt = guidedPrompt([true, true, true, true, true, false]);
  let inspections = 0;
  let openedUrl = null;
  const status = await runCli({
    argv: ["init"],
    cwd: root,
    output,
    errorOutput,
    runner,
    prompt,
    interactive: true,
    inspect: async () => {
      inspections += 1;
      return snapshot;
    },
    openUrl: async (url) => {
      openedUrl = url;
    }
  });

  assert.equal(status, 1);
  assert.equal(inspections, 1);
  assert.match(openedUrl, /^https:\/\/github\.com\/settings\/apps\/new\?/);
  assert.deepEqual(prompt.confirmations, [
    { message: "Install into acme/widget on default branch main?", defaultValue: false },
    { message: "Use the recommended starter setup?", defaultValue: true },
    { message: "Enable OpenAI traces?", defaultValue: true },
    { message: "Start Codekeeper after the setup pull request merges?", defaultValue: true },
    { message: "Continue with these safety settings?", defaultValue: false },
    { message: "Have you chosen or created the App, installed it on this repository, and downloaded its private key?", defaultValue: false },
    { message: "Create this setup?", defaultValue: false }
  ]);
  assert.match(output.toString(), /Setup preview/);
  assert.match(errorOutput.toString(), /Setup was cancelled before repository mutation/);
  assert.deepEqual(runner.calls, []);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head);
  assert.equal(git(root, ["branch", "--show-current"]).trim(), branch);
  assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), statusBefore);
  await assert.rejects(access(path.join(root, ".github")), (error) => error?.code === "ENOENT");
});

test("Ink review remains the exact mutation boundary after metadata-only PEM selection", async () => {
  const output = textSink();
  const errorOutput = textSink();
  const notices = textSink();
  const privateKeyPath = "/private/tmp/private-key-path-canary.pem";
  const calls = [];
  let reviewedPlan = null;
  let disposed = 0;
  const prompt = {
    kind: "ink",
    notices,
    progress: {
      start() { throw new Error("progress must not start before final review approval"); },
      update() { throw new Error("progress must not update before final review approval"); }
    },
    async confirm(options) {
      calls.push(["confirm", options.message]);
      return true;
    },
    async select(options) {
      calls.push(["select", options.message]);
      if (options.message === "Choose a starting setup") return "recommended";
      if (options.message.startsWith("Assign a model to")) return options.defaultValue;
      if (options.message === "Enable OpenAI traces?") return "enabled";
      if (options.message.startsWith("Start Codekeeper")) return "enabled";
      throw new Error(`Unexpected select prompt: ${options.message}`);
    },
    async multiselect(options) {
      if (options.message.startsWith("Choose capabilities")) return options.defaultValues;
      throw new Error("recommended setup must not show workflow customization");
    },
    async inputText(options) {
      calls.push(["inputText", options.message]);
      if (options.message.startsWith("GitHub App Client")) return "Iv123456789012345678";
      if (options.message.startsWith("GitHub App name")) return "codekeeper-widget";
      return options.defaultValue;
    },
    async selectPrivateKey() {
      calls.push(["selectPrivateKey"]);
      return privateKeyPath;
    },
    async reviewInstallPlan(plan) {
      calls.push(["reviewInstallPlan"]);
      reviewedPlan = plan;
      return false;
    },
    async showCompletion() {
      throw new Error("completion must not render after cancellation");
    },
    async dispose() {
      disposed += 1;
    }
  };
  const runner = createRecordingRunner(() => {
    throw new Error("no settings, secret, Git, push, or pull-request command may run before final approval");
  });
  let inspections = 0;
  let opens = 0;
  const status = await runCli({
    argv: ["init"],
    output,
    errorOutput,
    runner,
    prompt,
    interactive: true,
    inspect: async () => {
      inspections += 1;
      return repositorySnapshot("/tmp/widget", HEAD_SHA);
    },
    openUrl: async () => { opens += 1; },
    resumeCommand: "safe resume"
  });

  assert.equal(status, 1);
  assert.equal(inspections, 1);
  assert.equal(opens, 1);
  assert.deepEqual(runner.calls, []);
  assert.equal(disposed, 1);
  assert.ok(calls.findIndex(([method]) => method === "selectPrivateKey") < calls.findIndex(([method]) => method === "reviewInstallPlan"));
  assert.equal(reviewedPlan.variables.find((variable) => variable.name === "CODEKEEPER_ENABLED").value, "true");
  assert.equal(reviewedPlan.variables.find((variable) => variable.name === "CODEKEEPER_AUTOMATION_BOT_LOGIN").value, "codekeeper-widget[bot]");
  const observable = `${JSON.stringify(reviewedPlan)}\n${output.toString()}\n${errorOutput.toString()}\n${notices.toString()}`;
  assert.doesNotMatch(observable, new RegExp(privateKeyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(errorOutput.toString(), /cancelled before repository mutation/);
});

test("an existing installation rerun skips App setup and secret prompts", async () => {
  const bundle = await loadVerifiedAssets();
  const baseSnapshot = repositorySnapshot("/tmp/widget", HEAD_SHA);
  const initial = buildInstallPlan({
    bundle,
    snapshot: baseSnapshot,
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
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const snapshot = Object.freeze({
    ...baseSnapshot,
    installation: Object.freeze({
      policy: JSON.parse(contents[".github/codekeeper.json"]),
      policySource: contents[".github/codekeeper.json"],
      modes: Object.freeze(["review", "maintain"]),
      contents: Object.freeze(contents)
    }),
    existingSettings: Object.freeze({
      enabled: true,
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    }),
    updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
  });
  let reviewedPlan = null;
  let opens = 0;
  const prompt = {
    kind: "ink",
    notices: textSink(),
    async confirm() { return true; },
    async select(options) {
      if (options.message.includes("Pull request reviewer")) return "luna-max";
      return options.defaultValue;
    },
    async multiselect(options) { return options.defaultValues; },
    async inputText(options) { return options.defaultValue; },
    async selectPrivateKey() { throw new Error("an update must not request the App key"); },
    async reviewInstallPlan(plan) {
      reviewedPlan = plan;
      return false;
    },
    async dispose() {}
  };
  const status = await runCli({
    argv: ["init"],
    prompt,
    output: textSink(),
    errorOutput: textSink(),
    runner: createRecordingRunner(() => { throw new Error("no mutation before review"); }),
    inspect: async () => snapshot,
    openUrl: async () => { opens += 1; },
    loadAssets: async () => bundle
  });
  assert.equal(status, 1);
  assert.equal(opens, 0);
  assert.equal(reviewedPlan.update, true);
  assert.equal(reviewedPlan.operation, "configuration-update");
  assert.deepEqual(reviewedPlan.secrets, []);
  assert.deepEqual(reviewedPlan.variables, []);
  assert.deepEqual(reviewedPlan.files.map((file) => file.path), [".github/codekeeper.json"]);
  assert.equal(reviewedPlan.models.review.model, "gpt-5.6-luna");
});

test("update requires an existing installation before prompting or mutation", async () => {
  const output = textSink();
  const errorOutput = textSink();
  const prompt = {
    async confirm() { throw new Error("update must reject before prompting"); }
  };
  const runner = createRecordingRunner(() => {
    throw new Error("update must reject before mutation");
  });
  const status = await runCli({
    argv: ["update", "--current-package"],
    output,
    errorOutput,
    prompt,
    runner,
    inspect: async () => repositorySnapshot("/tmp/widget", HEAD_SHA)
  });
  assert.equal(status, 1);
  assert.match(errorOutput.toString(), /No Codekeeper installation was found.*codekeeper init/s);
  assert.deepEqual(runner.calls, []);
});

test("update advances release-owned files while preserving adopter configuration and profiles", async () => {
  const bundle = await loadVerifiedAssets();
  const baseSnapshot = repositorySnapshot("/tmp/widget", HEAD_SHA);
  const initial = buildInstallPlan({
    bundle,
    snapshot: baseSnapshot,
    answers: {
      modes: ["review", "maintain"],
      preset: "openai",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]",
      enabled: false
    }
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const policy = JSON.parse(contents[".github/codekeeper.json"]);
  policy.repository.displayName = "Adopter Widget";
  policy.audit.repair.protectedPaths = ["adopter-stale-release-boundary"];
  policy.ai.providers.openai.baseUrl = "https://stale-provider.example.test/v1";
  policy.ai.agents.review.workspace.allowWrites = true;
  policy.ai.agents.review.maxTurns = 99;
  policy.merge.blockedPaths = ["adopter-stale-release-boundary"];
  contents[".github/codekeeper.json"] = `${JSON.stringify(policy, null, 2)}\n`;
  contents[".github/codekeeper/agents/pr-reviewer.md"] = `${bundle.contents["agents/pr-reviewer.md"]}\nRepository rule: prioritise public API regressions.\n`;
  const nextCommit = "b".repeat(40);
  const nextBundle = {
    ...bundle,
    metadata: {
      ...bundle.metadata,
      source: { ...bundle.metadata.source, commit: nextCommit }
    }
  };
  const snapshot = {
    ...baseSnapshot,
    installation: {
      policy,
      policySource: contents[".github/codekeeper.json"],
      modes: ["review", "maintain"],
      contents
    },
    existingSettings: {
      enabled: false,
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    },
    updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
  };
  const configurationPolicy = structuredClone(policy);
  configurationPolicy.ai.agents.review.workspace.allowWrites = false;
  configurationPolicy.ai.agents.review.maxTurns = 1;
  const configurationPlan = buildInstallPlan({
    bundle: nextBundle,
    snapshot: {
      ...snapshot,
      installation: {
        ...snapshot.installation,
        policy: configurationPolicy,
        policySource: `${JSON.stringify(configurationPolicy, null, 2)}\n`,
        contents: {
          ...contents,
          ".github/codekeeper.json": `${JSON.stringify(configurationPolicy, null, 2)}\n`
        }
      }
    },
    answers: {
      modes: ["review", "maintain"],
      preset: "openai",
      enabled: false,
      policy: configurationPolicy,
      profiles: {
        "pr-reviewer": contents[".github/codekeeper/agents/pr-reviewer.md"],
        "repository-auditor": bundle.contents["agents/repository-auditor.md"],
        "issue-triager": bundle.contents["agents/issue-triager.md"],
        fixer: bundle.contents["agents/fixer.md"]
      },
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    }
  });
  assert.equal(configurationPlan.operation, "configuration-update");
  assert.deepEqual(configurationPlan.policy.audit.repair.protectedPaths, ["adopter-stale-release-boundary"]);
  assert.equal(configurationPlan.policy.ai.providers.openai.baseUrl, "https://stale-provider.example.test/v1");
  assert.equal(configurationPlan.policy.ai.agents.review.workspace.allowWrites, false);
  assert.equal(configurationPlan.policy.ai.agents.review.maxTurns, 1);
  assert.deepEqual(configurationPlan.policy.merge.blockedPaths, ["adopter-stale-release-boundary"]);
  let reviewedPlan;
  const prompt = {
    async confirm() { return true; },
    async reviewInstallPlan(plan) {
      reviewedPlan = plan;
      return false;
    },
    async dispose() {}
  };
  const runner = createRecordingRunner(() => {
    throw new Error("no mutation is allowed before final update approval");
  });
  const output = textSink();
  const errorOutput = textSink();
  const status = await runCli({
    argv: ["update", "--current-package"],
    output,
    errorOutput,
    prompt,
    runner,
    inspect: async () => snapshot,
    loadAssets: async () => nextBundle
  });

  assert.equal(status, 1, errorOutput.toString());
  assert.ok(reviewedPlan, errorOutput.toString());
  assert.equal(reviewedPlan.source.commit, nextCommit);
  assert.equal(reviewedPlan.operation, "release-update");
  assert.equal(reviewedPlan.commitMessage, "chore(codekeeper): update release");
  assert.equal(reviewedPlan.pullRequest.title, "chore(codekeeper): update release");
  assert.equal(reviewedPlan.displayName, "Adopter Widget");
  assert.equal(reviewedPlan.enabled, false);
  assert.deepEqual(reviewedPlan.modes, ["review", "maintain"]);
  assert.deepEqual(reviewedPlan.variables, []);
  assert.deepEqual(reviewedPlan.secrets, []);
  assert.deepEqual(reviewedPlan.policy.audit.repair.protectedPaths, JSON.parse(bundle.contents["policies/openai.json"]).audit.repair.protectedPaths);
  assert.deepEqual(reviewedPlan.policy.ai.providers, JSON.parse(bundle.contents["policies/openai.json"]).ai.providers);
  assert.equal(reviewedPlan.policy.ai.agents.review.workspace.allowWrites, false);
  assert.equal(reviewedPlan.policy.ai.agents.review.maxTurns, 1);
  assert.deepEqual(reviewedPlan.policy.merge.blockedPaths, JSON.parse(bundle.contents["policies/openai.json"]).merge.blockedPaths);
  assert.ok(reviewedPlan.files.some((file) => file.path === ".github/codekeeper.json"));
  assert.ok(reviewedPlan.files.some((file) => file.path === ".github/codekeeper-release.json" && file.contents.includes(nextCommit)));
  assert.equal(reviewedPlan.files.some((file) => file.path === ".github/workflows/codekeeper-assistant.yml"), false);
  assert.equal(reviewedPlan.files.some((file) => file.path === ".github/workflows/codekeeper-review.yml"), false);
  assert.equal(reviewedPlan.files.some((file) => file.path === ".github/codekeeper/agents/pr-reviewer.md"), false);
  assert.match(output.toString(), /selected workflows.*existing agent profile overrides stay unchanged/s);
  assert.deepEqual(runner.calls, []);
});

test("update exits successfully when the bundled release is already installed", async () => {
  const bundle = await loadVerifiedAssets();
  const baseSnapshot = repositorySnapshot("/tmp/widget", HEAD_SHA);
  const initial = buildInstallPlan({
    bundle,
    snapshot: baseSnapshot,
    answers: {
      modes: ["review"],
      preset: "openai",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]",
      enabled: true
    }
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const snapshot = {
    ...baseSnapshot,
    installation: {
      policy: JSON.parse(contents[".github/codekeeper.json"]),
      policySource: contents[".github/codekeeper.json"],
      modes: ["review"],
      contents
    },
    existingSettings: {
      enabled: true,
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    },
    updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
  };
  const output = Object.assign(textSink(), { isTTY: true, columns: 80, rows: 24 });
  let rawModeCalls = 0;
  const status = await runCli({
    argv: ["update", "--current-package"],
    input: {
      isTTY: true,
      setRawMode() { rawModeCalls += 1; }
    },
    output,
    errorOutput: textSink(),
    environment: { TERM: "xterm-256color" },
    runner: createRecordingRunner(() => { throw new Error("already-current update must not mutate"); }),
    inspect: async () => snapshot,
    loadAssets: async () => bundle
  });
  assert.equal(status, 0);
  assert.equal(rawModeCalls, 0);
  assert.match(output.toString(), new RegExp(`already up to date at ${bundle.metadata.source.repository}@${bundle.metadata.source.commit}`));
});

test("a plain-prompt rerun preserves disabled owner requests without asking for a bot login", async () => {
  const bundle = await loadVerifiedAssets();
  const policy = JSON.parse(bundle.contents["policies/openai.json"]);
  policy.automation.ownerRequests = false;
  const snapshot = Object.freeze({
    ...repositorySnapshot("/tmp/widget", HEAD_SHA),
    installation: Object.freeze({
      policy,
      policySource: JSON.stringify(policy),
      modes: Object.freeze(["issues"]),
      contents: Object.freeze({})
    }),
    existingSettings: Object.freeze({
      enabled: true,
      appClientId: "Iv123456789012345678",
      automationBotLogin: null
    }),
    updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
  });
  let reviewedPlan = null;
  const prompt = {
    async confirm(options) {
      if (options.message === "Enable OpenAI traces?") return false;
      return true;
    },
    async select(options) { return options.defaultValue; },
    async multiselect(options) { return options.defaultValues; },
    async inputText(options) {
      if (options.message.startsWith("GitHub App bot")) throw new Error("owner requests are disabled");
      return options.defaultValue;
    },
    async reviewInstallPlan(plan) {
      reviewedPlan = plan;
      return false;
    }
  };
  const status = await runCli({
    argv: ["init"],
    prompt,
    output: textSink(),
    errorOutput: textSink(),
    runner: createRecordingRunner(() => { throw new Error("no mutation before review"); }),
    inspect: async () => snapshot,
    loadAssets: async () => bundle
  });
  assert.equal(status, 1);
  assert.equal(reviewedPlan.policy.automation.ownerRequests, false);
  assert.equal(reviewedPlan.variables.some((variable) => variable.name === "CODEKEEPER_AUTOMATION_BOT_LOGIN"), false);
});

test("resume command formatting is executable on POSIX and PowerShell", () => {
  assert.equal(
    currentResumeCommand("/opt/Node JS/node", "/tmp/Cory's CLI/codekeeper.mjs", "darwin"),
    "'/opt/Node JS/node' '/tmp/Cory'\"'\"'s CLI/codekeeper.mjs' 'init'"
  );
  assert.equal(
    currentResumeCommand("C:\\Program Files\\node.exe", "C:\\Codekeeper's CLI\\codekeeper.mjs", "win32"),
    "& 'C:\\Program Files\\node.exe' 'C:\\Codekeeper''s CLI\\codekeeper.mjs' 'init'"
  );
  assert.equal(currentResumeCommand("node", "", "linux"), "codekeeper init");
  assert.equal(currentResumeCommand("node", "", "linux", "update"), "codekeeper update");
  assert.equal(formatCommand("gh", ["pr", "view", "a'b"], "linux"), "'gh' 'pr' 'view' 'a'\"'\"'b'");
});

test("successful init revalidates three snapshots and orders settings, exact commit publication, and completion", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-cli-");
  git(root, ["init", "--template=", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Codekeeper Test"]);
  git(root, ["config", "user.email", "codekeeper@example.test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  git(root, ["config", "core.fsmonitor", "false"]);
  await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Widget\n");
  const privateKeyRoot = await temporaryDirectory(t, "codekeeper-cli-key-");
  const privateKeyPath = path.join(privateKeyRoot, "codekeeper-test-private-key.pem");
  await writeFile(privateKeyPath, "test-only-private-key-bytes\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "initial"]);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const snapshot = repositorySnapshot(root, head);
  const actual = createCommandRunner({
    environment: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), LANG: "C" }
  });
  const calls = [];
  let pushedCommit = null;
  const runner = {
    async run(command, args, options = {}) {
      calls.push({ command, args: [...args], options: { ...options } });
      if (command === "gh") {
        if (typeof options.provideInput === "function") {
          let received = "";
          await options.provideInput((value) => { received += value; });
          assert.equal(received, "test-provider-key");
        }
        return args[0] === "pr" && args[1] === "create"
          ? result("https://github.com/acme/widget/pull/42\n")
          : result();
      }
      if (command === "git" && args[0] === "push") {
        pushedCommit = args[2].split(":")[0];
        return result();
      }
      if (command === "git" && args[0] === "ls-remote" && args[1] === "--refs") {
        return result(`${pushedCommit}\trefs/heads/codekeeper/setup\n`);
      }
      return actual.run(command, args, options);
    }
  };
  let inspections = 0;
  let opened = null;
  const output = textSink();
  const errorOutput = textSink();
  const prompt = guidedPrompt(undefined, { privateKeyPath });
  const progressEvents = [];
  const enteredSecrets = [];
  let progressStarted = 0;
  prompt.kind = "ink";
  prompt.notices = output;
  prompt.progress = {
    start() {
      progressStarted += 1;
    },
    update(event) {
      progressEvents.push(event);
    }
  };
  prompt.inputSecret = async ({ name, purpose, write }) => {
    enteredSecrets.push({ name, purpose });
    write("test-provider-key");
  };
  const status = await runCli({
    argv: ["init"],
    cwd: root,
    output,
    errorOutput,
    runner,
    prompt,
    interactive: true,
    inspect: async () => {
      inspections += 1;
      return snapshot;
    },
    openUrl: async (url) => {
      opened = url;
    },
    resumeCommand: "'node' 'codekeeper.mjs' 'init'",
    platform: "linux"
  });
  assert.equal(status, 0, errorOutput.toString());
  assert.equal(inspections, 3);
  assert.equal(progressStarted, 1);
  assert.deepEqual(prompt.confirmations.map(({ message, defaultValue }) => ({ message, defaultValue })), [
    { message: "Install into acme/widget on default branch main?", defaultValue: false },
    { message: "Continue with these safety settings?", defaultValue: false },
    { message: "Have you chosen or created the App, installed it on this repository, and downloaded its private key?", defaultValue: false },
    { message: "Create this setup?", defaultValue: false }
  ]);
  assert.match(opened, /^https:\/\/github\.com\/settings\/apps\/new\?/);
  assert.match(pushedCommit, /^[0-9a-f]{40}$/);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), pushedCommit);
  assert.equal(git(root, ["rev-parse", "HEAD^"]).trim(), head);
  const indexOf = (predicate) => calls.findIndex(predicate);
  const disableIndex = indexOf((call) => call.command === "gh" && call.args.includes("CODEKEEPER_ENABLED"));
  const secretIndex = indexOf((call) => call.command === "gh" && call.args[0] === "secret");
  const branchIndex = indexOf((call) => call.command === "git" && call.args[0] === "switch");
  const commitIndex = indexOf((call) => call.command === "git" && call.args[0] === "commit");
  const pushIndex = indexOf((call) => call.command === "git" && call.args[0] === "push");
  const prIndex = indexOf((call) => call.command === "gh" && call.args[0] === "pr");
  assert.ok([disableIndex, secretIndex, branchIndex, commitIndex, pushIndex, prIndex].every((index) => index >= 0));
  assert.ok(disableIndex < secretIndex && secretIndex < branchIndex && branchIndex < commitIndex && commitIndex < pushIndex && pushIndex < prIndex);
  assert.deepEqual(
    calls.filter((call) => call.command === "gh" && call.args[0] === "secret").map((call) => call.args[2]),
    ["OPENAI_API_KEY", "OPENAI_TRACE_API_KEY", "CODEKEEPER_APP_PRIVATE_KEY"]
  );
  assert.deepEqual(enteredSecrets.map(({ name }) => name), ["OPENAI_API_KEY", "OPENAI_TRACE_API_KEY"]);
  assert.deepEqual(enteredSecrets.map(({ purpose }) => purpose), [
    "OpenAI Platform API key for model calls. A ChatGPT subscription does not include this key.",
    "Separate OpenAI Platform API key for trace export. Do not reuse the model API key."
  ]);
  assert.equal(enteredSecrets.some(({ name }) => name === "CODEKEEPER_APP_PRIVATE_KEY"), false);
  const providerSecretCalls = calls.filter((call) => call.command === "gh"
    && call.args[0] === "secret"
    && call.args[2] !== "CODEKEEPER_APP_PRIVATE_KEY");
  assert.ok(providerSecretCalls.every((call) => call.options.stdio === "ignore"
    && typeof call.options.provideInput === "function"
    && !Object.hasOwn(call.options, "stdinFd")));
  const appSecretCall = calls.find((call) => call.command === "gh" && call.args.includes("CODEKEEPER_APP_PRIVATE_KEY"));
  assert.equal(appSecretCall.options.stdio, "ignore");
  assert.ok(Number.isInteger(appSecretCall.options.stdinFd) && appSecretCall.options.stdinFd >= 3);
  assert.deepEqual(
    progressEvents.filter((event) => event.status === "done").map((event) => event.id),
    [
      "repository:verify",
      "settings:disable",
      "secret:provider",
      "secret:app",
      "variables:configure",
      "git:commit",
      "git:push",
      "github:pull-request"
    ]
  );
  const providerDone = progressEvents.findIndex((event) => event.id === "secret:provider" && event.status === "done");
  const appActive = progressEvents.findIndex((event) => event.id === "secret:app" && event.status === "active");
  assert.ok(providerDone >= 0 && providerDone < appActive);
  assert.equal(calls.some((call) => call.args.includes("DEEPSEEK_API_KEY")), false);
  assert.deepEqual(
    git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n").sort(),
    [
      ".github/codekeeper-release.json",
      ".github/codekeeper.json",
      ".github/workflows/codekeeper-assistant.yml",
      ".github/workflows/codekeeper-bootstrap.yml",
      ".github/workflows/codekeeper-maintain.yml",
      ".github/workflows/codekeeper-review.yml",
      ".github/workflows/codekeeper-runtime-assistant.yml",
      ".github/workflows/codekeeper-runtime-maintain.yml",
      ".github/workflows/codekeeper-runtime-review.yml"
    ]
  );
  assert.match(output.toString(), /Starting model set: openai/);
  assert.match(output.toString(), /OpenAI traces: enabled/);
  assert.match(output.toString(), /Pull request reviewer \(Pull request review\): openai \/ gpt-5\.6-luna \/ medium effort/);
  assert.match(output.toString(), /Repository auditor \(Repository maintenance\): openai \/ gpt-5\.6-sol \/ high effort/);
  assert.match(output.toString(), /OPENAI_API_KEY: OpenAI Platform API key for model calls/);
  assert.match(output.toString(), /OPENAI_TRACE_API_KEY: Separate OpenAI Platform API key for trace export/);
  assert.match(output.toString(), /CODEKEEPER_APP_PRIVATE_KEY: downloaded GitHub App PEM private key used to mint App installation tokens/);
  assert.doesNotMatch(output.toString(), /DEEPSEEK_API_KEY:/);
  assert.match(output.toString(), /\.github\/workflows\/codekeeper-review\.yml/);
  assert.match(output.toString(), /\.github\/workflows\/codekeeper-maintain\.yml/);
  assert.doesNotMatch(output.toString(), /\.github\/codekeeper\/agents\/pr-reviewer\.md/);
  assert.match(output.toString(), /Packaged agent profiles are the default/);
  assert.match(output.toString(), /Capability switches control repair, issue implementation, issue closure, and merge actions/);
  assert.doesNotMatch(output.toString(), /\.github\/workflows\/codekeeper-(?:issues|fix)\.yml/);
  assert.match(output.toString(), /starts the selected workflows when the setup pull request merges/);
  assert.match(output.toString(), /no separate dry run or controlled test is required/);
  assert.doesNotMatch(output.toString(), /controlled review|dry_run=true|test each/i);
  assert.match(output.toString(), /Created setup pull request: https:\/\/github\.com\/acme\/widget\/pull\/42/);
  assert.match(output.toString(), /did not run a workflow or merge the pull request/);
  const guidance = completionGuidance(["review", "maintain"]);
  assert.match(output.toString(), new RegExp(guidance.profileGuidance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(guidance.reviewGateWarning, null);
  assert.equal(errorOutput.toString(), "");
  const observable = `${JSON.stringify(calls)}\n${output.toString()}\n${errorOutput.toString()}`;
  assert.doesNotMatch(observable, new RegExp(privateKeyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(observable, /test-only-private-key-bytes/);
});

test("snapshot drift after confirmation aborts before settings or Git mutation", async () => {
  const output = textSink();
  const errorOutput = textSink();
  const runner = createRecordingRunner(() => {
    throw new Error("mutation must not run after snapshot drift");
  });
  const initial = repositorySnapshot("/tmp/widget", HEAD_SHA);
  const changed = Object.freeze({ ...initial, headSha: "b".repeat(40), remoteDefaultSha: "b".repeat(40) });
  let inspections = 0;
  const status = await runCli({
    argv: ["init"],
    output,
    errorOutput,
    runner,
    prompt: guidedPrompt(),
    interactive: true,
    inspect: async () => (++inspections === 1 ? initial : changed),
    openUrl: async () => {},
    resumeCommand: "safe resume"
  });
  assert.equal(status, 1);
  assert.equal(inspections, 2);
  assert.match(errorOutput.toString(), /repository changed during setup/i);
  assert.match(errorOutput.toString(), /Resume: safe resume/);
  assert.deepEqual(runner.calls, []);
});
