import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { render as inkRender } from "ink";
import { createInkPrompter } from "../src/tui.mjs";

const ESCAPE_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/g;

class TestInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.queue = [];
  }

  setEncoding() {}
  setRawMode() { return this; }
  ref() { return this; }
  unref() { return this; }
  pause() { return this; }
  resume() { return this; }
  read() { return this.queue.shift() ?? null; }

  send(value) {
    this.queue.push(value);
    this.emit("readable");
  }
}

class TestOutput extends EventEmitter {
  constructor() {
    super();
    this.columns = 100;
    this.rows = 40;
    this.isTTY = true;
    this.frames = [];
  }

  write(value) {
    this.frames.push(String(value));
    return true;
  }

  transcript() {
    return this.frames.join("");
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function createTuiHarness(t, { fsImpl, homeDirectory } = {}) {
  const input = new TestInput();
  const output = new TestOutput();
  const errorOutput = new TestOutput();
  let instance;
  const prompt = await createInkPrompter({
    input,
    output,
    errorOutput,
    environment: { TERM: "xterm-256color" },
    ...(fsImpl ? { fsImpl } : {}),
    ...(homeDirectory ? { homeDirectory } : {}),
    renderImpl: (tree, options) => {
      instance = inkRender(tree, { ...options, debug: true, renderThrottleMs: 0 });
      return instance;
    }
  });
  t.after(async () => prompt.dispose());
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
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await flush();
      if (output.transcript().replace(ESCAPE_SEQUENCE, "").includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`TUI did not render ${text}`);
  };
  return { prompt, output, send, waitForText };
}

test("secret input does not commit a truncated value from ordinary keystrokes", async (t) => {
  const tui = await createTuiHarness(t);
  const chunks = [];
  const submitted = tui.prompt.inputSecret({
    step: "credential",
    name: "CODEKEEPER_MODEL_API_KEY",
    purpose: "Model calls",
    write(value) { chunks.push(value); }
  });
  const submittedSettled = submitted.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await tui.waitForText("CODEKEEPER_MODEL_API_KEY");
  await tui.send("x");
  await tui.send("y");
  const transcriptBeforeCancel = tui.output.transcript().replace(ESCAPE_SEQUENCE, "");
  await tui.send("\u001b");
  const submittedResult = await submittedSettled;
  assert.match(submittedResult.error?.message ?? "", /cancelled/u);
  assert.deepEqual(chunks, [], "ordinary input committed a partial credential before the user finished typing");
  assert.doesNotMatch(transcriptBeforeCancel, /Key received/u);
});

test("a delayed picker activation cannot settle a newer screen", { timeout: 5000 }, async (t) => {
  const home = "/virtual/codekeeper-home";
  const downloads = `${home}/Downloads`;
  const oldPath = `${downloads}/old.pem`;
  const newPath = `${downloads}/new.pem`;
  let current = "old";
  let holdOldActivation = false;
  let releaseOldActivation;
  const oldActivation = new Promise((resolve) => { releaseOldActivation = resolve; });
  const stat = (kind) => ({
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
    size: kind === "file" ? 1024 : 0,
    mtimeMs: 0
  });
  const fsImpl = {
    async lstat(target) {
      if (target === home || target === downloads) return stat("directory");
      if (target === oldPath) {
        if (holdOldActivation) await oldActivation;
        return stat("file");
      }
      if (target === newPath) return stat("file");
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async readdir(target) {
      if (target === downloads) return [
        {
          name: current === "old" ? "old.pem" : "new.pem",
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false
        }
      ];
      if (target === home) return [{
        name: "Downloads",
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false
      }];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
  };
  const tui = await createTuiHarness(t, { fsImpl, homeDirectory: home });
  const first = tui.prompt.selectPrivateKey();
  const firstSettled = first.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await tui.waitForText("old.pem");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await tui.send("\u001b[B");
  holdOldActivation = true;
  await tui.send("\r");
  current = "new";
  await tui.send("\u001b");
  const firstResult = await firstSettled;
  assert.match(firstResult.error?.message ?? "", /cancelled/u);

  const second = tui.prompt.selectPrivateKey();
  let secondSettled = false;
  second.finally(() => { secondSettled = true; });
  await tui.waitForText("new.pem");
  releaseOldActivation();
  await tick();
  assert.equal(secondSettled, false, "the stale picker callback settled the replacement prompt");
  await tui.send("\u001b[B");
  await tui.send("\r");
  assert.equal(await second, newPath, "a stale picker callback settled the replacement prompt");
});
