import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  compileGhAwWorkflow,
  validateGhAwWorkflow,
} from "../src/gh-aw/compile.mjs";

function successReport({ compiled = true } = {}) {
  return JSON.stringify([
    {
      workflow: "rivet-review.md",
      valid: true,
      errors: [],
      warnings: [],
      ...(compiled
        ? {
            compiled_file:
              "/repository/.github/workflows/rivet-review.lock.yml",
          }
        : {}),
    },
  ]);
}

test("compiles one workflow through strict action mode", async () => {
  const calls = [];
  const result = await compileGhAwWorkflow({
    repositoryRoot: "/repository",
    workflowId: "rivet-review",
    binaryPath: "/cache/gh-aw",
    approveNewDependencies: true,
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: successReport(), stderr: "compiler warning" };
    },
  });
  assert.equal(
    result.compiledFile,
    path.join("/repository", ".github", "workflows", "rivet-review.lock.yml"),
  );
  assert.equal(result.stderr, "compiler warning");
  assert.deepEqual(calls, [
    [
      "/cache/gh-aw",
      [
        "compile",
        "rivet-review",
        "--strict",
        "--json",
        "--no-check-update",
        "--action-mode",
        "action",
        "--approve",
      ],
      {
        cwd: "/repository",
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ],
  ]);
});

test("validates one workflow with machine-readable strict output", async () => {
  const calls = [];
  const result = await validateGhAwWorkflow({
    repositoryRoot: "/repository",
    workflowId: "rivet-review",
    binaryPath: "/cache/gh-aw",
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: successReport({ compiled: false }), stderr: "" };
    },
  });
  assert.equal(result.report.valid, true);
  assert.deepEqual(calls[0][1], [
    "validate",
    "rivet-review",
    "--strict",
    "--json",
    "--no-check-update",
  ]);
});

test("rejects invalid workflow ids and compiler reports", async () => {
  await assert.rejects(
    compileGhAwWorkflow({
      repositoryRoot: "/repository",
      workflowId: "../other",
      binaryPath: "/cache/gh-aw",
    }),
    /invalid workflow id/,
  );
  await assert.rejects(
    validateGhAwWorkflow({
      repositoryRoot: "/repository",
      workflowId: "rivet-review",
      binaryPath: "/cache/gh-aw",
      execFileImpl: async () => ({ stdout: "not json", stderr: "" }),
    }),
    /validate returned invalid JSON/,
  );
  await assert.rejects(
    validateGhAwWorkflow({
      repositoryRoot: "/repository",
      workflowId: "rivet-review",
      binaryPath: "/cache/gh-aw",
      execFileImpl: async () => ({
        stdout: JSON.stringify([
          { workflow: "rivet-review.md", valid: false, errors: ["failure"] },
        ]),
        stderr: "",
      }),
    }),
    /validate did not validate the workflow/,
  );
});
