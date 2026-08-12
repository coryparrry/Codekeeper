import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("post-input secret upload has a finite command budget", async () => {
  const installModuleUrl = new URL("../src/install.mjs", import.meta.url).href;
  const script = `
    import { configureRepositorySettings } from ${JSON.stringify(installModuleUrl)};
    const plan = {
      root: "/tmp/codekeeper-install-audit",
      repository: "owner/repository",
      update: true,
      variables: [],
      secrets: [{ name: "OPENAI_API_KEY" }]
    };
    const runner = {
      run(_command, _args, options) {
        if (options.timeoutMs === null) {
          setInterval(() => {}, 1000);
          return new Promise(() => {});
        }
        return Promise.resolve({ status: 1, timedOut: true, truncated: false, stdout: "", stderr: "" });
      }
    };
    await configureRepositorySettings(plan, {
      runner,
      output: { write() {} },
      withSecretInput: async ({ write }) => write("audit-secret")
    });
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
  assert.equal(outcome.timedOut, false, "secret upload remained pending beyond its command budget");
  assert.equal(outcome.signal, null, "secret upload was killed instead of failing closed");
  assert.notEqual(outcome.code, null, "secret upload did not report a bounded exit");
});
