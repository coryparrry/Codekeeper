import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  inspectRepairPatch,
  parseRepairRequest,
} from "../publish-repair/index.mjs";

const execFileAsync = promisify(execFile);
const API = "https://api.github.com";
const FULL_SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`Rivet repair validation: ${message}`);
}

async function githubJson(pathname, token, fetchImpl) {
  const response = await fetchImpl(`${API}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) fail(`GitHub API request failed (${response.status})`);
  return response.json();
}

async function run(command, args, options = {}) {
  try {
    const { stdout = "" } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout,
    });
    return stdout.trim();
  } catch (cause) {
    const detail = String(
      cause?.stderr || cause?.stdout || cause?.message || "command failed",
    ).trim();
    fail(`${options.label ?? command} failed${detail ? `: ${detail}` : ""}`);
  }
}

function validationCommands(env) {
  try {
    const commands = JSON.parse(
      Buffer.from(
        env.RIVET_VALIDATION_COMMANDS_BASE64 ?? "",
        "base64",
      ).toString("utf8"),
    );
    if (
      !Array.isArray(commands) ||
      commands.length < 1 ||
      commands.length > 10 ||
      commands.some(
        (command) =>
          typeof command !== "string" ||
          command.length < 1 ||
          command.length > 256 ||
          /[\0\r\n`]/.test(command),
      )
    ) {
      fail("invalid validation command configuration");
    }
    return commands;
  } catch (cause) {
    if (cause?.message?.startsWith("Rivet repair validation:")) throw cause;
    fail("invalid validation command configuration");
  }
}

function gitAuthEnvironment(token, env) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export async function runValidateRepairAction({
  env = process.env,
  fetchImpl = fetch,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  runImpl = run,
} = {}) {
  const event = JSON.parse(await readFileImpl(env.GITHUB_EVENT_PATH, "utf8"));
  const agentOutput = JSON.parse(
    await readFileImpl(env.GH_AW_AGENT_OUTPUT, "utf8"),
  );
  const request = parseRepairRequest({
    event,
    agentOutput,
    outputType: "validate_repair",
  });
  const proposedPaths = inspectRepairPatch(request.patch);
  const pull = await githubJson(
    `/repos/${request.repository}/pulls/${request.pullRequest}`,
    env.GITHUB_TOKEN,
    fetchImpl,
  );
  if (
    pull?.head?.repo?.full_name !== request.repository ||
    !FULL_SHA.test(pull?.head?.sha ?? "") ||
    typeof pull?.head?.ref !== "string"
  ) {
    fail("repair requires a same-repository pull request");
  }
  const cwd = env.GITHUB_WORKSPACE;
  await runImpl("git", ["check-ref-format", "--branch", pull.head.ref], {
    cwd,
    env,
  });
  await runImpl("git", ["fetch", "--no-tags", "origin", pull.head.sha], {
    cwd,
    env: gitAuthEnvironment(env.GITHUB_TOKEN, env),
    label: "fetch reviewed head",
  });
  await runImpl("git", ["checkout", "--detach", pull.head.sha], { cwd, env });
  const proposedPatchPath = path.join(
    env.RUNNER_TEMP,
    "rivet-proposed-repair.patch",
  );
  await writeFileImpl(proposedPatchPath, request.patch, { mode: 0o600 });
  await runImpl(
    "git",
    ["apply", "--check", "--whitespace=error-all", proposedPatchPath],
    { cwd, env },
  );
  await runImpl("git", ["apply", "--whitespace=error-all", proposedPatchPath], {
    cwd,
    env,
  });
  const canonicalPatch = await runImpl(
    "git",
    ["diff", "--binary", "--full-index", "--no-ext-diff"],
    { cwd, env },
  );
  const changedPaths = (
    await runImpl("git", ["diff", "--name-only", "-z"], { cwd, env })
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  if (
    JSON.stringify(changedPaths) !== JSON.stringify([...proposedPaths].sort())
  ) {
    fail("applied files do not match the proposed patch");
  }

  const validation = [];
  for (const command of validationCommands(env)) {
    await runImpl("/bin/sh", ["-c", command], {
      cwd,
      env,
      timeout: 10 * 60 * 1000,
      label: `validation command ${command}`,
    });
    validation.push({ command, exitCode: 0 });
  }
  const finalPatch = await runImpl(
    "git",
    ["diff", "--binary", "--full-index", "--no-ext-diff"],
    { cwd, env },
  );
  const untracked = await runImpl(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd, env },
  );
  if (finalPatch !== canonicalPatch || untracked) {
    fail("validation changed the proposed repair workspace");
  }
  const live = await githubJson(
    `/repos/${request.repository}/pulls/${request.pullRequest}`,
    env.GITHUB_TOKEN,
    fetchImpl,
  );
  if (live?.head?.sha !== pull.head.sha || live?.head?.ref !== pull.head.ref) {
    fail("pull request head changed during validation");
  }

  const artifactRoot = path.join(env.RUNNER_TEMP, "rivet-repair");
  await mkdirImpl(artifactRoot, { recursive: true, mode: 0o700 });
  await writeFileImpl(path.join(artifactRoot, "patch.diff"), canonicalPatch, {
    mode: 0o600,
  });
  const receipt = {
    schemaVersion: 1,
    repository: request.repository,
    pullRequest: request.pullRequest,
    authorization: request.authorization,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    changedPaths,
    patchSha256: createHash("sha256").update(canonicalPatch).digest("hex"),
    validation,
  };
  await writeFileImpl(
    path.join(artifactRoot, "receipt.json"),
    `${JSON.stringify(receipt)}\n`,
    { mode: 0o600 },
  );
  return Object.freeze(receipt);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runValidateRepairAction().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
