import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("private-key listing remains bounded for a directory with many child folders", async () => {
  const moduleUrl = new URL("../src/private-key-input.mjs", import.meta.url).href;
  const script = `
    import { listPrivateKeyChoices } from ${JSON.stringify(moduleUrl)};
    const root = "/tmp/codekeeper-picker-audit";
    const entries = Array.from({ length: 500 }, (_, index) => ({
      name: "folder-" + index,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false
    }));
    const fsImpl = {
      async lstat(target) {
        if (target !== root) await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
          size: 0,
          mtimeMs: 0
        };
      },
      async readdir(target) { return target === root ? entries : []; }
    };
    await listPrivateKeyChoices(root, { fsImpl, rootDirectory: root, includeDirectories: true });
  `;
  const child = spawn("node", ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  const outcome = await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 750);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  assert.equal(outcome.timedOut, false, "large directory enumeration blocked the installer past its budget");
  assert.equal(outcome.signal, null);
  assert.notEqual(outcome.code, null, "large directory enumeration did not report a bounded exit");
});
