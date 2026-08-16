import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TOOLING_DIRECTORIES = [
  "agents",
  "presets",
  "src",
];
export const TOOLING_FILES = ["package-lock.json", "package.json", "scripts/verify-tooling-artifact.mjs"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireRegularFile(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
  return readFile(filePath);
}

async function collectDirectory(root, relativeDirectory, entries) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const stat = await lstat(absoluteDirectory);
  if (!stat.isDirectory()) throw new Error(`Expected a directory: ${relativeDirectory}`);

  const children = await readdir(absoluteDirectory, { withFileTypes: true });
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(relativeDirectory, child.name);
    const absolutePath = path.join(root, relativePath);
    if (child.name.startsWith(".")) throw new Error(`Tooling payload must not contain hidden paths: ${relativePath}`);
    if (child.isSymbolicLink()) throw new Error(`Tooling payload must not contain symlinks: ${relativePath}`);
    if (child.isDirectory()) {
      await collectDirectory(root, relativePath, entries);
      continue;
    }
    if (!child.isFile()) throw new Error(`Tooling payload must contain only regular files: ${relativePath}`);
    entries.push({ path: relativePath, sha256: sha256(await requireRegularFile(absolutePath)) });
  }
}

export async function collectToolingManifestEntries(root = packageRoot) {
  const entries = [];
  for (const relativePath of TOOLING_FILES) {
    entries.push({ path: relativePath, sha256: sha256(await requireRegularFile(path.join(root, relativePath))) });
  }
  for (const relativeDirectory of TOOLING_DIRECTORIES) await collectDirectory(root, relativeDirectory, entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function toolingManifestText(root = packageRoot) {
  return `${JSON.stringify({ version: 1, files: await collectToolingManifestEntries(root) }, null, 2)}\n`;
}

async function main() {
  const command = process.argv[2] ?? "--check";
  const manifestPath = path.join(packageRoot, "tooling-manifest.json");
  const expected = await toolingManifestText();
  if (command === "--write") {
    await writeFile(manifestPath, expected, "utf8");
    return;
  }
  if (command === "--print") {
    process.stdout.write(expected);
    return;
  }
  if (command !== "--check") throw new Error("Usage: generate-tooling-manifest.mjs [--check|--print|--write]");
  const actual = await readFile(manifestPath, "utf8");
  if (actual !== expected) throw new Error("tooling-manifest.json does not match the production tooling payload; run generate-tooling-manifest.mjs --write");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`tooling-manifest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
