import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { superviseProcess } from "./process-supervisor.mjs";

const MAX_CAPTURE_FILE_BYTES = 1024 * 1024;
const MAX_CAPTURE_PATCH_BYTES = 5 * 1024 * 1024;
const CAPTURE_GIT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_VALIDATION_TIMEOUT_MS = 5 * 60 * 1000;
const VALIDATION_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "Path", "PATHEXT", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "CI",
  "SystemRoot", "ComSpec"
]);
export const VALIDATION_RECEIPT_FILE = "validation-receipt.json";
const SHA256 = /^[a-f0-9]{64}$/i;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactObject(value, name, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error(`${name} contains unexpected fields`);
  }
  return value;
}

export function createValidationReceipt({ candidateSha256, configSha256, patchSha256, baseSha, commands, patchUnchanged }) {
  return {
    version: 1,
    candidateSha256,
    configSha256,
    patchSha256,
    baseSha,
    commands: commands.map(({ command, exitCode, durationMs, stdoutDigest, startedAt }) => ({
      command,
      exitCode,
      durationMs,
      stdoutDigest,
      startedAt
    })),
    patchUnchanged
  };
}

export function assertValidationReceipt(receipt, { candidateSha256, configSha256, patchSha256, baseSha, commands }) {
  exactObject(
    receipt,
    "Validation receipt",
    ["version", "candidateSha256", "configSha256", "patchSha256", "baseSha", "commands", "patchUnchanged"]
  );
  if (receipt.version !== 1) throw new Error("Validation receipt version is unsupported");
  for (const [name, value] of Object.entries({ candidateSha256, configSha256, patchSha256 })) {
    if (!SHA256.test(String(value ?? "")) || receipt[name] !== value) {
      throw new Error(`Validation receipt ${name} is stale or invalid`);
    }
  }
  if (!GIT_SHA.test(String(baseSha ?? "")) || receipt.baseSha !== baseSha) {
    throw new Error("Validation receipt base SHA is stale or invalid");
  }
  if (receipt.patchUnchanged !== true) throw new Error("Validation receipt does not prove an unchanged patch");
  if (!Array.isArray(commands) || !Array.isArray(receipt.commands) || receipt.commands.length !== commands.length) {
    throw new Error("Validation receipt does not cover the configured validation commands exactly");
  }
  receipt.commands.forEach((item, index) => {
    exactObject(item, `Validation receipt command ${index}`, ["command", "exitCode", "durationMs", "stdoutDigest", "startedAt"]);
    if (item.command !== commands[index]) {
      throw new Error(`Validation receipt command ${index} is not the configured command`);
    }
    if (!Number.isSafeInteger(item.exitCode) || item.exitCode < 0 || item.exitCode !== 0) {
      throw new Error(`Validation receipt command ${index} did not pass`);
    }
    if (!Number.isSafeInteger(item.durationMs) || item.durationMs < 0) {
      throw new Error(`Validation receipt command ${index} has an invalid duration`);
    }
    if (!SHA256.test(item.stdoutDigest)) {
      throw new Error(`Validation receipt command ${index} has an invalid stdout digest`);
    }
    const startedAt = typeof item.startedAt === "string" ? Date.parse(item.startedAt) : Number.NaN;
    if (Number.isNaN(startedAt) || new Date(startedAt).toISOString() !== item.startedAt) {
      throw new Error(`Validation receipt command ${index} has an invalid start time`);
    }
  });
  return receipt;
}

export function assertCandidateValidationReceipt(
  receipt,
  { candidateSha256, configSha256, patchSha256, baseSha, config },
) {
  return assertValidationReceipt(receipt, {
    candidateSha256,
    configSha256,
    patchSha256,
    baseSha,
    commands: config?.audit?.repair?.validationCommands,
  });
}

function commandError(command, args, result) {
  const stderr = result.stderr?.toString("utf8").trim();
  const stdout = result.stdout?.toString("utf8").trim();
  return new Error(
    [`Command failed: ${command} ${args.join(" ")}`, stderr, stdout]
      .filter(Boolean)
      .join("\n")
  );
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.replaceEnv ? options.env : { ...process.env, ...(options.env ?? {}) },
    encoding: options.encoding ?? "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeoutMs,
    stdio: options.stdio ?? "pipe"
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw commandError(command, args, result);
  }
  return result;
}

export function git(args, options = {}) {
  return run("git", args, options);
}

export function gitText(args, options = {}) {
  return git(args, options).stdout.toString("utf8").trim();
}

export function currentHead(cwd = process.cwd()) {
  return gitText(["rev-parse", "HEAD"], { cwd });
}

export function ensureClean(cwd = process.cwd()) {
  const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  if (status) throw new Error(`Expected a clean worktree, found:\n${status}`);
}

function splitNul(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
}

export async function inspectUntrackedFile(absolute, maximumFileBytes) {
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_NOFOLLOW ?? 0)
    | (fsConstants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await open(absolute, flags);
  } catch (error) {
    if (error.code === "ELOOP") {
      return {
        symlink: true,
        specialMode: true,
        oldMode: "000000",
        newMode: "120000",
        modeChanged: false,
        bytes: 0,
        additions: 0,
        deletions: 0
      };
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { specialMode: true, bytes: 0, additions: 0, deletions: 0 };
    }
    const common = {
      oldMode: "000000",
      newMode: stat.mode & 0o111 ? "100755" : "100644",
      modeChanged: false,
      specialMode: false
    };
    if (stat.size > maximumFileBytes) {
      return {
        ...common,
        bytes: stat.size,
        captureSkipped: true,
        binary: false,
        additions: 0,
        deletions: 0
      };
    }
    const buffer = Buffer.alloc(maximumFileBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maximumFileBytes) {
      return {
        ...common,
        bytes: total,
        captureSkipped: true,
        binary: false,
        additions: 0,
        deletions: 0
      };
    }
    const content = buffer.subarray(0, total);
    const binary = content.includes(0);
    return {
      ...common,
      bytes: total,
      binary,
      additions: binary ? 0 : content.toString("utf8").split("\n").length,
      deletions: 0
    };
  } finally {
    await handle.close();
  }
}

export async function collectWorkingTreeChanges(
  cwd = process.cwd(),
  { maximumFileBytes = MAX_CAPTURE_FILE_BYTES } = {}
) {
  if (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes <= 0) {
    throw new Error("Workspace capture file limit must be a positive integer");
  }
  const trackedTokens = splitNul(
    git(["diff", "--no-ext-diff", "--name-status", "-z", "HEAD"], {
      cwd,
      encoding: null,
      timeoutMs: CAPTURE_GIT_TIMEOUT_MS
    }).stdout
  );
  const tracked = [];
  for (let index = 0; index < trackedTokens.length;) {
    const status = trackedTokens[index++];
    const oldPath = trackedTokens[index++];
    const renamedOrCopied = status?.startsWith("R") || status?.startsWith("C");
    const filePath = renamedOrCopied ? trackedTokens[index++] : oldPath;
    if (!status || !filePath) throw new Error("Could not parse git diff --name-status output");
    tracked.push({ status, path: filePath, ...(renamedOrCopied ? { sourcePath: oldPath } : {}) });
  }

  const untrackedPaths = splitNul(
    git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd, encoding: null }).stdout
  );
  const rawTokens = splitNul(
    git(["diff", "--no-ext-diff", "--raw", "--full-index", "-z", "HEAD"], {
      cwd,
      encoding: null,
      timeoutMs: CAPTURE_GIT_TIMEOUT_MS
    }).stdout
  );
  const rawByPath = new Map();
  for (let index = 0; index < rawTokens.length;) {
    const metadata = rawTokens[index++];
    const match = metadata?.match(/^:(\d{6}) (\d{6}) (\S+) \S+ ([A-Z][0-9]*)$/);
    const oldPath = rawTokens[index++];
    const renamedOrCopied = match?.[4]?.startsWith("R") || match?.[4]?.startsWith("C");
    const filePath = renamedOrCopied ? rawTokens[index++] : oldPath;
    if (!match || !filePath) throw new Error("Could not parse git diff --raw output");
    const oldMode = match[1];
    const newMode = match[2];
    const activeMode = newMode === "000000" ? oldMode : newMode;
    rawByPath.set(filePath, {
      oldMode,
      newMode,
      oldObject: match[3],
      modeChanged: oldMode !== "000000" && newMode !== "000000" && oldMode !== newMode,
      specialMode: !["100644", "100755"].includes(activeMode)
    });
  }

  const byPath = new Map();
  for (const item of tracked) {
    byPath.set(item.path, { ...item, ...(rawByPath.get(item.path) ?? {}), untracked: false });
  }
  for (const filePath of untrackedPaths) {
    if (!byPath.has(filePath)) byPath.set(filePath, { status: "A", path: filePath, untracked: true });
  }

  const numstatTokens = splitNul(
    git(["diff", "--no-ext-diff", "--numstat", "-z", "HEAD"], {
      cwd,
      encoding: null,
      timeoutMs: CAPTURE_GIT_TIMEOUT_MS
    }).stdout
  );
  for (let index = 0; index < numstatTokens.length; index += 1) {
    const token = numstatTokens[index];
    const firstTab = token.indexOf("\t");
    const secondTab = token.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const additionsRaw = token.slice(0, firstTab);
    const deletionsRaw = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);
    if (filePath === "") {
      index += 2;
      filePath = numstatTokens[index];
    }
    const item = byPath.get(filePath);
    if (!item) continue;
    item.binary = additionsRaw === "-" || deletionsRaw === "-";
    item.additions = item.binary ? 0 : Number(additionsRaw);
    item.deletions = item.binary ? 0 : Number(deletionsRaw);
  }

  for (const filePath of untrackedPaths) {
    const absolute = path.join(cwd, filePath);
    const item = byPath.get(filePath);
    Object.assign(item, await inspectUntrackedFile(absolute, maximumFileBytes));
  }

  for (const item of byPath.values()) {
    if (item.bytes !== undefined) continue;
    try {
      const stat = await lstat(path.join(cwd, item.path));
      item.bytes = stat.isFile() ? stat.size : 0;
      if (stat.isSymbolicLink()) item.symlink = true;
      if (stat.isFile() && stat.size > maximumFileBytes) {
        item.captureSkipped = true;
        item.binary = false;
        item.additions = 0;
        item.deletions = 0;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      item.bytes = 0;
    }
  }

  const oldObjects = [
    ...new Set(
      [...byPath.values()]
        .map((item) => item.oldObject)
        .filter((object) => object && !/^0+$/.test(object))
    )
  ];
  if (oldObjects.length > 0) {
    const oldSizes = git(["cat-file", "--batch-check=%(objectsize)"], {
      cwd,
      input: `${oldObjects.join("\n")}\n`,
      timeoutMs: CAPTURE_GIT_TIMEOUT_MS
    }).stdout.trim().split("\n");
    if (oldSizes.length !== oldObjects.length || oldSizes.some((size) => !/^\d+$/.test(size))) {
      throw new Error("Could not determine pre-change blob sizes");
    }
    const sizeByObject = new Map(
      oldObjects.map((object, index) => [object, Number(oldSizes[index])])
    );
    for (const item of byPath.values()) {
      if (sizeByObject.get(item.oldObject) > maximumFileBytes) {
        item.captureSkipped = true;
        item.binary = false;
        item.additions = 0;
        item.deletions = 0;
      }
    }
  }
  for (const item of byPath.values()) delete item.oldObject;

  const files = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  const additions = files.reduce((sum, item) => sum + (item.additions ?? 0), 0);
  const deletions = files.reduce((sum, item) => sum + (item.deletions ?? 0), 0);
  return {
    files,
    additions,
    deletions,
    changedLines: additions + deletions,
    changedBytes: files.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
  };
}

export async function createPatch(
  patchPath,
  cwd = process.cwd(),
  {
    maximumFileBytes = MAX_CAPTURE_FILE_BYTES,
    maximumPatchBytes = MAX_CAPTURE_PATCH_BYTES
  } = {}
) {
  if (!Number.isSafeInteger(maximumPatchBytes) || maximumPatchBytes <= 0) {
    throw new Error("Workspace capture patch limit must be a positive integer");
  }
  const changes = await collectWorkingTreeChanges(cwd, { maximumFileBytes });
  const untracked = changes.files.filter((item) => item.untracked).map((item) => item.path);
  if (changes.files.some((item) => item.captureSkipped)) {
    await writeFile(patchPath, Buffer.alloc(0));
    return { ...changes, patchBytes: 0, captureSkipped: true };
  }
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-index-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
  let patchBytes = 0;
  let captureSkipped = false;
  try {
    const indexPath = gitText(["rev-parse", "--git-path", "index"], { cwd });
    try {
      await copyFile(path.resolve(cwd, indexPath), temporaryIndex);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      git(["read-tree", "HEAD"], { cwd, env: { GIT_INDEX_FILE: temporaryIndex } });
    }
    const environment = { GIT_INDEX_FILE: temporaryIndex };
    if (untracked.length > 0) git(["add", "-N", "--", ...untracked], { cwd, env: environment });
    try {
      const patch = git(["diff", "--no-ext-diff", "--binary", "--full-index", "HEAD"], {
        cwd,
        env: environment,
        encoding: null,
        maxBuffer: maximumPatchBytes + 1,
        timeoutMs: CAPTURE_GIT_TIMEOUT_MS
      }).stdout;
      patchBytes = patch.length;
      await writeFile(patchPath, patch);
    } catch (error) {
      if (error.code !== "ENOBUFS") throw error;
      patchBytes = maximumPatchBytes + 1;
      captureSkipped = true;
      await writeFile(patchPath, Buffer.alloc(0));
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return { ...changes, patchBytes, captureSkipped };
}

export function applyPatch(patchPath, cwd = process.cwd()) {
  git(["apply", "--whitespace=error-all", patchPath], { cwd });
}

async function verifiedRustupHome(environment) {
  const candidate = typeof environment.RUSTUP_HOME === "string" ? environment.RUSTUP_HOME.trim() : "";
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    const details = await lstat(candidate);
    if (!details.isDirectory() || details.isSymbolicLink()) return null;
    return realpath(candidate);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

export async function validationEnvironment(environment = process.env) {
  const sanitized = Object.fromEntries(VALIDATION_ENVIRONMENT_KEYS
    .filter((key) => typeof environment[key] === "string")
    .map((key) => [key, environment[key]]));
  const rustupHome = await verifiedRustupHome(environment);
  if (rustupHome) sanitized.RUSTUP_HOME = rustupHome;
  return sanitized;
}

export async function runValidationCommands(
  commands,
  cwd = process.cwd(),
  { timeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS, sanitized = false } = {}
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Validation timeout must be a positive integer");
  }
  const environment = await validationEnvironment();
  const home = await mkdtemp(path.join(os.tmpdir(), "codekeeper-validation-home-"));
  environment.HOME = home;
  try {
    const results = [];
    for (const command of commands) {
      let result;
      const startedMilliseconds = Date.now();
      const startedAt = new Date(startedMilliseconds).toISOString();
      try {
        result = await superviseProcess("bash", ["-c", command], { cwd, environment, timeoutMs });
      } catch (error) {
        const failure = new Error(`Validation command could not run: ${command}: ${error.message}`);
        failure.validationResults = results;
        throw failure;
      }
      if (result.timedOut) {
        const failure = new Error(`Validation command timed out after ${timeoutMs}ms: ${command}`);
        failure.validationResults = results;
        throw failure;
      }
      const stdout = result.stdout.toString("utf8");
      const stderr = result.stderr.toString("utf8");
      const commandResult = {
        command,
        success: result.status === 0,
        exitCode: result.status,
        durationMs: Math.max(0, Date.now() - startedMilliseconds),
        stdoutDigest: sha256(result.stdout),
        startedAt,
        stdout,
        stderr
      };
      const exposedResult = sanitized
        ? {
            command: commandResult.command,
            success: commandResult.success,
            exitCode: commandResult.exitCode,
            durationMs: commandResult.durationMs,
            stdoutDigest: commandResult.stdoutDigest,
            startedAt: commandResult.startedAt
          }
        : commandResult;
      results.push({
        ...exposedResult
      });
      if (result.status !== 0) {
        const error = new Error(`Validation command failed: ${command}`);
        error.validationResults = results;
        throw error;
      }
    }
    return results;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export function configureAutomationIdentity({ login, id, cwd = process.cwd() } = {}) {
  const normalizedLogin = String(login ?? "").trim();
  const normalizedId = String(id ?? "").trim();
  if (!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(normalizedLogin)) {
    throw new Error(`Invalid automation bot login: ${normalizedLogin || "missing"}`);
  }
  if (!/^[1-9][0-9]*$/.test(normalizedId)) {
    throw new Error(`Invalid automation bot id: ${normalizedId || "missing"}`);
  }
  const botLogin = normalizedLogin.endsWith("[bot]") ? normalizedLogin : `${normalizedLogin}[bot]`;
  git(["config", "user.name", botLogin], { cwd });
  git(["config", "user.email", `${normalizedId}+${botLogin}@users.noreply.github.com`], { cwd });
}

export function createBranchAndCommit({ branch, message, cwd = process.cwd() }) {
  git(["checkout", "-b", branch], { cwd });
  git(["add", "--all"], { cwd });
  const staged = gitText(["diff", "--cached", "--name-only"], { cwd });
  if (!staged) throw new Error("Patch produced no staged changes");
  git(["commit", "-m", message], { cwd });
  return currentHead(cwd);
}

export function createCommitOnCurrentHead({ expectedParent, message, paths, cwd = process.cwd() }) {
  if (!/^[0-9a-f]{40}$/i.test(String(expectedParent ?? ""))) {
    throw new Error("An exact parent commit SHA is required");
  }
  if (currentHead(cwd) !== expectedParent) {
    throw new Error(`Checkout HEAD moved from ${expectedParent} to ${currentHead(cwd)}`);
  }
  const stagePaths = [...new Set(paths ?? [])];
  if (stagePaths.length === 0 || stagePaths.some((file) => typeof file !== "string" || file.length === 0)) {
    throw new Error("At least one validated path is required to create a repair commit");
  }
  git(["add", "--all", "--", ...stagePaths], { cwd });
  const staged = splitNul(git(["diff", "--cached", "--name-only", "-z"], { cwd, encoding: null }).stdout);
  if (staged.length === 0) throw new Error("Patch produced no staged changes");
  const unstaged = splitNul(git(["diff", "--name-only", "-z"], { cwd, encoding: null }).stdout);
  const untracked = splitNul(git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd, encoding: null }).stdout);
  if (unstaged.length > 0 || untracked.length > 0) {
    throw new Error(`Repair commit left unvalidated worktree changes: ${[...unstaged, ...untracked].join(", ")}`);
  }
  git(["commit", "-m", message], { cwd });
  const commit = currentHead(cwd);
  const ancestry = gitText(["rev-list", "--parents", "-n", "1", commit], { cwd }).split(/\s+/);
  if (ancestry.length !== 2 || ancestry[1] !== expectedParent) {
    throw new Error(`Repair commit ${commit} is not a single commit atop ${expectedParent}`);
  }
  return commit;
}

export function pushBranch(branch, token, cwd = process.cwd()) {
  if (!token) throw new Error("A GitHub token is required to push the automation branch");
  const origin = gitText(["remote", "get-url", "origin"], { cwd });
  let endpoint;
  try {
    endpoint = new URL(origin);
  } catch {
    throw new Error(`Automation publication requires an HTTPS origin, found: ${origin}`);
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(`Automation publication requires an HTTPS origin, found: ${origin}`);
  }
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  git(["push", "--set-upstream", "origin", branch], {
    cwd,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${endpoint.origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
      GIT_TERMINAL_PROMPT: "0"
    }
  });
}

export function pushHeadToBranch(branch, token, cwd = process.cwd()) {
  if (!token) throw new Error("A GitHub token is required to update the pull request branch");
  git(["check-ref-format", "--branch", branch], { cwd });
  const origin = gitText(["remote", "get-url", "origin"], { cwd });
  let endpoint;
  try {
    endpoint = new URL(origin);
  } catch {
    throw new Error(`Pull request repair requires an HTTPS origin, found: ${origin}`);
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(`Pull request repair requires an HTTPS origin, found: ${origin}`);
  }
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  git(["push", "--porcelain", "--no-force", "origin", `HEAD:refs/heads/${branch}`], {
    cwd,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${endpoint.origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
      GIT_TERMINAL_PROMPT: "0"
    }
  });
  return currentHead(cwd);
}

export function changedFilesBetween(base, head, cwd = process.cwd()) {
  const tokens = splitNul(
    git(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], { cwd, encoding: null }).stdout
  );
  return tokens;
}

export function boundedDiffBetween(base, head, maximumBytes, cwd = process.cwd()) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("maximumBytes must be a positive integer");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "diff", "--no-ext-diff", "--no-renames", `${base}...${head}`
    ], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let includedBytes = 0;
    let bytes = 0;
    let stderr = "";
    let truncated = false;
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      if (truncated) return;
      bytes += chunk.length;
      const remaining = maximumBytes - includedBytes;
      if (remaining > 0) {
        // Copy instead of retaining a subarray backed by the complete stream
        // chunk: maximumBytes is a true in-memory capture bound.
        const selected = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(selected);
        includedBytes += selected.length;
      }
      if (chunk.length > remaining) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.once("error", (error) => {
      if (!truncated) settle(error);
    });
    child.once("close", (code) => {
      if (truncated) {
        settle(null, {
          patch: Buffer.concat(chunks).toString("utf8"),
          bytes,
          bytesExact: false,
          includedBytes,
          truncated: true
        });
        return;
      }
      if (code !== 0) {
        settle(new Error(`git diff failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      const patch = Buffer.concat(chunks);
      settle(null, {
        patch: patch.toString("utf8"),
        bytes,
        bytesExact: true,
        includedBytes,
        truncated: false
      });
    });
  });
}

export function boundedChangedFilesBetween(base, head, maximumFiles, cwd = process.cwd()) {
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles <= 0) {
    throw new Error("maximumFiles must be a positive integer");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const files = [];
    let pending = Buffer.alloc(0);
    let exceeded = false;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (exceeded) return;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let delimiter;
      while ((delimiter = pending.indexOf(0)) !== -1) {
        const file = pending.subarray(0, delimiter).toString("utf8");
        pending = pending.subarray(delimiter + 1);
        if (!file) continue;
        files.push(file);
        if (files.length > maximumFiles) {
          exceeded = true;
          child.kill();
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (exceeded) {
        reject(new Error(`Review changed-file context exceeds configured maximum of ${maximumFiles} files`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`git diff --name-only failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      if (pending.length !== 0) {
        reject(new Error("Could not parse git diff --name-only output"));
        return;
      }
      resolve(files);
    });
  });
}

export function boundedChangedFileStatsBetween(base, head, maximumFiles, cwd = process.cwd()) {
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles <= 0) {
    throw new Error("maximumFiles must be a positive integer");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", `${base}...${head}`], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const files = [];
    let additions = 0;
    let deletions = 0;
    let largestFileChangedLines = 0;
    let pending = Buffer.alloc(0);
    let exceeded = false;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (exceeded) return;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let delimiter;
      while ((delimiter = pending.indexOf(0)) !== -1) {
        const token = pending.subarray(0, delimiter).toString("utf8");
        pending = pending.subarray(delimiter + 1);
        if (!token) continue;
        const firstTab = token.indexOf("\t");
        const secondTab = token.indexOf("\t", firstTab + 1);
        if (firstTab === -1 || secondTab === -1 || secondTab === token.length - 1) {
          child.kill();
          reject(new Error("Could not parse git diff --numstat output"));
          return;
        }
        const additionsRaw = token.slice(0, firstTab);
        const deletionsRaw = token.slice(firstTab + 1, secondTab);
        const fileAdditions = additionsRaw === "-" ? 0 : Number(additionsRaw);
        const fileDeletions = deletionsRaw === "-" ? 0 : Number(deletionsRaw);
        if (!Number.isSafeInteger(fileAdditions) || !Number.isSafeInteger(fileDeletions)) {
          child.kill();
          reject(new Error("Could not parse git diff --numstat counts"));
          return;
        }
        const changedLines = fileAdditions + fileDeletions;
        files.push({
          path: token.slice(secondTab + 1),
          additions: fileAdditions,
          deletions: fileDeletions,
          binary: additionsRaw === "-" || deletionsRaw === "-"
        });
        additions += fileAdditions;
        deletions += fileDeletions;
        largestFileChangedLines = Math.max(largestFileChangedLines, changedLines);
        if (files.length > maximumFiles) {
          exceeded = true;
          child.kill();
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (exceeded) {
        reject(new Error(`Review changed-file context exceeds configured maximum of ${maximumFiles} files`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`git diff --numstat failed with exit code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      if (pending.length !== 0) {
        reject(new Error("Could not parse git diff --numstat output"));
        return;
      }
      resolve({
        files,
        additions,
        deletions,
        changedLines: additions + deletions,
        largestFileChangedLines
      });
    });
  });
}

// A review may cite only a line that exists in the current side of a changed
// hunk. Deletions intentionally have no eligible line: reviewers can describe
// them at file scope instead of attaching stale coordinates.
export function changedLineHunksBetween(base, head, paths, cwd = process.cwd()) {
  if (!Array.isArray(paths) || paths.length === 0) return new Map();
  const source = git([
    "diff", "--no-ext-diff", "--no-renames", "--unified=0", `${base}...${head}`,
    "--", ...paths
  ], { cwd }).stdout;
  const hunks = new Map();
  let currentPath = null;
  for (const line of source.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      continue;
    }
    if (line === "+++ /dev/null") {
      currentPath = null;
      continue;
    }
    if (!currentPath || !line.startsWith("@@")) continue;
    const match = line.match(/\+(\d+)(?:,(\d+))?\s@@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;
    const ranges = hunks.get(currentPath) ?? [];
    ranges.push({ start, end: start + count - 1 });
    hunks.set(currentPath, ranges);
  }
  return hunks;
}
