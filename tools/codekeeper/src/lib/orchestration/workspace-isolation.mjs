import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  lstat,
  rm,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertRunnerOwnedDirectory } from "../workspace.mjs";

const exec = promisify(execFile);
const INSTRUCTION_SURFACES = [".agents/skills", ".codex/skills"];
const INSTRUCTION_ROOTS = [".agents", ".codex"];

function required(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value;
}

async function regular(pathname, name) {
  const information = await lstat(pathname);
  if (!information.isFile() || information.isSymbolicLink())
    throw new Error(`${name} must be a regular file`);
  return pathname;
}

async function absent(pathname, name) {
  try {
    await lstat(pathname);
    throw new Error(`${name} already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function ancestorDirectories(pathname) {
  if (
    typeof pathname !== "string" ||
    !pathname.trim() ||
    pathname.includes("\0")
  ) {
    throw new Error("pathname is invalid");
  }
  const resolved = path.resolve(pathname);
  const root = path.parse(resolved).root;
  const ancestors = [];
  let current = path.dirname(resolved);
  while (current !== root) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

async function grantWorldTraverse(pathnames) {
  const seen = new Set();
  for (const pathname of pathnames.filter(Boolean)) {
    for (const ancestor of ancestorDirectories(pathname)) {
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      await exec("sudo", ["chmod", "a+x,go-w", ancestor]);
    }
  }
}

export async function prepareTrustedConfig({
  source,
  destination,
  expectedBranch,
}) {
  await regular(source, "Source config");
  await absent(destination, "Frozen config");
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const config = JSON.parse(await readFile(destination, "utf8"));
  if (config.repository?.defaultBranch !== expectedBranch) {
    throw new Error(
      "Configured default branch does not match the repository default branch",
    );
  }
  return config;
}

function paths({ codexHome, quarantine, workspaceTemp }) {
  return {
    codexHome: required(codexHome, "CODEX_HOME"),
    quarantine: required(quarantine, "QUARANTINE"),
    workspaceTemp:
      workspaceTemp ??
      path.join(path.dirname(codexHome), "codekeeper-workspace-tmp"),
  };
}

async function writeCodexConfig(codexHome, repositoryPath) {
  await writeFile(
    path.join(codexHome, ".gitconfig"),
    `[safe]\n\tdirectory = ${repositoryPath}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(codexHome, "config.toml"),
    [
      "project_doc_max_bytes = 0",
      "project_doc_fallback_filenames = []",
      "",
      "[skills]",
      "include_instructions = false",
      "bundled = { enabled = false }",
      "",
      "[shell_environment_policy]",
      'inherit = "core"',
      "ignore_default_excludes = false",
      "",
      `[projects.${JSON.stringify(repositoryPath)}]`,
      'trust_level = "untrusted"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function quarantine(repositoryPath, quarantinePath) {
  for (const surface of INSTRUCTION_SURFACES) {
    const source = path.join(repositoryPath, surface);
    try {
      const information = await lstat(source);
      if (!information.isDirectory() && !information.isSymbolicLink()) continue;
      const target = path.join(quarantinePath, surface);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function restore(repositoryPath, quarantinePath) {
  let contaminated = false;
  for (const surface of INSTRUCTION_SURFACES) {
    const source = path.join(repositoryPath, surface);
    const generated = path.join(quarantinePath, "generated", surface);
    try {
      await lstat(source);
      await mkdir(path.dirname(generated), { recursive: true });
      await rename(source, generated);
      contaminated = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      const original = path.join(quarantinePath, surface);
      await lstat(original);
      await mkdir(path.dirname(source), { recursive: true });
      await rename(original, source);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (contaminated)
    throw new Error(
      "Workspace agent created a quarantined instruction surface",
    );
}

async function commandAsUser({ user, node, cliPath, args, environment, cwd }) {
  const values = Object.entries(environment).flatMap(([key, value]) => [
    key,
    String(value),
  ]);
  await exec(
    "sudo",
    ["--user", user, "--", "env", "-i", ...values, node, cliPath, ...args],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function assertUserProcessesStopped(user) {
  try {
    await exec("sudo", ["pgrep", "-u", user]);
  } catch (error) {
    if (error?.code === 1) return;
    throw error;
  }
  throw new Error("Isolated workspace process survived cleanup");
}

export async function runIsolatedWorkspaceAgent({
  mode,
  directory,
  resultPath,
  configPath,
  modePlanPath,
  cliPath,
  workspaceApiKey,
  workspaceUser,
  codexHome,
  quarantine: quarantinePath,
  workspaceTemp,
  workspaceRoot = process.env.GITHUB_WORKSPACE,
  repositoryPath = process.cwd(),
  toolingPath,
  workspaceAccess = "read",
  worker,
}) {
  const isolation = paths({
    codexHome,
    quarantine: quarantinePath,
    workspaceTemp,
  });
  assertRunnerOwnedDirectory(directory);
  for (const pathname of [
    isolation.codexHome,
    isolation.quarantine,
    isolation.workspaceTemp,
  ])
    await absent(pathname, pathname);
  for (const surface of INSTRUCTION_ROOTS) {
    try {
      const information = await lstat(path.join(repositoryPath, surface));
      if (information.isSymbolicLink())
        throw new Error(`Refusing symlinked ${surface} instruction root`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  let accountCreated = false;
  try {
    await mkdir(isolation.codexHome, { recursive: true, mode: 0o700 });
    await mkdir(isolation.quarantine, { recursive: true, mode: 0o700 });
    await mkdir(isolation.workspaceTemp, { recursive: true, mode: 0o700 });
    await writeCodexConfig(isolation.codexHome, repositoryPath);
    await quarantine(repositoryPath, isolation.quarantine);
    const environment = {
      CI: "true",
      HOME: isolation.codexHome,
      CODEX_HOME: isolation.codexHome,
      USER: workspaceUser ?? process.env.USER ?? "codekeeper-workspace",
      LOGNAME: workspaceUser ?? process.env.LOGNAME ?? "codekeeper-workspace",
      TMPDIR: isolation.workspaceTemp,
      CODEKEEPER_WORKSPACE_API_KEY: required(
        workspaceApiKey,
        "CODEKEEPER_WORKSPACE_API_KEY",
      ),
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      SHELL: "/bin/bash",
    };
    const args = [
      "stage",
      "compute",
      "--operation",
      "workspace-worker",
      "--mode",
      mode,
      "--config",
      configPath,
      "--mode-plan",
      modePlanPath,
      "--directory",
      directory,
      "--result",
      resultPath,
    ];
    if (workspaceUser) {
      try {
        await exec("id", ["-u", workspaceUser]);
        throw new Error(`Workspace account already exists: ${workspaceUser}`);
      } catch (error) {
        if (error?.code !== 1) throw error;
      }
      await exec("sudo", [
        "useradd",
        "--system",
        "--no-create-home",
        "--user-group",
        "--shell",
        "/usr/sbin/nologin",
        workspaceUser,
      ]);
      accountCreated = true;
      await grantWorldTraverse([
        required(workspaceRoot, "GITHUB_WORKSPACE"),
        repositoryPath,
        directory,
        toolingPath,
        cliPath,
        configPath,
        modePlanPath,
      ]);
      await exec("sudo", [
        "chmod",
        "a+x,go-w",
        required(workspaceRoot, "GITHUB_WORKSPACE"),
      ]);
      await exec("sudo", [
        "chmod",
        "-R",
        "a+rX,go-w",
        ...[repositoryPath, directory, toolingPath].filter(Boolean),
      ]);
      await exec("sudo", [
        "chmod",
        "a+r,go-w",
        configPath,
        modePlanPath,
        cliPath,
      ]);
      for (const evidence of [
        resultPath,
        path.join(path.dirname(resultPath), "workspace-runtime-metadata.json"),
      ]) {
        await exec("sudo", ["install", "-m", "600", "/dev/null", evidence]);
      }
      await exec("sudo", [
        "chown",
        "-R",
        `${workspaceUser}:${workspaceUser}`,
        isolation.codexHome,
        isolation.workspaceTemp,
      ]);
      await exec("sudo", [
        "chown",
        `${workspaceUser}:${workspaceUser}`,
        resultPath,
        path.join(path.dirname(resultPath), "workspace-runtime-metadata.json"),
      ]);
      if (workspaceAccess === "write") {
        // Only write-authorized modes receive checkout ownership. It is
        // returned to the coordinator before this function yields.
        await exec("sudo", [
          "chown",
          "-R",
          `${workspaceUser}:${workspaceUser}`,
          repositoryPath,
        ]);
      }
      await exec("sudo", [
        "--user",
        workspaceUser,
        "--",
        "test",
        "-r",
        cliPath,
      ]);
      await commandAsUser({
        user: workspaceUser,
        node: process.execPath,
        cliPath,
        args,
        environment,
        cwd: repositoryPath,
      });
    } else {
      const before = { ...process.env };
      Object.assign(process.env, environment);
      try {
        await worker();
      } finally {
        for (const key of Object.keys(environment)) {
          if (before[key] === undefined) delete process.env[key];
          else process.env[key] = before[key];
        }
      }
    }
    await regular(
      path.join(path.dirname(resultPath), "workspace-runtime-metadata.json"),
      "Workspace runtime metadata",
    );
    await regular(resultPath, "Workspace result");
  } finally {
    try {
      if (workspaceUser && accountCreated) {
        await exec("sudo", ["pkill", "-TERM", "-u", workspaceUser]).catch(
          () => {},
        );
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            await exec("sudo", ["pgrep", "-u", workspaceUser]);
            await exec("sleep", ["0.1"]);
          } catch {
            break;
          }
        }
        await exec("sudo", ["pkill", "-KILL", "-u", workspaceUser]).catch(
          () => {},
        );
        await assertUserProcessesStopped(workspaceUser);
        if (workspaceAccess === "write") {
          await exec("sudo", [
            "chown",
            "-R",
            `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
            repositoryPath,
          ]);
        }
        await exec("sudo", [
          "chown",
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          resultPath,
          path.join(
            path.dirname(resultPath),
            "workspace-runtime-metadata.json",
          ),
        ]).catch(() => {});
        await exec("sudo", [
          "rm",
          "-rf",
          isolation.codexHome,
          isolation.workspaceTemp,
        ]).catch(() => {});
        await exec("sudo", ["userdel", workspaceUser]);
      } else {
        await rm(isolation.codexHome, { recursive: true, force: true });
        await rm(isolation.workspaceTemp, { recursive: true, force: true });
      }
    } finally {
      await restore(repositoryPath, isolation.quarantine);
    }
  }
  return { resultPath, workspaceResultPath: resultPath };
}

export async function verifyFrozenContext(directory, expectedSha256) {
  const contextPath = path.join(directory, "context.json");
  const bytes = await readFile(contextPath);
  const { sha256 } = await import("../markers.mjs");
  const actual = sha256(bytes);
  if (actual !== expectedSha256)
    throw new Error(
      `Frozen context digest mismatch: expected ${expectedSha256}, received ${actual}`,
    );
  return actual;
}

export async function assertWorkspaceEvidence(
  directory,
  expectedFiles = ["workspace-result.json", "workspace-runtime-metadata.json"],
) {
  for (const file of expectedFiles)
    await regular(path.join(directory, file), `Workspace evidence ${file}`);
  return expectedFiles;
}

export function assertWorkspaceDirectory(directory) {
  return assertRunnerOwnedDirectory(directory);
}
