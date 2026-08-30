import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  compileGhAwWorkflow,
  validateGhAwWorkflow,
} from "../src/gh-aw/compile.mjs";
import { GH_AW_UPGRADE_EXPERIMENT } from "../src/gh-aw/versions.mjs";

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
        "--action-tag",
        "6aab9e5b5c91c615506061f09bedd81a23babe3c",
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

test("compiles an upgrade candidate with its matching action commit", async () => {
  let invocation;
  await compileGhAwWorkflow({
    repositoryRoot: "/repo",
    workflowId: "rivet-review",
    binaryPath: "/cache/gh-aw-0.86.3",
    release: GH_AW_UPGRADE_EXPERIMENT,
    execFileImpl: async (binaryPath, args) => {
      invocation = { binaryPath, args };
      return {
        stdout: JSON.stringify([
          {
            valid: true,
            errors: [],
            compiled_file: "/repo/.github/workflows/rivet-review.lock.yml",
          },
        ]),
        stderr: "",
      };
    },
  });

  assert.equal(invocation.binaryPath, "/cache/gh-aw-0.86.3");
  assert.deepEqual(invocation.args.slice(-2), [
    "--action-tag",
    GH_AW_UPGRADE_EXPERIMENT.actionsCommit,
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

test("runs the pinned compiler with the supplied sanitized environment", async () => {
  const env = { PATH: "/usr/bin", GH_HOST: "github.com" };
  let commandOptions;
  await validateGhAwWorkflow({
    repositoryRoot: "/repository",
    workflowId: "rivet-review",
    binaryPath: "/cache/gh-aw",
    env,
    execFileImpl: async (_binary, _args, options) => {
      commandOptions = options;
      return { stdout: successReport({ compiled: false }), stderr: "" };
    },
  });

  assert.equal(commandOptions.env, env);
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
