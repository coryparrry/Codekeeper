import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadVerifiedAssets } from "../src/assets.mjs";
import { currentResumeCommand, parseCliArgs, runCli, USAGE } from "../src/cli.mjs";
import { createCommandRunner } from "../src/command-runner.mjs";
import { formatCommand } from "../src/shell-command.mjs";
import { createRecordingRunner, git, HEAD_SHA, result, temporaryDirectory, textSink } from "./helpers.mjs";

function guidedPrompt(confirmations = [true, true, true, true]) {
  const answers = [...confirmations];
  return {
    async confirm() {
      return answers.shift();
    },
    async multiselect() {
      return ["review"];
    },
    async select() {
      return "mixed";
    },
    async inputText({ message }) {
      if (message.startsWith("Repository")) return "Widget";
      if (message.startsWith("Owner")) return "cory";
      if (message.startsWith("GitHub App Client")) return "Iv123456789012345678";
      if (message.startsWith("GitHub App bot")) return "codekeeper-widget[bot]";
      throw new Error(`Unexpected prompt: ${message}`);
    }
  };
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
  const confirmations = [true, true, false];
  const prompt = {
    async confirm() {
      return confirmations.shift();
    },
    async multiselect() {
      return ["review"];
    },
    async select() {
      return "mixed";
    },
    async inputText({ message }) {
      return message.startsWith("Repository") ? "Acme Widget" : "coryparrry";
    }
  };
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
  assert.deepEqual(runner.calls, []);
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
  const status = await runCli({
    argv: ["init"],
    cwd: root,
    output,
    errorOutput,
    runner,
    prompt: guidedPrompt(),
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
