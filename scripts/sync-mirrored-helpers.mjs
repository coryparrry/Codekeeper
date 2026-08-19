#!/usr/bin/env node
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const MIRROR_KEYS = "canonical,published";

export const MIRRORED_HELPERS = Object.freeze([
  Object.freeze({
    canonical: "tools/codekeeper/src/lib/label-ownership.mjs",
    published: "packages/codekeeper/src/label-ownership.mjs",
  }),
]);

function fail(message) {
  throw new Error(`Mirrored helper: ${message}`);
}

function safeRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\"))
  ) {
    fail(`${label} is not a safe repository-relative path`);
  }
  return value;
}

function resolveRepositoryPath(root, relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

export function validateMirroredHelperInventory(mirrors) {
  if (!Array.isArray(mirrors) || mirrors.length === 0) fail("inventory must be a non-empty array");

  const seenCanonical = new Set();
  const seenPublished = new Set();
  const validated = [];
  for (const [index, mirror] of mirrors.entries()) {
    if (!mirror || typeof mirror !== "object" || Array.isArray(mirror)) {
      fail(`mirrors[${index}] must be an object`);
    }
    if (Object.keys(mirror).sort().join(",") !== MIRROR_KEYS) {
      fail(`mirrors[${index}] must contain canonical and published paths`);
    }
    const canonical = safeRelativePath(mirror.canonical, `mirrors[${index}].canonical`);
    const published = safeRelativePath(mirror.published, `mirrors[${index}].published`);
    if (!canonical.endsWith(".mjs") || !published.endsWith(".mjs")) {
      fail(`mirrors[${index}] must list .mjs files`);
    }
    if (!canonical.startsWith("tools/codekeeper/")) {
      fail(`canonical helper is outside the runtime package: ${canonical}`);
    }
    if (!published.startsWith("packages/codekeeper/")) {
      fail(`published helper is outside the installer package: ${published}`);
    }
    if (canonical === published) fail(`mirrors[${index}] cannot publish a file onto itself`);
    if (seenCanonical.has(canonical)) fail(`duplicate canonical helper: ${canonical}`);
    if (seenPublished.has(published)) fail(`duplicate published helper: ${published}`);
    seenCanonical.add(canonical);
    seenPublished.add(published);
    validated.push(Object.freeze({ canonical, published }));
  }
  return Object.freeze(validated);
}

async function assertRegularFile(root, relativePath, label) {
  const absolutePath = resolveRepositoryPath(root, relativePath);
  let stat;
  try {
    stat = await lstat(absolutePath);
  } catch (error) {
    fail(`${label} is missing: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) fail(`${label} is a symlink: ${relativePath}`);
  if (!stat.isFile()) fail(`${label} is not a regular file: ${relativePath}`);
  return absolutePath;
}

export async function checkMirroredHelpers({
  root = REPOSITORY_ROOT,
  mirrors = MIRRORED_HELPERS,
} = {}) {
  const inventory = validateMirroredHelperInventory(mirrors);
  const drifted = [];
  for (const helper of inventory) {
    const canonicalPath = await assertRegularFile(root, helper.canonical, "canonical helper");
    const publishedPath = await assertRegularFile(root, helper.published, "published helper");
    const canonical = await readFile(canonicalPath);
    const published = await readFile(publishedPath);
    if (!canonical.equals(published)) drifted.push(helper);
  }
  if (drifted.length) {
    fail(
      drifted
        .map(
          (helper) =>
            `${helper.published} does not match canonical ${helper.canonical}; run scripts/sync-mirrored-helpers.mjs --write`,
        )
        .join("\n"),
    );
  }
  return Object.freeze({ valid: true, helpersChecked: inventory.length });
}

export async function writeMirroredHelpers({
  root = REPOSITORY_ROOT,
  mirrors = MIRRORED_HELPERS,
} = {}) {
  const inventory = validateMirroredHelperInventory(mirrors);
  for (const helper of inventory) {
    const canonicalPath = await assertRegularFile(root, helper.canonical, "canonical helper");
    const publishedPath = resolveRepositoryPath(root, helper.published);
    try {
      const publishedStat = await lstat(publishedPath);
      if (publishedStat.isSymbolicLink()) fail(`published helper is a symlink: ${helper.published}`);
      if (!publishedStat.isFile()) fail(`published helper is not a regular file: ${helper.published}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const canonical = await readFile(canonicalPath);
    await mkdir(path.dirname(publishedPath), { recursive: true });
    await writeFile(publishedPath, canonical);
  }
  return Object.freeze({ written: inventory.length });
}

async function main(argv) {
  const command = argv[0] ?? "--check";
  if (command === "--write") {
    const result = await writeMirroredHelpers();
    process.stdout.write(`mirrored helpers written; ${result.written} helpers\n`);
    return;
  }
  if (command === "--check") {
    const result = await checkMirroredHelpers();
    process.stdout.write(`mirrored helpers valid; ${result.helpersChecked} helpers checked\n`);
    return;
  }
  throw new Error("Usage: sync-mirrored-helpers.mjs [--check|--write]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
