import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ensureGhAwBinary } from "./binary.mjs";
import { GH_AW_RELEASE } from "./versions.mjs";

const execFileAsync = promisify(execFile);
const WORKFLOW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message, options) {
  throw new Error(`Rivet gh-aw compiler: ${message}`, options);
}

function parseReport(stdout, operation) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (cause) {
    fail(`${operation} returned invalid JSON`, { cause });
  }
  if (!Array.isArray(report) || report.length !== 1) {
    fail(`${operation} returned an unexpected report`);
  }
  const [result] = report;
  if (
    !result ||
    result.valid !== true ||
    !Array.isArray(result.errors) ||
    result.errors.length !== 0
  ) {
    fail(`${operation} did not validate the workflow`);
  }
  return result;
}

async function runGhAw({
  binaryPath,
  repositoryRoot,
  args,
  operation,
  execFileImpl,
}) {
  try {
    const { stdout, stderr } = await execFileImpl(binaryPath, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { result: parseReport(stdout, operation), stderr };
  } catch (cause) {
    if (cause?.message?.startsWith("Rivet gh-aw compiler:")) throw cause;
    const detail = String(
      cause?.stderr || cause?.stdout || cause?.message || "command failed",
    ).trim();
    fail(`${operation} failed: ${detail}`, { cause });
  }
}

function workflowInput(workflowId) {
  if (!WORKFLOW_ID.test(workflowId)) fail(`invalid workflow id ${workflowId}`);
  return workflowId;
}

export async function compileGhAwWorkflow({
  repositoryRoot,
  workflowId,
  binaryPath,
  release = GH_AW_RELEASE,
  approveNewDependencies = false,
  execFileImpl = execFileAsync,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const id = workflowInput(workflowId);
  const compiler = binaryPath ?? (await ensureGhAwBinary({ release }));
  const args = [
    "compile",
    id,
    "--strict",
    "--json",
    "--no-check-update",
    "--action-mode",
    "action",
    "--action-tag",
    release.actionsCommit,
  ];
  if (approveNewDependencies) args.push("--approve");
  const output = await runGhAw({
    binaryPath: compiler,
    repositoryRoot: root,
    args,
    operation: "compile",
    execFileImpl,
  });
  const compiledFile = path.resolve(output.result.compiled_file ?? "");
  const expectedFile = path.join(
    root,
    ".github",
    "workflows",
    `${id}.lock.yml`,
  );
  if (compiledFile !== expectedFile)
    fail("compile returned an unexpected output path");
  return Object.freeze({
    compiledFile,
    report: output.result,
    stderr: output.stderr,
  });
}

export async function validateGhAwWorkflow({
  repositoryRoot,
  workflowId,
  binaryPath,
  execFileImpl = execFileAsync,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const id = workflowInput(workflowId);
  const compiler = binaryPath ?? (await ensureGhAwBinary());
  const output = await runGhAw({
    binaryPath: compiler,
    repositoryRoot: root,
    args: ["validate", id, "--strict", "--json", "--no-check-update"],
    operation: "validate",
    execFileImpl,
  });
  return Object.freeze({ report: output.result, stderr: output.stderr });
}
