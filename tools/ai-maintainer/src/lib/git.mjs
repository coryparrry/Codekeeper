import { spawn, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export async function collectWorkingTreeChanges(cwd = process.cwd()) {
  const trackedTokens = splitNul(
    git(["diff", "--name-status", "-z", "HEAD"], { cwd, encoding: null }).stdout
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
    git(["diff", "--raw", "-z", "HEAD"], { cwd, encoding: null }).stdout
  );
  const rawByPath = new Map();
  for (let index = 0; index < rawTokens.length;) {
    const metadata = rawTokens[index++];
    const match = metadata?.match(/^:(\d{6}) (\d{6}) \S+ \S+ ([A-Z][0-9]*)$/);
    const oldPath = rawTokens[index++];
    const renamedOrCopied = match?.[3]?.startsWith("R") || match?.[3]?.startsWith("C");
    const filePath = renamedOrCopied ? rawTokens[index++] : oldPath;
    if (!match || !filePath) throw new Error("Could not parse git diff --raw output");
    const oldMode = match[1];
    const newMode = match[2];
    const activeMode = newMode === "000000" ? oldMode : newMode;
    rawByPath.set(filePath, {
      oldMode,
      newMode,
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
    git(["diff", "--numstat", "-z", "HEAD"], { cwd, encoding: null }).stdout
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
    const stat = await lstat(absolute);
    const item = byPath.get(filePath);
    if (stat.isSymbolicLink()) {
      item.symlink = true;
      item.specialMode = true;
      item.oldMode = "000000";
      item.newMode = "120000";
      item.modeChanged = false;
      item.additions = 0;
      item.deletions = 0;
      continue;
    }
    if (!stat.isFile()) {
      item.specialMode = true;
      item.additions = 0;
      item.deletions = 0;
      continue;
    }
    item.oldMode = "000000";
    item.newMode = stat.mode & 0o111 ? "100755" : "100644";
    item.modeChanged = false;
    item.specialMode = false;
    item.bytes = stat.size;
    const content = await readFile(absolute);
    item.binary = content.includes(0);
    item.additions = item.binary ? 0 : content.toString("utf8").split("\n").length;
    item.deletions = 0;
  }

  for (const item of byPath.values()) {
    if (item.bytes !== undefined) continue;
    try {
      const stat = await lstat(path.join(cwd, item.path));
      item.bytes = stat.isFile() ? stat.size : 0;
      if (stat.isSymbolicLink()) item.symlink = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      item.bytes = 0;
    }
  }

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

export async function createPatch(patchPath, cwd = process.cwd()) {
  const changes = await collectWorkingTreeChanges(cwd);
  const untracked = changes.files.filter((item) => item.untracked).map((item) => item.path);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-maintainer-index-"));
  const temporaryIndex = path.join(temporaryDirectory, "index");
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
    const patch = git(["diff", "--binary", "--full-index", "HEAD"], { cwd, env: environment, encoding: null }).stdout;
    await writeFile(patchPath, patch);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  const patch = await readFile(patchPath);
  return { ...changes, patchBytes: patch.length };
}

export function applyPatch(patchPath, cwd = process.cwd()) {
  git(["apply", "--whitespace=error-all", patchPath], { cwd });
}

export function runValidationCommands(commands, cwd = process.cwd()) {
  const environment = { ...process.env };
  for (const key of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_PAT",
    "OPENAI_API_KEY",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "ACTIONS_RESULTS_URL",
    "ACTIONS_CACHE_URL"
  ]) {
    delete environment[key];
  }
  const results = [];
  for (const command of commands) {
    const result = run("bash", ["-c", command], { cwd, allowFailure: true, env: environment, replaceEnv: true });
    results.push({
      command,
      success: result.status === 0,
      stdout: result.stdout.toString("utf8").slice(-12000),
      stderr: result.stderr.toString("utf8").slice(-12000)
    });
    if (result.status !== 0) {
      const error = new Error(`Validation command failed: ${command}`);
      error.validationResults = results;
      throw error;
    }
  }
  return results;
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

export function changedFilesBetween(base, head, cwd = process.cwd()) {
  const tokens = splitNul(
    git(["diff", "--name-only", "-z", `${base}...${head}`], { cwd, encoding: null }).stdout
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
    const child = spawn("git", ["diff", "--name-only", "-z", `${base}...${head}`], {
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
