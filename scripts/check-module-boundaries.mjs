#!/usr/bin/env node
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const CONFIG_KEYS = [
  "legacy",
  "newModuleMaxBytes",
  "newModuleMaxLines",
  "newTestMaxBytes",
  "newTestMaxLines",
  "roots",
  "version",
];
const LEGACY_LIMIT_KEYS = "maxBytes,maxLines";
const SKIP_DIRECTORIES = new Set(["node_modules"]);

function fail(message) {
  throw new Error(`Module boundary: ${message}`);
}

function exactObject(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
    fail(`${name} contains unexpected fields`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
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

function isTestModule(filePath) {
  return filePath.endsWith(".test.mjs");
}

function inRoot(filePath, root) {
  return filePath === root || filePath.startsWith(`${root}/`);
}

export function validateModuleBoundaryConfig(config) {
  exactObject(config, "configuration", CONFIG_KEYS);
  if (config.version !== 1) fail("configuration version must be 1");
  positiveInteger(config.newModuleMaxLines, "newModuleMaxLines");
  positiveInteger(config.newModuleMaxBytes, "newModuleMaxBytes");
  positiveInteger(config.newTestMaxLines, "newTestMaxLines");
  positiveInteger(config.newTestMaxBytes, "newTestMaxBytes");
  if (!Array.isArray(config.roots) || config.roots.length === 0) fail("roots must be a non-empty array");
  if (!config.legacy || typeof config.legacy !== "object" || Array.isArray(config.legacy)) {
    fail("legacy must be an object");
  }

  const roots = config.roots.map((root, index) => safeRelativePath(root, `roots[${index}]`));
  if (new Set(roots).size !== roots.length) fail("roots must not contain duplicates");

  const legacy = new Map();
  for (const [filePath, limits] of Object.entries(config.legacy)) {
    safeRelativePath(filePath, `legacy.${filePath}`);
    if (!filePath.endsWith(".mjs")) fail(`legacy module is not a .mjs file: ${filePath}`);
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
      fail(`legacy.${filePath} must contain positive maxLines and maxBytes`);
    }
    if (Object.keys(limits).sort().join(",") !== LEGACY_LIMIT_KEYS) {
      fail(`legacy.${filePath} must contain positive maxLines and maxBytes`);
    }
    positiveInteger(limits.maxLines, `legacy.${filePath}.maxLines`);
    positiveInteger(limits.maxBytes, `legacy.${filePath}.maxBytes`);
    if (!roots.some((root) => inRoot(filePath, root))) {
      fail(`legacy module is outside configured roots: ${filePath}`);
    }
    if (legacy.has(filePath)) fail(`duplicate legacy entry: ${filePath}`);
    legacy.set(filePath, { maxLines: limits.maxLines, maxBytes: limits.maxBytes });
  }

  return { config, roots, legacy };
}

export function evaluateModuleBoundaries({ config, files }) {
  const { roots, legacy } = validateModuleBoundaryConfig(config);
  if (!Array.isArray(files)) fail("file inventory must be an array");

  const violations = [];
  const seen = new Set();
  let modulesChecked = 0;
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) fail("file inventory entries must be objects");
    safeRelativePath(file.path, `file ${file.path}`);
    if (seen.has(file.path)) fail(`duplicate file inventory entry: ${file.path}`);
    seen.add(file.path);
    if (!roots.some((root) => inRoot(file.path, root)) || !file.path.endsWith(".mjs")) continue;
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isSafeInteger(file.lines) || file.lines < 0) {
      fail(`invalid file measurements: ${file.path}`);
    }
    modulesChecked += 1;
    const testFile = isTestModule(file.path);
    const legacyLimit = legacy.get(file.path);
    if (legacyLimit) {
      if (file.bytes > legacyLimit.maxBytes) {
        violations.push(
          `${file.path} grew from its legacy ${legacyLimit.maxBytes}-byte ceiling to ${file.bytes} bytes`,
        );
      }
      if (file.lines > legacyLimit.maxLines) {
        violations.push(
          `${file.path} grew from its legacy ${legacyLimit.maxLines}-line ceiling to ${file.lines} lines`,
        );
      }
      const normalMaxLines = testFile ? config.newTestMaxLines : config.newModuleMaxLines;
      const normalMaxBytes = testFile ? config.newTestMaxBytes : config.newModuleMaxBytes;
      if (file.lines <= normalMaxLines && file.bytes <= normalMaxBytes) {
        violations.push(
          `${file.path} is within the normal ${normalMaxLines}-line/${normalMaxBytes}-byte limit; remove its legacy exemption`,
        );
      }
      continue;
    }
    const maxLines = testFile ? config.newTestMaxLines : config.newModuleMaxLines;
    const maxBytes = testFile ? config.newTestMaxBytes : config.newModuleMaxBytes;
    const kind = testFile ? "tests" : "modules";
    if (file.lines > maxLines) {
      violations.push(`${file.path} has ${file.lines} lines; new ${kind} are limited to ${maxLines}`);
    }
    if (file.bytes > maxBytes) {
      violations.push(`${file.path} has ${file.bytes} bytes; new ${kind} are limited to ${maxBytes}`);
    }
  }
  for (const filePath of legacy.keys()) {
    if (!seen.has(filePath)) violations.push(`legacy module is missing: ${filePath}`);
  }
  if (violations.length) fail(violations.join("\n"));
  return Object.freeze({
    valid: true,
    modulesChecked,
    legacyModules: legacy.size,
  });
}

async function walk(root, relativeRoot) {
  const directory = path.join(root, ...relativeRoot.split("/"));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    fail(`could not read source root ${relativeRoot}: ${error.message}`);
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = `${relativeRoot}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`source root contains a symlink: ${relativePath}`);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await walk(root, relativePath)));
      continue;
    }
    if (!entry.isFile() || !relativePath.endsWith(".mjs")) continue;
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`module is not a regular file: ${relativePath}`);
    const source = await readFile(absolutePath, "utf8");
    files.push({
      path: relativePath,
      bytes: Buffer.byteLength(source),
      lines: lineCount(source),
    });
  }
  return files;
}

export async function collectModuleBoundaryFiles(root, roots) {
  const files = [];
  for (const relativeRoot of roots) files.push(...(await walk(root, relativeRoot)));
  return files;
}

export async function checkRepositoryModuleBoundaries(root = REPOSITORY_ROOT) {
  const configPath = path.join(root, "scripts", "module-boundaries.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    fail(`could not read scripts/module-boundaries.json: ${error.message}`);
  }
  const { roots } = validateModuleBoundaryConfig(config);
  const files = await collectModuleBoundaryFiles(root, roots);
  return evaluateModuleBoundaries({ config, files });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  checkRepositoryModuleBoundaries()
    .then((result) => {
      process.stdout.write(
        `module boundaries valid; ${result.modulesChecked} modules checked, ${result.legacyModules} legacy ceilings\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
