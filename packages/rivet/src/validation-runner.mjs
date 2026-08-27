import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function fail(message, receipt) {
  const error = new Error(`Rivet repair validation: ${message}`);
  if (receipt) error.receipt = receipt;
  throw error;
}

export function normalizeValidationCommands(commands) {
  if (
    !Array.isArray(commands) ||
    commands.length < 1 ||
    commands.length > 10 ||
    commands.some(
      (command) =>
        typeof command !== "string" ||
        command.trim().length < 1 ||
        command.length > 256 ||
        /[\0\r\n`]/.test(command),
    )
  ) {
    fail("requires 1 to 10 bounded validation commands");
  }
  const normalized = commands.map((command) => command.trim());
  if (new Set(normalized).size !== normalized.length) {
    fail("commands must be unique");
  }
  return Object.freeze(normalized);
}

async function executeValidationCommand(command, { cwd, timeoutMs }) {
  try {
    await execFileAsync("/bin/sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { exitCode: 0, timedOut: false };
  } catch (error) {
    return {
      exitCode: Number.isSafeInteger(error?.code) ? error.code : 1,
      timedOut: error?.killed === true,
    };
  }
}

function receipt(commands, passed) {
  return Object.freeze({
    passed,
    commands: Object.freeze(commands.map((command) => Object.freeze(command))),
  });
}

export async function runRepairValidation({
  commands,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execute = executeValidationCommand,
}) {
  const validated = normalizeValidationCommands(commands);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail("timeout must be a positive integer");
  }
  const results = [];
  for (const command of validated) {
    const result = await execute(command, { cwd, timeoutMs });
    if (
      !result ||
      !Number.isSafeInteger(result.exitCode) ||
      result.exitCode < 0 ||
      result.exitCode > 255 ||
      typeof result.timedOut !== "boolean"
    ) {
      fail("runner returned an invalid result");
    }
    const exitCode = result.timedOut ? 124 : result.exitCode;
    results.push({ command, exitCode });
    if (result.timedOut || result.exitCode !== 0) {
      fail(
        result.timedOut
          ? `command timed out: ${command}`
          : `command failed: ${command}`,
        receipt(results, false),
      );
    }
  }
  return receipt(results, true);
}
