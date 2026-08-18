#!/usr/bin/env node
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`Module boundary: ${message}`);
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

function lineCount(source) {
  if (!source.length) return 0;
  return source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
}

export function evaluateModuleBoundaries({ config, files }) {
  if (!config || config.version !== 1) fail("configuration version must be 1");
  if (!Number.isSafeInteger(config.newModuleMaxLines) || config.newModuleMaxLines < 1) {
    fail("newModuleMaxLines must be a positive integer");
  }
  if (!Number.isSafeInteger(config.newModuleMaxBytes) || config.newModuleMaxBytes < 1) {
    fail("newModuleMaxBytes must be a positive integer");
  }
  if (!Array.isArray(config.roots) || !config.roots.length) fail("roots must be a non-empty array");
  if (!config.legacy || typeof config.legacy !== "object" || Array.isArray(config.legacy)) {
    fail("legacy must be an object");
  }

  const roots = config.roots.map((root, index) => safeRelativePath(root, `roots[${index}]`));
  const legacy = new Map();
  for (const [filePath, limits] of Object.entries(config.legacy)) {
    safeRelativePath(filePath, `legacy.${filePath}`);
    if (
      !limits ||
      Object.keys(limits).length !== 1 ||
      !Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes < 1
    ) {
      fail(`legacy.${filePath} must contain one positive maxBytes`);
    }
    if (!roots.some((root) => filePath.startsWith(`${root}/`))) {
      fail(`legacy module is outside configured roots: ${filePath}`);
    }
    legacy.set(filePath, limits.maxBytes);
  }

  const violations = [];
  const seen = new Set();
  for (const file of files) {
    safeRelativePath(file.path, `file ${file.path}`);
    if (seen.has(file.path)) fail(`duplicate file inventory entry: ${file.path}`);
    seen.add(file.path);
    if (!roots.some((root) => file.path.startsWith(`${root}/`)) || !file.path.endsWith(".mjs")) continue;
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isSafeInteger(file.lines) || file.lines < 0) {
      fail(`invalid file measurements: ${file.path}`);
    }
    const legacyLimit = legacy.get(file.path);
    if (legacyLimit !== undefined) {
      if (file.bytes > legacyLimit) {
        violations.push(`${file.path} grew from its legacy ${legacyLimit}-byte ceiling to ${file.bytes} bytes`);
      }
      continue;
    }
    if (file.lines > config.newModuleMaxLines) {
      violations.push(`${file.path} has ${file.lines} lines; new modules are limited to ${config.newModuleMaxLines}`);
    }
    if (file.bytes > config.newModuleMaxBytes) {
      violations.push(`${file.path} has ${file.bytes} bytes; new modules are limited to ${config.newModuleMaxBytes}`);
    }
  }
  for (const filePath of legacy.keys()) {
    if (!seen.has(filePath)) violations.push(`legacy module is missing: ${filePath}`);
  }
  if (violations.length) fail(violations.join("\n"));
  return Object.freeze({
    valid: true,
    modulesChecked: files.filter((file) =>
      roots.some((root) => file.path.startsWith(`${root}/`)) && file.path.endsWith(".mjs")
    ).length,
    legacyModules: legacy.size
  });
}

async function walk(root, relativeRoot) {
  const directory = path.join(root, ...relativeRoot.split("/"));
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = `${relativeRoot}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`source root contains a symlink: ${relativePath}`);
    if (entry.isDirectory()) files.push(...await walk(root, relativePath));
    else if (entry.isFile() && relativePath.endsWith(".mjs")) {
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`module is not a regular file: ${relativePath}`);
      const source = await readFile(absolutePath, "utf8");
      files.push({ path: relativePath, bytes: Buffer.byteLength(source), lines: lineCount(source) });
    }
  }
  return files;
}

export async function checkRepositoryModuleBoundaries(root = ROOT) {
  const config = JSON.parse(await readFile(path.join(root, "scripts/module-boundaries.json"), "utf8"));
  const files = [];
  for (const relativeRoot of config.roots) files.push(...await walk(root, relativeRoot));
  return evaluateModuleBoundaries({ config, files });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkRepositoryModuleBoundaries();
  process.stdout.write(`module boundaries valid; ${result.modulesChecked} modules checked, ${result.legacyModules} legacy ceilings\n`);
}
