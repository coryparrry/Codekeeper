import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadVerifiedAssets } from "../src/assets.mjs";
import { currentResumeCommand, parseCliArgs, runCli, USAGE } from "../src/cli.mjs";
import { createCommandRunner } from "../src/command-runner.mjs";
import { formatCommand } from "../src/shell-command.mjs";
import { createRecordingRunner, git, HEAD_SHA, result, temporaryDirectory, textSink } from "./helpers.mjs";

function guidedPrompt(confirmations = [true, true, true, true, true]) {
  const answers = [...confirmations];
  const prompt = {
    confirmations: [],
    async confirm(options) {
      prompt.confirmations.push(options);
      return answers.shift();
    },
    async multiselect() {
      throw new Error("recommended setup must not ask for custom workflows");
    },
    async select() {
      throw new Error("recommended setup must not ask for a custom preset");
    },
    async inputText({ message }) {
      if (message.startsWith("Human-readable")) return "Widget";
      if (message.startsWith("GitHub users")) return "cory";
      if (message.startsWith("GitHub App Client")) return "Iv123456789012345678";
      if (message.startsWith("GitHub App bot")) return "codekeeper-widget[bot]";
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
  assert.throws(() => parseCliArgs(["init", "--force"]), (error) => error.code === "CLI_USAGE");
  assert.throws(() => parseCliArgs(["verify"]), (error) => error.code === "CLI_USAGE");
  assert.throws(() => parseCliArgs("init"), TypeError);
});

test("help, version, and rejected arguments perform no installer side effects", async () => {
  for (const [argv, expectedStatus, expected] of [
    [["--help"], 0, USAGE],
    [[], 0, USAGE],
    [["--version"], 0, "0.1.0\n"],
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
  const prompt = guidedPrompt([true, true, true, false]);
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
  assert.equal(prompt.confirmations.length, 4);
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
  const prompt = guidedPrompt([true, true, false]);
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
    { message: "Continue with these disabled-by-default boundaries?", defaultValue: false }
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
  const prompt = guidedPrompt([true, true, true, true, false]);
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
    { message: "Continue with these disabled-by-default boundaries?", defaultValue: false },
    { message: "Have you chosen or created the App, installed it on this repository, and downloaded its private key?", defaultValue: false },
    { message: "Create this disabled setup?", defaultValue: false }
  ]);
  assert.match(output.toString(), /Setup preview/);
  assert.match(errorOutput.toString(), /Setup was cancelled before repository mutation/);
  assert.deepEqual(runner.calls, []);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), head);
  assert.equal(git(root, ["branch", "--show-current"]).trim(), branch);
  assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), statusBefore);
  await assert.rejects(access(path.join(root, ".github")), (error) => error?.code === "ENOENT");
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
  const prompt = guidedPrompt();
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
  assert.deepEqual(prompt.confirmations, [
    { message: "Install into acme/widget on default branch main?", defaultValue: false },
    { message: "Use the recommended starter setup?", defaultValue: true },
    { message: "Continue with these disabled-by-default boundaries?", defaultValue: false },
    { message: "Have you chosen or created the App, installed it on this repository, and downloaded its private key?", defaultValue: false },
    { message: "Create this disabled setup?", defaultValue: false }
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
  assert.equal(calls.some((call) => call.args.includes("DEEPSEEK_API_KEY")), false);
  assert.deepEqual(
    git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n").sort(),
    [
      ".github/codekeeper.json",
      ".github/workflows/codekeeper-maintain.yml",
      ".github/workflows/codekeeper-review.yml"
    ]
  );
  assert.match(output.toString(), /Provider preset: openai \(one OpenAI provider key\)/);
  assert.match(output.toString(), /Pull request review: openai \/ gpt-5\.6-sol \/ high effort/);
  assert.match(output.toString(), /Repository maintenance: openai \/ gpt-5\.6-sol \/ high effort/);
  assert.match(output.toString(), /OPENAI_API_KEY: OpenAI Platform API key for model calls after enablement; this is not a ChatGPT subscription/);
  assert.match(output.toString(), /OPENAI_TRACE_API_KEY: separate OpenAI Platform API key for trace export; do not reuse the model-provider key/);
  assert.match(output.toString(), /CODEKEEPER_APP_PRIVATE_KEY: downloaded GitHub App PEM private key used to mint App installation tokens/);
  assert.doesNotMatch(output.toString(), /DEEPSEEK_API_KEY:/);
  assert.match(output.toString(), /\.github\/workflows\/codekeeper-review\.yml/);
  assert.match(output.toString(), /\.github\/workflows\/codekeeper-maintain\.yml/);
  assert.doesNotMatch(output.toString(), /\.github\/workflows\/codekeeper-(?:issues|fix)\.yml/);
  assert.match(output.toString(), /After merge, PR events intentionally show a failed Codekeeper review gate while disabled/);
  assert.match(output.toString(), /Do not make the Codekeeper review gate required until its controlled review proof passes/);
  assert.match(output.toString(), /Created disabled setup PR: https:\/\/github\.com\/acme\/widget\/pull\/42/);
  assert.match(output.toString(), /did not enable Codekeeper, dispatch a workflow, or merge the PR/);
  assert.equal(errorOutput.toString(), "");
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
  assert.match(errorOutput.toString(), /Repository state changed during setup/);
  assert.match(errorOutput.toString(), /Resume: safe resume/);
  assert.deepEqual(runner.calls, []);
});
