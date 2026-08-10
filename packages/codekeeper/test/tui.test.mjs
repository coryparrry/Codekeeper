import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, lstat, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { render as inkRender } from "ink";
import { loadVerifiedAssets } from "../src/assets.mjs";
import { runCli } from "../src/cli.mjs";
import { STDIN_FILE_LIMIT_BYTES } from "../src/command-runner.mjs";
import { buildInstallPlan, collectAppAnswers, collectSetupAnswers, completionGuidance } from "../src/plan.mjs";
import { defaultPrivateKeyDirectory, listPrivateKeyChoices } from "../src/private-key-input.mjs";
import {
  DEFAULT_PROGRESS_STEPS,
  containsPrivateKeyPemEnvelope,
  createInkProgress,
  createInkPrompter,
  sanitizeTextInput,
  shouldUseInkTui
} from "../src/tui.mjs";
import { HEAD_SHA, temporaryDirectory } from "./helpers.mjs";

const ESCAPE_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/g;
const COLOR_SGR_SEQUENCE = /\u001B\[(?:[0-9;]*;)?(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;[0-9;]*)?m/;

class TestInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.queue = [];
    this.rawModeChanges = [];
  }

  setEncoding() {}

  setRawMode(value) {
    this.rawModeChanges.push(value);
    return this;
  }

  ref() { return this; }
  unref() { return this; }
  pause() { return this; }
  resume() { return this; }

  read() {
    return this.queue.shift() ?? null;
  }

  send(value) {
    this.queue.push(value);
    this.emit("readable");
  }
}

class TestOutput extends EventEmitter {
  constructor({ columns = 100, rows = 40, isTTY = true } = {}) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = isTTY;
    this.frames = [];
  }

  write(value) {
    this.frames.push(String(value));
    return true;
  }

  transcript() {
    return this.frames.join("");
  }

  lastSemanticFrame() {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index].replace(ESCAPE_SEQUENCE, "");
      if (frame.trim()) return frame;
    }
    return "";
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForTranscript(output, text) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (output.transcript().replace(ESCAPE_SEQUENCE, "").includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`output did not contain expected text: ${text}`);
}

async function createTuiHarness(t, {
  columns = 100,
  rows = 40,
  environment = { TERM: "xterm-256color" },
  fsImpl,
  homeDirectory
} = {}) {
  const input = new TestInput();
  const output = new TestOutput({ columns, rows });
  const errorOutput = new TestOutput({ columns, rows });
  let instance;
  const renderImpl = (tree, options) => {
    instance = inkRender(tree, { ...options, debug: true, renderThrottleMs: 0 });
    return instance;
  };
  const prompt = await createInkPrompter({
    input,
    output,
    errorOutput,
    environment,
    renderImpl,
    fsImpl,
    homeDirectory
  });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await prompt.dispose();
  };
  t.after(dispose);
  const flush = async () => {
    await tick();
    await instance.waitUntilRenderFlush();
    await tick();
  };
  const send = async (value) => {
    input.send(value);
    if (value === "\u001b") await new Promise((resolve) => setTimeout(resolve, 30));
    await flush();
  };
  const waitForText = async (text) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await flush();
      if (output.lastSemanticFrame().includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`TUI did not render expected text: ${text}\n${output.lastSemanticFrame()}`);
  };
  const waitForPattern = async (pattern) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await flush();
      const frame = output.lastSemanticFrame();
      if (pattern.test(frame)) return frame;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`TUI did not render expected pattern: ${pattern}\n${output.lastSemanticFrame()}`);
  };
  return { input, output, errorOutput, prompt, instance: () => instance, flush, send, waitForText, waitForPattern, dispose };
}

function assertFrameFits(frame, { columns, rows }) {
  const lines = frame.split("\n");
  assert.ok(lines.length <= rows, `frame exceeds ${rows} rows: ${lines.length}`);
  for (const line of lines) assert.ok([...line].length <= columns, `line exceeds ${columns} columns: ${line}`);
}

function semanticText(frame) {
  return frame.replace(/[╭╮╰╯│─]/g, " ").replace(/\s+/g, " ").trim();
}

async function assertPagedScreenFits(tui, { kind, columns, rows, markers }) {
  const title = kind === "review" ? "Review the setup" : "Setup complete";
  const firstPattern = kind === "review"
    ? /Review the setup · 1 of \d+/
    : /Setup complete(?: · 1 of \d+)?/;
  let first;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await tui.flush();
    const candidate = semanticText(tui.output.lastSemanticFrame());
    if (firstPattern.test(candidate)) {
      first = candidate;
      break;
    }
  }
  if (!first) assert.fail(`TUI did not render expected screen: ${firstPattern}`);
  const count = first.match(new RegExp(`${title} · 1 of (\\d+)`));
  const pages = count ? Number(count[1]) : 1;
  if (markers) assert.equal(pages, markers.length);
  for (let page = 1; page <= pages; page += 1) {
    if (page > 1) {
      const expected = `${title} · ${page} of ${pages}`;
      let found = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await tui.flush();
        if (semanticText(tui.output.lastSemanticFrame()).includes(expected)) {
          found = true;
          break;
        }
      }
      if (!found) assert.fail(`TUI did not render expected page: ${expected}`);
    }
    const frame = tui.output.lastSemanticFrame();
    assertFrameFits(frame, { columns, rows });
    for (const marker of markers?.[page - 1] ?? []) {
      assert.ok(semanticText(frame).includes(semanticText(marker)), `page ${page} is missing ${marker}`);
    }
    if (page < pages) await tui.send("\r");
  }
}

function assertNamedPhase(tui, phase) {
  const frame = tui.output.lastSemanticFrame();
  assert.ok(semanticText(frame).startsWith(`CODEKEEPER ${phase.toUpperCase()} `), `missing ${phase} phase label`);
  assert.doesNotMatch(frame, /\b(?:STEP|PHASE)\s+\d+\b/i);
}

function repositorySnapshot() {
  return Object.freeze({
    root: "/tmp/widget",
    repository: "acme/widget",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    viewerLogin: "cory",
    displayName: "widget"
  });
}

function fakeStat(type, size = 0) {
  return {
    size,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => false
  };
}

function fakeDirent(name, type) {
  return {
    name,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => false
  };
}

test("Ink TUI capability checks preserve Node 22 fallback and NO_COLOR semantics", () => {
  const input = { isTTY: true, setRawMode() {} };
  const output = { isTTY: true };
  assert.equal(shouldUseInkTui({ interactive: true, input, output, environment: { TERM: "xterm-256color" } }), true);
  assert.equal(shouldUseInkTui({ interactive: true, input, output, environment: { TERM: "xterm", NO_COLOR: "1" } }), true);
  assert.equal(shouldUseInkTui({ interactive: false, input, output, environment: { TERM: "xterm" } }), false);
  assert.equal(shouldUseInkTui({ interactive: true, input: { isTTY: false }, output, environment: { TERM: "xterm" } }), false);
  assert.equal(shouldUseInkTui({ interactive: true, input, output, environment: { TERM: "dumb" } }), false);
  assert.equal(sanitizeTextInput("safe\u0000\u001b\ntext\u007f"), "safetext");
});

test("runCli without an injected prompt dynamically selects the real Ink TUI and cancels before mutation", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const errorOutput = new TestOutput();
  let runnerCalls = 0;
  const statusPromise = runCli({
    argv: ["init"],
    input,
    output,
    errorOutput,
    interactive: true,
    environment: { TERM: "xterm-256color" },
    inspect: async () => repositorySnapshot(),
    runner: {
      async run() {
        runnerCalls += 1;
        throw new Error("no external command may run before repository confirmation");
      }
    }
  });
  await waitForTranscript(output, "Install into acme/widget");
  input.send("n");
  await tick();
  input.send("\r");
  const status = await statusPromise;
  assert.equal(status, 1);
  assert.equal(runnerCalls, 0);
  assert.match(errorOutput.transcript(), /Setup was cancelled before any mutation/);
  assert.doesNotMatch(errorOutput.transcript(), /interactive terminal UI could not be loaded/i);
  assert.ok(input.rawModeChanges.includes(true));
  assert.equal(input.rawModeChanges.at(-1), false);
});

test("private-key picker starts safely and exposes only opaque metadata", async (t) => {
  const home = await temporaryDirectory(t, "codekeeper-picker-path-canary-");
  const downloads = path.join(home, "Downloads");
  const folder = path.join(downloads, "nested");
  const good = path.join(downloads, "good-key.pem");
  const empty = path.join(downloads, "empty.pem");
  const oversized = path.join(downloads, "oversized.pem");
  const ignored = path.join(downloads, "notes.txt");
  const unsafeName = path.join(downloads, "unsafe\n.pem");
  const linked = path.join(downloads, "linked.pem");
  await mkdir(folder, { recursive: true });
  await writeFile(good, "test-only-key-material\n");
  await writeFile(empty, "");
  await writeFile(oversized, "x".repeat(STDIN_FILE_LIMIT_BYTES + 1));
  await writeFile(ignored, "not a key\n");
  await writeFile(unsafeName, "not visible\n");
  if (process.platform !== "win32") await symlink(good, linked);

  let reads = 0;
  const fsImpl = {
    lstat,
    readdir,
    async readFile() {
      reads += 1;
      throw new Error("picker must never read key contents");
    }
  };
  assert.equal(await defaultPrivateKeyDirectory({ fsImpl, homeDirectory: home }), downloads);
  const listing = await listPrivateKeyChoices(downloads, { fsImpl });
  const visible = listing.choices.map((choice) => choice.label);
  assert.equal(visible.includes("nested"), false);
  assert.ok(visible.includes("good-key.pem"));
  assert.equal(visible.includes("empty.pem"), false);
  assert.equal(visible.includes("oversized.pem"), false);
  assert.equal(visible.includes("notes.txt"), false);
  assert.equal(visible.includes("unsafe\n.pem"), false);
  if (process.platform !== "win32") assert.equal(visible.includes("linked.pem"), false);
  assert.equal(reads, 0);
  assert.ok(listing.choices.every((choice) => choice.type === "file"));
  const publicListing = JSON.stringify({ folderLabel: listing.folderLabel, choices: listing.choices });
  assert.doesNotMatch(publicListing, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(listing.choices.every((choice) => !Object.hasOwn(choice, "path") && !Object.hasOwn(choice, "target")));
  assert.equal(listing.targets.get(listing.choices.find((choice) => choice.label === "good-key.pem").id), good);
});

test("Ink provider credential stays inside the guided flow and submits pasted input with Enter", async (t) => {
  const tui = await createTuiHarness(t);
  const chunks = [];
  const submitted = tui.prompt.inputSecret({
    step: "credential",
    name: "OPENAI_API_KEY",
    purpose: "OpenAI model calls",
    write(chunk) {
      chunks.push(chunk);
    }
  });
  await tui.waitForText("OPENAI_API_KEY");
  await tui.send("\u001b[200~sk-test-provider-value\u001b[201~");
  assert.doesNotMatch(tui.output.transcript(), /sk-test-provider-value/);
  await tui.send("\r");
  await submitted;
  assert.deepEqual(chunks, ["sk-test-provider-value"]);
  assert.match(tui.output.transcript(), /Key received/);
});

test("private-key start folder falls back to home and rejects symlinked directories", async (t) => {
  const root = await temporaryDirectory(t, "codekeeper-picker-home-");
  const home = path.join(root, "home");
  const realDownloads = path.join(root, "real-downloads");
  await mkdir(home);
  await mkdir(realDownloads);
  if (process.platform === "win32") {
    assert.equal(await defaultPrivateKeyDirectory({ homeDirectory: home }), home);
    return;
  }
  await symlink(realDownloads, path.join(home, "Downloads"));
  assert.equal(await defaultPrivateKeyDirectory({ homeDirectory: home }), home);
  await assert.rejects(
    listPrivateKeyChoices(path.join(home, "Downloads")),
    (error) => error.code === "SECRET_INPUT_DIRECTORY_INVALID" && !error.message.includes(home)
  );
});

test("private-key start folder falls back when Downloads metadata is safe but listing is denied", async () => {
  const home = "/virtual/codekeeper-home";
  const downloads = path.join(home, "Downloads");
  const reads = [];
  const fsImpl = {
    async lstat(target) {
      assert.ok(target === downloads || target === home);
      return fakeStat("directory");
    },
    async readdir(target) {
      reads.push(target);
      if (target === downloads) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return [];
    }
  };

  assert.equal(await defaultPrivateKeyDirectory({ fsImpl, homeDirectory: home }), home);
  assert.deepEqual(reads, [downloads, home]);
});

test("private-key picker hides directories that it does not need", async (t) => {
  const home = "/virtual/codekeeper-home";
  const downloads = path.join(home, "Downloads");
  const denied = path.join(downloads, "denied");
  const keyPath = path.join(downloads, "recovery-key.pem");
  const fsImpl = {
    async lstat(target) {
      if ([home, downloads, denied].includes(target)) return fakeStat("directory");
      if (target === keyPath) return fakeStat("file", 1024);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async readdir(target) {
      if (target === downloads) {
        return [fakeDirent("denied", "directory"), fakeDirent("recovery-key.pem", "file")];
      }
      if (target === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
      if (target === home) return [fakeDirent("Downloads", "directory")];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
  };
  const tui = await createTuiHarness(t, { fsImpl, homeDirectory: home });
  const selection = tui.prompt.selectPrivateKey();
  await tui.waitForText("recovery-key.pem");
  assert.doesNotMatch(tui.output.lastSemanticFrame(), /denied/);
  await tui.send("\r");
  assert.equal(await selection, keyPath);
  const observable = tui.output.transcript();
  assert.doesNotMatch(observable, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("progress preserves stage order and always resumes after terminal handoff", async () => {
  const states = [];
  const handoff = [];
  const session = {
    setProgress(state) {
      states.push(structuredClone(state));
    },
    async suspendTerminal(callback) {
      handoff.push("start");
      try {
        return await callback();
      } finally {
        handoff.push("end");
      }
    },
    writeSuspendedNotice(notice) {
      handoff.push(`notice:${notice.name}:${notice.purpose}`);
    }
  };
  const progress = createInkProgress({ session });
  progress.start();
  progress.update({ id: "repository:verify", status: "active" });
  progress.update({ id: "repository:verify", status: "done" });
  progress.update({ id: "settings:disable", status: "active" });
  assert.equal(await progress.suspend(async () => {
    handoff.push("callback");
    return "saved";
  }, { name: "OPENAI_API_KEY", purpose: "OpenAI model calls" }), "saved");

  assert.deepEqual(DEFAULT_PROGRESS_STEPS.map((step) => step.id), [
    "repository:verify",
    "settings:disable",
    "secret:provider",
    "secret:app",
    "variables:configure",
    "git:commit",
    "git:push",
    "github:pull-request"
  ]);
  assert.deepEqual(handoff, [
    "start",
    "notice:OPENAI_API_KEY:OpenAI model calls",
    "callback",
    "end"
  ]);
  assert.equal(states.at(-2).paused, true);
  assert.equal(states.at(-1).paused, false);
  assert.equal(states.at(-1).events.find((event) => event.id === "repository:verify").status, "done");
  assert.equal(states.at(-1).events.find((event) => event.id === "settings:disable").status, "active");

  await assert.rejects(progress.suspend(async () => { throw new Error("handoff failed"); }), /handoff failed/);
  assert.equal(states.at(-1).paused, false);
});

test("Ink terminal handoff prints safe provider identity before the inherited prompt and never names the App key", async (t) => {
  const tui = await createTuiHarness(t);
  const notice = {
    name: "OPENAI_API_KEY",
    purpose: "OpenAI Platform API key for model calls after enablement; this is not a ChatGPT subscription"
  };
  let callbackTranscript = "";
  await tui.prompt.suspendTerminal(async () => {
    callbackTranscript = tui.output.transcript();
    return "stored";
  }, notice);

  assert.ok(callbackTranscript.length > 0);
  assert.match(callbackTranscript, /Codekeeper credential/);
  assert.match(callbackTranscript, /OPENAI_API_KEY — OpenAI Platform API key for model calls after enablement/);
  assert.match(callbackTranscript, /Enter this value only in the GitHub CLI prompt below/);
  assert.match(callbackTranscript, /An existing same-named secret is deliberately replaced only after you enter its new value/);
  assert.doesNotMatch(callbackTranscript, /CODEKEEPER_APP_PRIVATE_KEY|BEGIN (?:RSA )?PRIVATE KEY|\.pem/);
});

test("generic Ink text fields reject and redact PEM envelopes before rendering", async (t) => {
  const header = "-----BEGIN RSA PRIVATE KEY-----";
  const middle = "cGVtLXRleHQtZmllbGQtY2FuYXJ5";
  const footer = "-----END RSA PRIVATE KEY-----";
  const pem = `${header}\n${middle}\n${footer}`;
  assert.equal(containsPrivateKeyPemEnvelope(pem), true);
  assert.equal(containsPrivateKeyPemEnvelope("ordinary display name"), false);

  await t.test("bracketed paste", async (t) => {
    const tui = await createTuiHarness(t);
    const pending = tui.prompt.inputText({ message: "Display name", validate: () => true });
    const cancellation = assert.rejects(pending, (error) => error.code === "PROMPT_ABORTED");
    await tui.waitForText("Display name");
    await tui.send(`\u001b[200~${pem}\u001b[201~`);
    await tui.waitForText("Private keys cannot be pasted here");
    await tui.send("\u001b");
    await cancellation;
    const transcript = tui.output.transcript();
    for (const canary of [header, middle, footer]) assert.doesNotMatch(transcript, new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  await t.test("chunked ordinary input stays blocked until Ctrl-U", async (t) => {
    const tui = await createTuiHarness(t);
    const pending = tui.prompt.inputText({ message: "Owner label", validate: () => true });
    await tui.waitForText("Owner label");
    await tui.send("-----BE");
    await tui.send("GIN RSA PRIVATE KEY-----");
    await tui.waitForText("Private keys cannot be pasted here");
    await tui.send(middle);
    await tui.send(footer);
    for (const canary of ["-----BE", header, middle, footer]) {
      assert.doesNotMatch(tui.output.transcript(), new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    await tui.send("\u0015");
    await tui.send("safe-owner");
    await tui.send("\r");
    assert.equal(await pending, "safe-owner");
  });
});

test("Ink controls support arrows, j/k, checkboxes, text editing, Escape, and Ctrl-C", async (t) => {
  const tui = await createTuiHarness(t);
  const confirmation = tui.prompt.confirm({ message: "Confirm repository", defaultValue: false });
  await tui.waitForText("Confirm repository");
  await tui.send("\u001b[D");
  await tui.send("\r");
  assert.equal(await confirmation, true);

  const selection = tui.prompt.select({
    message: "Choose preset",
    choices: [{ value: "openai", label: "OpenAI" }, { value: "mixed", label: "Mixed" }],
    defaultValue: "openai"
  });
  await tui.waitForText("Choose preset");
  await tui.send("\u001b[B");
  await tui.send("\u001b[A");
  await tui.send("j");
  await tui.send("k");
  await tui.send("\u001b[B");
  await tui.send("\r");
  assert.equal(await selection, "mixed");

  const modes = tui.prompt.multiselect({
    message: "Choose workflows",
    choices: [
      { value: "review", label: "Review" },
      { value: "maintain", label: "Maintain" },
      { value: "issues", label: "Issues" },
      { value: "fix", label: "Fix" }
    ],
    defaultValues: ["review", "maintain"]
  });
  await tui.waitForText("Choose workflows");
  await tui.send(" ");
  await tui.send("j");
  await tui.send("j");
  await tui.send(" ");
  await tui.send("\r");
  assert.deepEqual(await modes, ["maintain", "issues"]);

  const text = tui.prompt.inputText({ message: "Display name", validate: () => true });
  await tui.waitForText("Display name");
  await tui.send("ab");
  await tui.send("\u007f");
  await tui.send("c");
  await tui.send("\r");
  assert.equal(await text, "ac");

  const escaped = tui.prompt.confirm({ message: "Escape this", defaultValue: true });
  const escapedAssertion = assert.rejects(escaped, (error) => error.code === "PROMPT_ABORTED");
  await tui.waitForText("Escape this");
  await tui.send("\u001b");
  await escapedAssertion;

  const interrupted = tui.prompt.confirm({ message: "Interrupt this", defaultValue: true });
  const interruptedAssertion = assert.rejects(interrupted, (error) => error.code === "PROMPT_ABORTED");
  await tui.waitForText("Interrupt this");
  await tui.send("\u0003");
  await interruptedAssertion;

  await tui.dispose();
  assert.ok(tui.input.rawModeChanges.includes(true));
  assert.equal(tui.input.rawModeChanges.at(-1), false);
});

test("recommended and custom setup paths produce the same semantic answers as the fallback prompts", async (t) => {
  const bundle = await loadVerifiedAssets();

  await t.test("recommended", async (t) => {
    const tui = await createTuiHarness(t);
    const answers = collectSetupAnswers({ prompt: tui.prompt, snapshot: repositorySnapshot(), bundle, output: tui.prompt.notices });
    await tui.waitForText("Install into acme/widget");
    assertNamedPhase(tui, "repository");
    await tui.send("y");
    await tui.send("\r");
    await tui.waitForText("Choose a starting setup");
    assertNamedPhase(tui, "setup");
    assert.match(semanticText(tui.output.lastSemanticFrame()), /OpenAI models/);
    await tui.send("\r");
    await tui.waitForText("Assign a model to the Pull request reviewer");
    assertNamedPhase(tui, "models");
    await tui.send("j");
    await tui.send("\r");
    await tui.waitForText("Assign a model to the Repository auditor");
    await tui.send("\r");
    await tui.waitForText("Enable OpenAI traces");
    assertNamedPhase(tui, "tracing");
    await tui.send("\r");
    await tui.waitForText("Start Codekeeper after the setup pull request merges");
    assertNamedPhase(tui, "startup");
    await tui.send("\r");
    await tui.waitForText("Choose capabilities to turn on");
    assertNamedPhase(tui, "capabilities");
    assert.match(tui.output.lastSemanticFrame(), /Repository repair/);
    assert.match(tui.output.lastSemanticFrame(), /Automatic merge/);
    await tui.send("\r");
    await tui.waitForText("Name to show in Codekeeper comments");
    assertNamedPhase(tui, "identity");
    await tui.send("\r");
    await tui.waitForText("GitHub users who can run");
    assertNamedPhase(tui, "identity");
    await tui.send("\r");
    await tui.waitForText("Continue with these safety settings");
    assertNamedPhase(tui, "safety");
    await tui.send("y");
    await tui.send("\r");
    assert.deepEqual(await answers, {
      modes: ["review", "maintain"],
      preset: "openai",
      models: { review: "terra-high", maintain: "sol-high" },
      tracing: true,
      displayName: "widget",
      ownerLogins: ["cory"],
      enabled: true,
      capabilities: ["repair", "autoMerge"]
    });
  });

  await t.test("custom", async (t) => {
    const tui = await createTuiHarness(t);
    const answers = collectSetupAnswers({ prompt: tui.prompt, snapshot: repositorySnapshot(), bundle, output: tui.prompt.notices });
    await tui.waitForText("Install into acme/widget");
    assertNamedPhase(tui, "repository");
    await tui.send("y");
    await tui.send("\r");
    await tui.waitForText("Choose a starting setup");
    assertNamedPhase(tui, "setup");
    await tui.send("j");
    await tui.send("\r");
    await tui.waitForText("Choose workflows");
    assertNamedPhase(tui, "workflows");
    await tui.send(" ");
    await tui.send("j");
    await tui.send(" ");
    await tui.send("j");
    await tui.send(" ");
    await tui.send("j");
    await tui.send(" ");
    await tui.send("\r");
    await tui.waitForText("Choose the starting model set");
    assertNamedPhase(tui, "models");
    assert.match(tui.output.lastSemanticFrame(), /change every role on the next screens/);
    assert.match(semanticText(tui.output.lastSemanticFrame()), /use OpenAI for every selected workflow/);
    assert.match(semanticText(tui.output.lastSemanticFrame()), /use DeepSeek for issue triage/);
    await tui.send("j");
    await tui.send("\r");
    await tui.waitForText("Assign a model to the Issue triager");
    await tui.send("\r");
    await tui.waitForText("Assign a model to the Maintenance planner");
    await tui.send("\r");
    await tui.waitForText("Enable OpenAI traces");
    await tui.send("\r");
    await tui.waitForText("Start Codekeeper after the setup pull request merges");
    assertNamedPhase(tui, "startup");
    await tui.send("\r");
    await tui.waitForText("Choose capabilities to turn on");
    assertNamedPhase(tui, "capabilities");
    assert.match(tui.output.lastSemanticFrame(), /Issue implementation/);
    assert.match(tui.output.lastSemanticFrame(), /Automatic duplicate closure/);
    assert.match(tui.output.lastSemanticFrame(), /Automatic merge/);
    await tui.send("\r");
    await tui.waitForText("Name to show in Codekeeper comments");
    assertNamedPhase(tui, "identity");
    await tui.send("Custom");
    await tui.send("\r");
    await tui.waitForText("GitHub users who can run");
    assertNamedPhase(tui, "identity");
    await tui.send("alice");
    await tui.send("\r");
    await tui.waitForText("Continue with these safety settings");
    assertNamedPhase(tui, "safety");
    await tui.send("y");
    await tui.send("\r");
    assert.deepEqual(await answers, {
      modes: ["issues", "fix"],
      preset: "mixed",
      models: { issues: "deepseek-v4-flash", fix: "terra-high" },
      tracing: true,
      displayName: "Custom",
      ownerLogins: ["alice"],
      enabled: true,
      capabilities: ["issueImplementation", "duplicateClosure", "autoMerge"]
    });
  });
});

test("GitHub App TUI explains the App name and derives the bot login", async (t) => {
  const tui = await createTuiHarness(t);
  const answers = collectAppAnswers({ prompt: tui.prompt, modes: ["review"], output: tui.prompt.notices });
  await tui.waitForText("GitHub App Client ID");
  assertNamedPhase(tui, "GitHub App");
  assert.match(tui.output.lastSemanticFrame(), /begins with Iv/);
  assert.match(tui.output.lastSemanticFrame(), /Do not enter the numeric App ID/);
  await tui.send("4528809");
  await tui.send("\r");
  assert.match(tui.output.lastSemanticFrame(), /Enter the App Client ID/);
  await tui.send("\u0015");
  await tui.send("Iv123456789012345678");
  await tui.send("\r");
  await tui.waitForText("GitHub App name from the settings URL");
  assertNamedPhase(tui, "GitHub App");
  assert.match(tui.output.lastSemanticFrame(), /settings URL/);
  assert.match(tui.output.lastSemanticFrame(), /my-codekeeper-app\[bot\]/);
  await tui.send("codekeeper-widget");
  await tui.send("\r");
  assert.deepEqual(await answers, {
    appClientId: "Iv123456789012345678",
    automationBotLogin: "codekeeper-widget[bot]"
  });
});

test("final review supports paged Back navigation and requires explicit creation approval", async (t) => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: repositorySnapshot(),
    answers: {
      modes: ["review", "maintain"],
      preset: "openai",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    }
  });
  const tui = await createTuiHarness(t);
  const approved = tui.prompt.reviewInstallPlan(plan);
  await tui.waitForText("Review the setup · 1 of 3");
  assertNamedPhase(tui, "final review");
  assert.match(tui.output.lastSemanticFrame(), /Nothing has changed/);
  await tui.send("\r");
  await tui.waitForText("Review the setup · 2 of 3");
  await tui.send("\r");
  await tui.waitForText("Review the setup · 3 of 3");
  await tui.send("\u007f");
  await tui.waitForText("Review the setup · 2 of 3");
  await tui.send("\u001b[C");
  await tui.waitForText("Review the setup · 3 of 3");
  await tui.send("\u001b[D");
  await tui.send("\r");
  assert.equal(await approved, true);

  const cancelled = tui.prompt.reviewInstallPlan(plan);
  const cancellation = assert.rejects(cancelled, (error) => error.code === "PROMPT_ABORTED");
  await tui.waitForText("Review the setup · 1 of 3");
  await tui.send("\u001b");
  await cancellation;
});

test("Ink completion shows every completed step on one screen", async (t) => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: repositorySnapshot(),
    answers: {
      modes: ["review", "maintain", "issues", "fix"],
      preset: "mixed",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    }
  });
  const receipt = {
    branch: "codekeeper/setup",
    commit: "c".repeat(40),
    pullRequestUrl: "https://github.com/acme/widget/pull/42"
  };
  const tui = await createTuiHarness(t);
  const completion = tui.prompt.showCompletion(plan, receipt);
  await tui.waitForText("Setup complete");
  assertNamedPhase(tui, "complete");
  const rendered = semanticText(tui.output.lastSemanticFrame());
  for (const step of DEFAULT_PROGRESS_STEPS) assert.match(rendered, new RegExp(`✓ ${step.label}`));
  assert.match(rendered, /OpenAI traces: enabled/);
  assert.doesNotMatch(rendered, /Setup complete · \d+ of \d+/);
  await tui.send("\r");
  assert.equal(await completion, true);
});

test("all-four-mode review and completion fit bounded terminal dimensions", async (t) => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: repositorySnapshot(),
    answers: {
      modes: ["review", "maintain", "issues", "fix"],
      preset: "mixed",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    }
  });
  const guidance = completionGuidance(plan.modes);
  const reviewMarkers = [
    ["Workflows", "Pull request review"],
    ["Models (editable", "gpt-5.6"],
    ["Policy and caller documents", ".github/codekeeper.json"],
    ["Editable agent profiles"],
    ["Secrets requested through GitHub CLI", "OPENAI_TRACE_API_KEY"],
    ["Settings", "Codekeeper starts after merge"],
    ["Fixed boundaries"],
    [guidance.reviewGateWarning, "Create setup", "› Cancel"]
  ];
  const completionMarkers = [[
    "✓ Recheck the confirmed repository",
    "✓ Set the startup choice",
    "✓ Store API keys",
    "✓ Store the GitHub App key safely",
    "✓ Set non-secret repository variables",
    "✓ Create and verify the setup commit",
    "✓ Push the setup branch",
    "✓ Open the setup pull request",
    "Codekeeper starts after merge"
  ]];
  for (const dimensions of [
    { columns: 40, rows: 24 },
    { columns: 40, rows: 29 },
    { columns: 34, rows: 40 },
    { columns: 41, rows: 29 },
    { columns: 80, rows: 24 },
    { columns: 99, rows: 40 },
    { columns: 100, rows: 39 }
  ]) {
    await t.test(`${dimensions.columns}x${dimensions.rows} uses bounded detail pages`, async (t) => {
      const tui = await createTuiHarness(t, dimensions);
      const review = tui.prompt.reviewInstallPlan(plan);
      const reviewCancellation = assert.rejects(review, (error) => error.code === "PROMPT_ABORTED");
      await assertPagedScreenFits(tui, { kind: "review", markers: reviewMarkers, ...dimensions });
      await tui.send("\u001b");
      await reviewCancellation;

      const completion = tui.prompt.showCompletion(plan, {
        branch: "codekeeper/setup",
        commit: "c".repeat(40),
        pullRequestUrl: "https://github.com/acme/widget/pull/42"
      });
      await assertPagedScreenFits(tui, { kind: "completion", markers: completionMarkers, ...dimensions });
      await tui.send("\u001b");
      assert.equal(await completion, true);
    });
  }

  await t.test("100x40 uses the fitting unpaged detail layout", async (t) => {
    const dimensions = { columns: 100, rows: 40 };
    const tui = await createTuiHarness(t, dimensions);
    const review = tui.prompt.reviewInstallPlan(plan);
    const reviewCancellation = assert.rejects(review, (error) => error.code === "PROMPT_ABORTED");
    await assertPagedScreenFits(tui, {
      kind: "review",
      markers: [
        ["Workflows", "Models (editable", "gpt-5.6"],
        ["Document map", ".github/codekeeper/agents/pr-reviewer.md", "Secrets requested through GitHub CLI", "OPENAI_TRACE_API_KEY"],
        ["Settings", guidance.reviewGateWarning, "Create setup", "› Cancel"]
      ],
      ...dimensions
    });
    await tui.send("\u001b");
    await reviewCancellation;

    const completion = tui.prompt.showCompletion(plan, {
      branch: "codekeeper/setup",
      commit: "c".repeat(40),
      pullRequestUrl: "https://github.com/acme/widget/pull/42"
    });
    await assertPagedScreenFits(tui, {
      kind: "completion",
      markers: [[...completionMarkers[0], "OpenAI traces: enabled", guidance.reviewGateWarning, guidance.closing]],
      ...dimensions
    });
    assertFrameFits(tui.output.lastSemanticFrame(), dimensions);
    await tui.send("\u001b");
    assert.equal(await completion, true);
  });
});

test("private-key TUI shows only keys and redacts paths and bytes", async (t) => {
  const home = await temporaryDirectory(t, "codekeeper-picker-secret-path-");
  const downloads = path.join(home, "Downloads");
  const nested = path.join(downloads, "nested");
  const keyPath = path.join(downloads, "visible-key-name.pem");
  const keyBytes = "private-key-content-canary";
  await mkdir(nested, { recursive: true });
  await writeFile(keyPath, keyBytes);
  if (process.platform !== "win32") await symlink(keyPath, path.join(downloads, "hidden-link.pem"));
  const tui = await createTuiHarness(t, { homeDirectory: home });
  const selection = tui.prompt.selectPrivateKey();
  await tui.waitForText("visible-key-name.pem");
  assertNamedPhase(tui, "private key");
  assert.match(tui.output.lastSemanticFrame(), /Keys in Downloads/);
  assert.doesNotMatch(tui.output.transcript(), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(tui.output.transcript(), new RegExp(keyBytes));
  assert.doesNotMatch(tui.output.transcript(), /hidden-link\.pem/);

  assert.doesNotMatch(tui.output.lastSemanticFrame(), /nested/);
  await tui.send("\u001b[200~pasted-private-key-canary\u001b[201~");
  assert.doesNotMatch(tui.output.transcript(), /pasted-private-key-canary/);
  await tui.send("\r");
  assert.equal(await selection, keyPath);
  await tui.flush();
  assert.doesNotMatch(tui.output.transcript(), new RegExp(keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(tui.output.transcript(), new RegExp(keyBytes));
});

test("NO_COLOR and narrow terminals retain visible selection semantics without overflow", async (t) => {
  const tui = await createTuiHarness(t, { columns: 34, environment: { TERM: "xterm", NO_COLOR: "1" } });
  const confirmation = tui.prompt.confirm({
    message: "Install into acme/widget?",
    defaultValue: false,
    yesLabel: "Use this repository",
    noLabel: "Cancel"
  });
  await tui.waitForText("Install into acme/widget?");
  assert.match(tui.output.lastSemanticFrame(), /› Cancel/);
  await tui.send("\u001b[D");
  assert.match(tui.output.lastSemanticFrame(), /› Use this repository/);
  await tui.send("\r");
  assert.equal(await confirmation, true);

  const pending = tui.prompt.multiselect({
    message: "Choose workflows",
    choices: [{ value: "review", label: "Review" }, { value: "maintain", label: "Maintenance" }],
    defaultValues: ["review"]
  });
  const cancellation = assert.rejects(pending, (error) => error.code === "PROMPT_ABORTED");
  await tui.waitForText("Choose workflows");
  const frame = tui.output.lastSemanticFrame();
  assert.match(frame, /› \[x\] Review/);
  assert.match(frame, /\[ \] Maintenance/);
  assertFrameFits(frame, { columns: 34, rows: 40 });
  await tui.send("\u001b");
  await cancellation;

  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: repositorySnapshot(),
    answers: {
      modes: ["review", "maintain"],
      preset: "openai",
      displayName: "Widget",
      ownerLogins: ["cory"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-widget[bot]"
    }
  });
  const review = tui.prompt.reviewInstallPlan(plan);
  const reviewCancellation = assert.rejects(review, (error) => error.code === "PROMPT_ABORTED");
  for (let page = 1; page <= 8; page += 1) {
    await tui.waitForText(`Review the setup · ${page} of 8`);
    if (page < 8) await tui.send("\r");
  }
  assert.match(tui.output.lastSemanticFrame(), /› Cancel/);
  await tui.send("\u001b[D");
  assert.match(tui.output.lastSemanticFrame(), /› Create setup/);
  await tui.send("\u001b");
  await reviewCancellation;
  assert.doesNotMatch(tui.output.transcript(), COLOR_SGR_SEQUENCE);
});
