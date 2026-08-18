#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BASE_MANIFEST = "MANIFEST.sha256";
const OVERRIDE_MANIFEST = "MANIFEST.overrides.sha256";
const CONTROL_PATHS = new Set([BASE_MANIFEST, OVERRIDE_MANIFEST]);
const ENTRY = /^([a-fA-F0-9]{64})  (.+)$/;

function fail(message) {
  throw new Error(`Source manifest verification failed: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--root", "--inventory"].includes(flag) || !value || value.startsWith("--")) {
      fail("usage: verify-source-manifest.mjs --root DIRECTORY --inventory FILE");
    }
    if (values.has(flag)) fail(`${flag} was provided more than once`);
    values.set(flag, value);
    index += 1;
  }
  if (values.size !== 2) fail("--root and --inventory are required");
  return {
    root: path.resolve(values.get("--root")),
    inventory: path.resolve(values.get("--inventory")),
  };
}

function safeRelativePath(value, manifestName, { allowControl = false } = {}) {
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (
    !normalized
    || normalized.includes("\\")
    || normalized.includes("\0")
    || path.posix.isAbsolute(normalized)
    || normalized.includes("//")
    || normalized.split("/").some((component) => !component || component === "." || component === "..")
  ) {
    fail(`${manifestName} contains an unsafe path: ${value}`);
  }
  if (!allowControl && CONTROL_PATHS.has(normalized)) {
    fail(`${manifestName} must not hash manifest control file ${normalized}`);
  }
  return normalized;
}

function parseManifest(text, manifestName) {
  const entries = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue;
    const match = line.match(ENTRY);
    if (!match) fail(`${manifestName} contains a malformed entry on line ${index + 1}`);
    const relative = safeRelativePath(match[2], manifestName);
    if (entries.has(relative)) fail(`${manifestName} contains duplicate path ${relative}`);
    entries.set(relative, match[1].toLowerCase());
  }
  if (entries.size === 0 && manifestName === BASE_MANIFEST) {
    fail(`${BASE_MANIFEST} must not be empty`);
  }
  return entries;
}

async function readRegularText(filePath, name, { optional = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") fail(`release tree is missing ${name}`);
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`${name} must be a regular file`);
  return readFile(filePath, "utf8");
}

function sortedUniqueInventory(text) {
  const paths = text.split(/\r?\n/).filter(Boolean);
  if (paths.some((item) => item !== safeRelativePath(item, "inventory", { allowControl: true }))) {
    fail("inventory contains a non-canonical path");
  }
  const filtered = paths.filter((item) => !CONTROL_PATHS.has(item));
  const sorted = [...filtered].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(sorted).size !== sorted.length) fail("inventory contains duplicate paths");
  if (JSON.stringify(filtered) !== JSON.stringify(sorted)) fail("inventory must use deterministic byte-order sorting");
  return sorted;
}

async function sha256RegularFile(filePath, relative) {
  const metadata = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") fail(`manifest path is missing: ${relative}`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`manifest path is not a regular file: ${relative}`);
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function verifySourceManifest({ root, inventory }) {
  const [baseText, overrideText, inventoryText] = await Promise.all([
    readRegularText(path.join(root, BASE_MANIFEST), BASE_MANIFEST),
    readRegularText(path.join(root, OVERRIDE_MANIFEST), OVERRIDE_MANIFEST, { optional: true }),
    readRegularText(inventory, "source inventory"),
  ]);
  const entries = parseManifest(baseText, BASE_MANIFEST);
  let overrideEntries = new Map();
  if (overrideText !== null) {
    overrideEntries = parseManifest(overrideText, OVERRIDE_MANIFEST);
    for (const [relative, digest] of overrideEntries) entries.set(relative, digest);
  }
  const inventoryPaths = sortedUniqueInventory(inventoryText);
  const manifestPaths = [...entries.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(inventoryPaths) !== JSON.stringify(manifestPaths)) {
    const missing = inventoryPaths.filter((item) => !entries.has(item));
    const extra = manifestPaths.filter((item) => !inventoryPaths.includes(item));
    fail(`manifest inventory mismatch; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`);
  }
  for (const relative of manifestPaths) {
    const actual = await sha256RegularFile(path.join(root, ...relative.split("/")), relative);
    if (actual !== entries.get(relative)) fail(`checksum mismatch for ${relative}`);
  }
  return Object.freeze({ files: manifestPaths.length, overrides: overrideEntries.size });
}

async function main() {
  const result = await verifySourceManifest(parseArgs(process.argv.slice(2)));
  process.stdout.write(`verified ${result.files} source files (${result.overrides} overrides)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
