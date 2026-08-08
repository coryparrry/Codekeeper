import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestName = "tooling-manifest.json";

function fail(message) {
  throw new Error(`Codekeeper tooling integrity check failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validRelativePath(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."));
}

async function regularFile(filePath, relativePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile()) fail(`${relativePath} is not a regular file`);
  return readFile(filePath);
}

async function collectActualFiles(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const stat = await lstat(directory);
  if (!stat.isDirectory()) fail(`${relativeDirectory || "."} is not a directory`);

  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, relativePath);
    if (entry.name.startsWith(".")) fail(`${relativePath} is a hidden path`);
    if (entry.isSymbolicLink()) fail(`${relativePath} is a symlink`);
    if (entry.isDirectory()) {
      entries.push(...await collectActualFiles(root, relativePath));
      continue;
    }
    if (!entry.isFile()) fail(`${relativePath} is not a regular file`);
    entries.push(relativePath);
    await regularFile(absolutePath, relativePath);
  }
  return entries;
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("manifest is not valid JSON");
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 500) {
    fail("manifest shape is invalid");
  }
  const files = new Map();
  for (const entry of manifest.files) {
    if (!entry || !validRelativePath(entry.path) || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") || entry.path === manifestName || files.has(entry.path)) {
      fail("manifest contains an invalid file entry");
    }
    files.set(entry.path, entry.sha256);
  }
  return files;
}

function equalPaths(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export async function verifyToolingArtifact({ root, expectedManifestSha256 }) {
  if (typeof root !== "string" || root.length === 0) fail("tooling root is required");
  if (!/^[0-9a-f]{64}$/.test(expectedManifestSha256 ?? "")) fail("expected manifest SHA-256 is invalid");
  const manifestPath = path.join(root, manifestName);
  const manifestBytes = await regularFile(manifestPath, manifestName);
  if (sha256(manifestBytes) !== expectedManifestSha256) fail("manifest digest does not match the pinned workflow");

  const expectedFiles = parseManifest(manifestBytes);
  const actualPaths = (await collectActualFiles(root)).sort();
  const expectedPaths = [...expectedFiles.keys(), manifestName].sort();
  if (!equalPaths(actualPaths, expectedPaths)) fail("artifact file inventory does not match the pinned manifest");

  for (const [relativePath, expectedDigest] of expectedFiles) {
    const actualDigest = sha256(await regularFile(path.join(root, relativePath), relativePath));
    if (actualDigest !== expectedDigest) fail(`digest mismatch for ${relativePath}`);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const root = argument("--root");
  const expectedManifestSha256 = argument("--expected-manifest-sha256");
  if (process.argv.length !== 6 || !root || !expectedManifestSha256) {
    throw new Error("Usage: verify-tooling-artifact.mjs --root DIRECTORY --expected-manifest-sha256 SHA256");
  }
  await verifyToolingArtifact({ root, expectedManifestSha256 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
