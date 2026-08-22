import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getAgentRuntimeSettings } from "../src/lib/config.mjs";
import { prepareCodexLinuxSandbox } from "../src/lib/orchestration/workspace-isolation.mjs";
import { validateFixResult } from "../src/lib/schemas.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8"),
);

const githubHostedLinux = {
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "Linux",
  RUNNER_ENVIRONMENT: "github-hosted",
};

test("GitHub-hosted Linux enables Codex Bubblewrap prerequisites while retaining its sandbox", async () => {
  const values = new Map([
    ["kernel.unprivileged_userns_clone", "0"],
    ["kernel.apparmor_restrict_unprivileged_userns", "1"],
  ]);
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    if (command === "sysctl") {
      return { stdout: `${values.get(args[1]) ?? ""}\n` };
    }
    if (command === "sudo") {
      const [name, value] = args[2].split("=");
      values.set(name, value);
      return { stdout: `${args[2]}\n` };
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  const prepared = await prepareCodexLinuxSandbox({
    environment: githubHostedLinux,
    platform: "linux",
    execute,
  });

  assert.deepEqual(prepared.changed, [
    "kernel.unprivileged_userns_clone",
    "kernel.apparmor_restrict_unprivileged_userns",
  ]);
  assert.deepEqual(calls, [
    ["sysctl", ["-n", "kernel.unprivileged_userns_clone"]],
    ["sudo", ["sysctl", "-w", "kernel.unprivileged_userns_clone=1"]],
    ["sysctl", ["-n", "kernel.apparmor_restrict_unprivileged_userns"]],
    ["sudo", ["sysctl", "-w", "kernel.apparmor_restrict_unprivileged_userns=0"]],
  ]);

  const writable = structuredClone(config);
  writable.audit.repair.enabled = true;
  assert.equal(
    getAgentRuntimeSettings(writable, "audit", { mutationAuthorized: true }).workspaceSandbox,
    "workspace-write",
  );
  assert.equal(
    getAgentRuntimeSettings(writable, "fix", { mutationAuthorized: true }).workspaceSandbox,
    "workspace-write",
  );
  assert.equal(getAgentRuntimeSettings(writable, "review").workspaceSandbox, "read-only");
  assert.equal(getAgentRuntimeSettings(writable, "issue").workspaceSandbox, "read-only");
});

test("sandbox prerequisite setup is inert outside GitHub-hosted Linux", async () => {
  let executions = 0;
  const prepared = await prepareCodexLinuxSandbox({
    environment: {
      ...githubHostedLinux,
      RUNNER_ENVIRONMENT: "self-hosted",
    },
    platform: "linux",
    execute: async () => {
      executions += 1;
      return { stdout: "" };
    },
  });
  assert.deepEqual(prepared, { changed: [] });
  assert.equal(executions, 0);
});

test("Fixer rejects a command receipt for a command that never ran", () => {
  const target = { kind: "issue", number: 63 };
  const result = {
    mode: "fix",
    summary: "The command runtime failed before inspection.",
    risk: "low",
    targetKind: "issue",
    targetNumber: 63,
    changedSummary: "",
    testsRun: [{
      command: "git rev-parse HEAD; git status --short",
      result: "Did not run: sandbox failed before command execution.",
    }],
    resolvedReviewThreadIds: [],
    readyForReview: false,
    noChangeReason: "The execution sandbox did not start.",
  };

  assert.throws(
    () => validateFixResult(structuredClone(result), target),
    /must describe a command that actually ran/,
  );
  result.testsRun[0].result = "exited 1: the deterministic regression test failed";
  assert.doesNotThrow(() => validateFixResult(structuredClone(result), target));
});
