import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertValidationReceipt, createValidationReceipt } from "../src/lib/git.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const candidateSha256 = "a".repeat(64);
const configSha256 = "b".repeat(64);
const patchSha256 = "c".repeat(64);
const baseSha = "d".repeat(40);

test("fresh validation returns a receipt-safe result and binds it to the exact inputs", () => {
  const stdout = "validation output must not enter the receipt";
  const command = "npm test";
  const commandResult = {
    command,
    success: true,
    exitCode: 0,
    durationMs: 12,
    stdoutDigest: digest(stdout),
    startedAt: "2026-08-17T12:00:00.000Z",
    stdout,
    stderr: "private stderr",
    environment: { SECRET: "must not enter the receipt" },
  };

  const receipt = createValidationReceipt({
    candidateSha256,
    configSha256,
    patchSha256,
    baseSha,
    commands: [commandResult],
    patchUnchanged: true,
  });
  assert.deepEqual(
    Object.keys(receipt).sort(),
    ["baseSha", "candidateSha256", "commands", "configSha256", "patchSha256", "patchUnchanged", "version"].sort(),
  );
  assert.doesNotMatch(JSON.stringify(receipt), /private stderr|validation output|must not enter/);
  assert.equal(
    assertValidationReceipt(receipt, {
      candidateSha256,
      configSha256,
      patchSha256,
      baseSha,
      commands: [command],
    }),
    receipt,
  );
});

test("stale, failed, or incomplete validation receipts are rejected", () => {
  const command = "npm test";
  const commandResult = {
    command,
    exitCode: 0,
    durationMs: 12,
    stdoutDigest: "e".repeat(64),
    startedAt: "2026-08-17T12:00:00.000Z",
  };
  const expected = { candidateSha256, configSha256, patchSha256, baseSha, commands: [command] };
  const receipt = createValidationReceipt({ ...expected, commands: [commandResult], patchUnchanged: true });
  assert.doesNotThrow(() => assertValidationReceipt(receipt, expected));

  for (const [name, mutate, message] of [
    ["candidate", (value) => { value.candidateSha256 = "f".repeat(64); }, /candidateSha256 is stale/],
    ["config", (value) => { value.configSha256 = "f".repeat(64); }, /configSha256 is stale/],
    ["patch", (value) => { value.patchSha256 = "f".repeat(64); }, /patchSha256 is stale/],
    ["base", (value) => { value.baseSha = "e".repeat(40); }, /base SHA is stale/],
    ["command", (value) => { value.commands[0].command = "false"; }, /not the configured command/],
    ["exit", (value) => { value.commands[0].exitCode = 1; }, /did not pass/],
    ["patch state", (value) => { value.patchUnchanged = false; }, /unchanged patch/],
    ["raw output", (value) => { value.commands[0].stdout = "forbidden"; }, /unexpected fields/],
  ]) {
    const stale = structuredClone(receipt);
    mutate(stale);
    assert.throws(() => assertValidationReceipt(stale, expected), message, name);
  }
});
