import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_REPOSITORY as SOURCE_REPOSITORY_SLUG } from "../packages/codekeeper/src/constants.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const RELEASE_MANIFEST_PATH = "release/manifest.json";
const SOURCE_REPOSITORY = `https://github.com/${SOURCE_REPOSITORY_SLUG}`;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const DIRECTORY_MAPPINGS = Object.freeze([
  ["packages/codekeeper/assets", "assets"],
  ["packages/codekeeper/bin", "bin"],
  ["packages/codekeeper/src", "src"],
  ["tools/codekeeper/agents", "runtime/agents"],
  ["tools/codekeeper/presets", "runtime/presets"],
  ["tools/codekeeper/src", "runtime/src"],
]);

const FILE_MAPPINGS = Object.freeze([
  ["packages/codekeeper/LICENSE", "LICENSE"],
  ["packages/codekeeper/README.md", "README.md"],
  ["packages/codekeeper/package.json", "package.json"],
  ["packages/codekeeper/npm-shrinkwrap.json", "npm-shrinkwrap.json"],
  ["tools/codekeeper/action.yml", "runtime/action.yml", "legacy-compatibility"],
  ["tools/codekeeper/integrations/braintrust/run-agent.mjs", "runtime/integrations/braintrust/run-agent.mjs"],
  ["tools/codekeeper/scripts/verify-tooling-artifact.mjs", "runtime/scripts/verify-tooling-artifact.mjs"],
  [".github/workflows/codekeeper-assistant.yml", "release/workflows/codekeeper-assistant.yml"],
  [".github/workflows/codekeeper-fix.yml", "release/workflows/codekeeper-fix.yml"],
  [".github/workflows/codekeeper-issues.yml", "release/workflows/codekeeper-issues.yml"],
  [".github/workflows/codekeeper-maintain.yml", "release/workflows/codekeeper-maintain.yml"],
  [".github/workflows/codekeeper-review.yml", "release/workflows/codekeeper-review.yml"],
]);

function fail(message) {
  throw new Error(`Codekeeper package stage failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validStagePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 300 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
  );
}

function validSourcePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 400 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

async function requireRegularFile(filePath, displayPath) {
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`missing file: ${displayPath}`);
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`symlink is not allowed: ${displayPath}`);
  if (!stat.isFile()) fail(`not a regular file: ${displayPath}`);
  return readFile(filePath);
}

async function collectDirectoryFiles(root, relativeDirectory = "") {
  const directoryPath = path.join(root, relativeDirectory);
  const stat = await lstat(directoryPath);
  if (stat.isSymbolicLink()) fail(`symlink is not allowed: ${relativeDirectory || "."}`);
  if (!stat.isDirectory()) fail(`not a directory: ${relativeDirectory || "."}`);

  const files = [];
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".")) fail(`hidden path is not allowed: ${relativePath}`);
    if (entry.isSymbolicLink()) fail(`symlink is not allowed: ${relativePath}`);
    if (entry.isDirectory()) {
      files.push(...(await collectDirectoryFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      fail(`non-file entry is not allowed: ${relativePath}`);
    }
  }
  return files;
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveReleaseCommit(repositoryRoot, { sourceCommit, requireClean }) {
  if (!requireClean) {
    if (!FULL_COMMIT.test(sourceCommit ?? "")) fail("an explicit full source commit is required for fixture builds");
    return sourceCommit;
  }
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (!FULL_COMMIT.test(head)) fail("repository HEAD is not a full commit");
  if (sourceCommit !== undefined && sourceCommit !== head) fail("source commit does not match repository HEAD");
  if (git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    fail("release builds require a clean working tree");
  }
  return head;
}

async function assertDestinationAbsent(destination) {
  try {
    await lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(`destination already exists: ${destination}`);
}

async function copyProductFile({ repositoryRoot, destination, sourcePath, stagePath, role = "production" }) {
  if (!validSourcePath(sourcePath) || !validStagePath(stagePath) || stagePath === RELEASE_MANIFEST_PATH) {
    fail(`invalid source mapping: ${sourcePath} -> ${stagePath}`);
  }
  const source = path.join(repositoryRoot, sourcePath);
  const target = path.join(destination, stagePath);
  const bytes = await requireRegularFile(source, sourcePath);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return { path: stagePath, sourcePath, role, sha256: sha256(bytes) };
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("release manifest is not valid JSON");
  }
  if (
    manifest?.version !== 1 ||
    manifest?.package?.name !== "codekeeper" ||
    typeof manifest?.package?.version !== "string" ||
    manifest?.source?.repository !== SOURCE_REPOSITORY ||
    !FULL_COMMIT.test(manifest?.source?.commit ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 500
  ) {
    fail("release manifest shape is invalid");
  }
  const files = new Map();
  for (const entry of manifest.files) {
    if (
      !entry ||
      !validStagePath(entry.path) ||
      entry.path === RELEASE_MANIFEST_PATH ||
      !validSourcePath(entry.sourcePath) ||
      !["production", "legacy-compatibility"].includes(entry.role) ||
      !SHA256.test(entry.sha256 ?? "") ||
      files.has(entry.path)
    ) {
      fail("release manifest contains an invalid file entry");
    }
    files.set(entry.path, entry);
  }
  if (files.get("runtime/action.yml")?.role !== "legacy-compatibility") {
    fail("legacy action is not marked as compatibility-only");
  }
  return { manifest, files };
}

export async function verifyCodekeeperPackageStage(destination) {
  const manifestBytes = await requireRegularFile(
    path.join(destination, RELEASE_MANIFEST_PATH),
    RELEASE_MANIFEST_PATH,
  );
  const { manifest, files } = parseManifest(manifestBytes);
  const actualPaths = (await collectDirectoryFiles(destination)).sort();
  const expectedPaths = [...files.keys(), RELEASE_MANIFEST_PATH].sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((actualPath, index) => actualPath !== expectedPaths[index])
  ) {
    fail("staged file inventory does not match the release manifest");
  }
  for (const [relativePath, entry] of files) {
    const bytes = await requireRegularFile(path.join(destination, relativePath), relativePath);
    if (sha256(bytes) !== entry.sha256) fail(`digest mismatch for ${relativePath}`);
  }
  return manifest;
}

export async function buildCodekeeperPackageStage({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  destination,
  sourceCommit,
  requireClean = true,
} = {}) {
  if (typeof destination !== "string" || destination.length === 0) fail("destination is required");
  repositoryRoot = path.resolve(repositoryRoot);
  destination = path.resolve(destination);
  if (destination === repositoryRoot || destination.startsWith(`${repositoryRoot}${path.sep}`)) {
    fail("destination must be outside the source repository");
  }
  const commit = resolveReleaseCommit(repositoryRoot, { sourceCommit, requireClean });
  await assertDestinationAbsent(destination);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryDestination = await mkdtemp(
    path.join(path.dirname(destination), `.${path.basename(destination)}.tmp-`),
  );

  try {
    const files = [];
    for (const [sourceDirectory, stageDirectory] of DIRECTORY_MAPPINGS) {
      const sourceRoot = path.join(repositoryRoot, sourceDirectory);
      for (const relativePath of await collectDirectoryFiles(sourceRoot)) {
        files.push(
          await copyProductFile({
            repositoryRoot,
            destination: temporaryDestination,
            sourcePath: `${sourceDirectory}/${relativePath}`,
            stagePath: `${stageDirectory}/${relativePath}`,
          }),
        );
      }
    }
    for (const [sourcePath, stagePath, role] of FILE_MAPPINGS) {
      files.push(
        await copyProductFile({
          repositoryRoot,
          destination: temporaryDestination,
          sourcePath,
          stagePath,
          role,
        }),
      );
    }
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const packageManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "packages/codekeeper/package.json"), "utf8"),
    );
    const manifest = {
      version: 1,
      package: { name: packageManifest.name, version: packageManifest.version },
      source: { repository: SOURCE_REPOSITORY, commit },
      files,
    };
    await mkdir(path.join(temporaryDestination, "release"), { recursive: true });
    await writeFile(
      path.join(temporaryDestination, RELEASE_MANIFEST_PATH),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await verifyCodekeeperPackageStage(temporaryDestination);
    await rename(temporaryDestination, destination);
    return { destination, manifest };
  } catch (error) {
    await rm(temporaryDestination, { force: true, recursive: true });
    throw error;
  }
}

function outputArgument(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    fail("usage: node scripts/build-codekeeper-package.mjs [--output DIRECTORY]");
  }
  return path.resolve(args[1]);
}

async function main() {
  const requestedOutput = outputArgument(process.argv.slice(2));
  const destination =
    requestedOutput ?? path.join(os.tmpdir(), `codekeeper-package-stage-${randomUUID()}`);
  const result = await buildCodekeeperPackageStage({ destination });
  process.stdout.write(`${result.destination}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
