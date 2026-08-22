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
import {
  PACKAGE_SOURCE_REPOSITORY_URL,
} from "../packages/codekeeper/src/package-identity.mjs";
import {
  RELEASE_DIRECTORY_MAPPINGS,
  RELEASE_FILE_MAPPINGS,
  RELEASE_PUBLISHED_PATHS,
} from "../packages/codekeeper/src/release-layout.mjs";
import {
  buildPrebuiltRuntimeArchive,
  writeGeneratedRuntimeArchive,
} from "../packages/codekeeper/src/prebuilt-runtime.mjs";
import {
  RELEASE_MANIFEST_PATH,
  verifyCodekeeperRelease,
} from "../packages/codekeeper/src/release-verifier.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const FULL_COMMIT = /^[0-9a-f]{40}$/;

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

export async function verifyCodekeeperPackageStage(destination) {
  return verifyCodekeeperRelease({ root: destination });
}

export async function buildCodekeeperPackageStage({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  destination,
  sourceCommit,
  requireClean = true,
  installRuntimeDependencies,
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
    for (const [sourceDirectory, stageDirectory] of RELEASE_DIRECTORY_MAPPINGS) {
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
    for (const [sourcePath, stagePath, role] of RELEASE_FILE_MAPPINGS) {
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
    const archive = await buildPrebuiltRuntimeArchive({
      stagedRuntimeRoot: path.join(temporaryDestination, "runtime"),
      ...(installRuntimeDependencies ? { installRuntimeDependencies } : {}),
    });
    files.push(...(await writeGeneratedRuntimeArchive(temporaryDestination, archive)));
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const packageManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "packages/codekeeper/package.json"), "utf8"),
    );
    const publishedPaths = [...packageManifest.files].sort();
    if (
      publishedPaths.length !== RELEASE_PUBLISHED_PATHS.length
      || publishedPaths.some((entry, index) => entry !== RELEASE_PUBLISHED_PATHS[index])
    ) {
      fail("package.json files must exactly cover the staged release roots");
    }
    const manifest = {
      version: 1,
      package: { name: packageManifest.name, version: packageManifest.version },
      source: { repository: PACKAGE_SOURCE_REPOSITORY_URL, commit },
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
