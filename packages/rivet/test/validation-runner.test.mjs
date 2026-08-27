import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeValidationCommands,
  runRepairValidation,
} from "../src/validation-runner.mjs";

test("runs every configured command in order and freezes its receipt", async () => {
  const calls = [];
  const result = await runRepairValidation({
    commands: [" npm test ", "npm run check"],
    cwd: "/repository",
    timeoutMs: 30_000,
    execute: async (command, options) => {
      calls.push([command, options]);
      return { exitCode: 0, timedOut: false };
    },
  });

  assert.deepEqual(calls, [
    ["npm test", { cwd: "/repository", timeoutMs: 30_000 }],
    ["npm run check", { cwd: "/repository", timeoutMs: 30_000 }],
  ]);
  assert.deepEqual(result, {
    passed: true,
    commands: [
      { command: "npm test", exitCode: 0 },
      { command: "npm run check", exitCode: 0 },
    ],
  });
  assert.equal(Object.isFrozen(result.commands[0]), true);
});

test("stops at the first failed command and exposes a failed receipt", async () => {
  const calls = [];
  await assert.rejects(
    runRepairValidation({
      commands: ["npm test", "npm run check"],
      execute: async (command) => {
        calls.push(command);
        return { exitCode: command === "npm test" ? 1 : 0, timedOut: false };
      },
    }),
    (error) => {
      assert.match(error.message, /command failed: npm test/);
      assert.deepEqual(error.receipt, {
        passed: false,
        commands: [{ command: "npm test", exitCode: 1 }],
      });
      return true;
    },
  );
  assert.deepEqual(calls, ["npm test"]);
});

test("fails closed on timeouts and invalid runner results", async () => {
  await assert.rejects(
    runRepairValidation({
      commands: ["npm test"],
      execute: async () => ({ exitCode: 0, timedOut: true }),
    }),
    (error) => {
      assert.match(error.message, /command timed out/);
      assert.equal(error.receipt.commands[0].exitCode, 124);
      return true;
    },
  );
  await assert.rejects(
    runRepairValidation({
      commands: ["npm test"],
      execute: async () => ({ exitCode: "0", timedOut: false }),
    }),
    /runner returned an invalid result/,
  );
  await assert.rejects(
    runRepairValidation({
      commands: ["npm test"],
      execute: async () => ({ exitCode: 256, timedOut: false }),
    }),
    /runner returned an invalid result/,
  );
});

test("rejects unsafe, duplicate, and unbounded command lists", () => {
  for (const commands of [
    [],
    ["npm test\nrm output"],
    ["npm `echo test`"],
    ["npm test", " npm test "],
  ]) {
    assert.throws(
      () => normalizeValidationCommands(commands),
      /Rivet repair validation/,
    );
  }
});
