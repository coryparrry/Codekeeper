import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  createAuthorityReceipt,
  runAuthorityReceiptAction,
} from "../assets/review/.github/rivet/actions/authority-receipt/index.mjs";

const INPUTS = Object.freeze({
  compilerVersion: "v0.86.2",
  workflowId: "rivet-review",
  workflowRef:
    "owner/repository/.github/workflows/rivet-review.lock.yml@refs/heads/main",
  workflowSha: "a".repeat(40),
});
const ACTION_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "review",
  ".github",
  "rivet",
  "actions",
  "authority-receipt",
);

test("declares one dependency-free Node action boundary", async () => {
  const action = parse(
    await readFile(path.join(ACTION_ROOT, "action.yml"), "utf8"),
  );
  assert.deepEqual(Object.keys(action.inputs).sort(), [
    "compiler-version",
    "workflow-id",
    "workflow-ref",
    "workflow-sha",
  ]);
  assert.deepEqual(action.runs, { using: "node24", main: "index.mjs" });
  assert.deepEqual(Object.keys(action.outputs), ["receipt"]);
});

test("creates a canonical Rivet base-branch authority receipt", () => {
  assert.deepEqual(createAuthorityReceipt(INPUTS), {
    schemaVersion: 1,
    workflowId: "rivet-review",
    compilerVersion: "v0.86.2",
    workflowRef:
      "owner/repository/.github/workflows/rivet-review.lock.yml@refs/heads/main",
    workflowSha: "a".repeat(40),
  });
});

test("writes the receipt through the GitHub Actions output boundary", async () => {
  const writes = [];
  const receipt = await runAuthorityReceiptAction({
    env: {
      GITHUB_OUTPUT: "/github/output",
      "INPUT_COMPILER-VERSION": INPUTS.compilerVersion,
      "INPUT_WORKFLOW-ID": INPUTS.workflowId,
      "INPUT_WORKFLOW-REF": INPUTS.workflowRef,
      "INPUT_WORKFLOW-SHA": INPUTS.workflowSha,
    },
    appendFileImpl: async (...args) => writes.push(args),
  });
  assert.equal(receipt.workflowSha, INPUTS.workflowSha);
  assert.deepEqual(writes, [
    ["/github/output", `receipt=${JSON.stringify(receipt)}\n`, "utf8"],
  ]);
});

test("rejects mutable refs and malformed identity inputs", () => {
  for (const inputs of [
    { ...INPUTS, compilerVersion: "latest" },
    { ...INPUTS, workflowId: "../review" },
    { ...INPUTS, workflowSha: "main" },
    {
      ...INPUTS,
      workflowRef:
        "owner/repository/.github/workflows/rivet-review.lock.yml@refs/pull/1/merge",
    },
    {
      ...INPUTS,
      workflowRef:
        "owner/repository/.github/workflows/rivet-review.lock.yml@refs/heads/../main",
    },
  ]) {
    assert.throws(() => createAuthorityReceipt(inputs));
  }
});
