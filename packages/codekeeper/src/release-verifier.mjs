import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  PACKAGE_NAME,
  PACKAGE_SOURCE_REPOSITORY_URL,
} from "./package-identity.mjs";
import { verifyRuntimeArchive } from "./runtime-archive.mjs";
import {
  normalizePackageIdentity,
  validSha512Integrity,
} from "./package-release.mjs";

export const RELEASE_MANIFEST_PATH = "release/manifest.json";
export const INTEGRITY_RECEIPT_PATH = "release/package-integrity.json";

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IGNORED_DEPENDENCY_DIRECTORIES = new Set(["node_modules", "runtime/node_modules"]);

function fail(message) {
  throw new Error(`Codekeeper package verification failed: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 400 &&
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
    value.length <= 500 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

async function readRegularFile(root, relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  let information;
  try {
    information = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`missing file: ${relativePath}`);
    throw error;
  }
  if (information.isSymbolicLink() || !information.isFile()) fail(`not a regular non-symlink file: ${relativePath}`);
  return readFile(target);
}

async function collectProductFiles(root, relativeDirectory = "") {
  const directory = relativeDirectory
    ? path.join(root, ...relativeDirectory.split("/"))
    : root;
  const information = await lstat(directory);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    fail(`not a regular non-symlink directory: ${relativeDirectory || "."}`);
  }
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".")) fail(`hidden path is not allowed: ${relativePath}`);
    if (entry.isSymbolicLink()) fail(`symlink is not allowed: ${relativePath}`);
    if (IGNORED_DEPENDENCY_DIRECTORIES.has(relativePath)) {
      if (!entry.isDirectory()) fail(`dependency path is not a directory: ${relativePath}`);
      continue;
    }
    if (relativePath === INTEGRITY_RECEIPT_PATH) {
      if (!entry.isFile()) fail(`integrity receipt is not a regular file: ${relativePath}`);
      continue;
    }
    if (entry.isDirectory()) files.push(...await collectProductFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else fail(`unsupported filesystem entry: ${relativePath}`);
  }
  return files;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function parseManifest(bytes) {
  const manifest = parseJson(bytes, "release manifest");
  if (
    manifest?.version !== 1 ||
    manifest?.package?.name !== PACKAGE_NAME ||
    manifest?.source?.repository !== PACKAGE_SOURCE_REPOSITORY_URL ||
    !FULL_COMMIT.test(manifest?.source?.commit ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > 500
  ) {
    fail("release manifest shape is invalid");
  }
  try {
    normalizePackageIdentity(manifest.package, { expectedVersion: undefined });
  } catch {
    fail("release manifest shape is invalid");
  }
  const files = new Map();
  for (const entry of manifest.files) {
    if (
      !entry ||
      !validPath(entry.path) ||
      entry.path === RELEASE_MANIFEST_PATH ||
      entry.path === INTEGRITY_RECEIPT_PATH ||
      !validSourcePath(entry.sourcePath) ||
      entry.role !== "production" ||
      !SHA256.test(entry.sha256 ?? "") ||
      files.has(entry.path)
    ) {
      fail("release manifest contains an invalid file entry");
    }
    files.set(entry.path, entry);
  }
  return { manifest, files };
}

async function verifyIntegrityReceipt(root, expectedIntegrity) {
  if (!validSha512Integrity(expectedIntegrity)) fail("expected package integrity is invalid");
  const receipt = parseJson(await readRegularFile(root, INTEGRITY_RECEIPT_PATH), "package integrity receipt");
  if (
    receipt?.version !== 1 ||
    receipt?.algorithm !== "sha512" ||
    receipt?.integrity !== expectedIntegrity ||
    Object.keys(receipt).sort().join(",") !== "algorithm,integrity,version"
  ) {
    fail("package integrity receipt does not match the externally verified tarball");
  }
}

export async function verifyCodekeeperRelease({
  root,
  expectedName,
  expectedVersion,
  expectedIntegrity,
  expectedManifestSha256,
  expectedSourceCommit,
} = {}) {
  if (typeof root !== "string" || !root) fail("package root is required");
  const resolvedRoot = path.resolve(root);
  const manifestBytes = await readRegularFile(resolvedRoot, RELEASE_MANIFEST_PATH);
  const { manifest, files } = parseManifest(manifestBytes);
  if (expectedName !== undefined && manifest.package.name !== expectedName) fail("package name does not match");
  if (expectedVersion !== undefined && manifest.package.version !== expectedVersion) fail("package version does not match");
  if (expectedSourceCommit !== undefined && manifest.source.commit !== expectedSourceCommit) fail("source commit does not match");
  if (expectedManifestSha256 !== undefined) {
    if (!SHA256.test(expectedManifestSha256) || sha256(manifestBytes) !== expectedManifestSha256) {
      fail("release manifest SHA-256 does not match");
    }
  }
  if (expectedIntegrity !== undefined) await verifyIntegrityReceipt(resolvedRoot, expectedIntegrity);

  const actualPaths = (await collectProductFiles(resolvedRoot)).sort();
  const expectedPaths = [...files.keys(), RELEASE_MANIFEST_PATH].sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((actualPath, index) => actualPath !== expectedPaths[index])
  ) {
    fail("package file inventory does not match the release manifest");
  }
  for (const [relativePath, entry] of files) {
    if (sha256(await readRegularFile(resolvedRoot, relativePath)) !== entry.sha256) {
      fail(`digest mismatch for ${relativePath}`);
    }
  }
  await verifyRuntimeArchive(resolvedRoot);
  const packageManifest = parseJson(await readRegularFile(resolvedRoot, "package.json"), "package manifest");
  if (packageManifest.name !== manifest.package.name || packageManifest.version !== manifest.package.version) {
    fail("package manifest identity does not match the release manifest");
  }
  return manifest;
}
