#!/usr/bin/env node
import { parse } from "acorn";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectModuleBoundaryFiles,
  validateModuleBoundaryConfig,
} from "./check-module-boundaries.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const FACADE_KEYS = "domain,facade";

export const COMPATIBILITY_FACADES = Object.freeze([
  Object.freeze({
    facade: "tools/codekeeper/src/lib/github.mjs",
    domain: "tools/codekeeper/src/lib/github",
  }),
  Object.freeze({
    facade: "tools/codekeeper/src/lib/publish.mjs",
    domain: "tools/codekeeper/src/lib/publish",
  }),
  Object.freeze({
    facade: "packages/codekeeper/src/preflight.mjs",
    domain: "packages/codekeeper/src/preflight",
  }),
  Object.freeze({
    facade: "packages/codekeeper/src/plan.mjs",
    domain: "packages/codekeeper/src/plan",
  }),
  Object.freeze({
    facade: "tools/codekeeper/src/cli.mjs",
    domain: "tools/codekeeper/src/cli-heavy.mjs",
  }),
]);

function fail(message) {
  throw new Error(`Local import cycle: ${message}`);
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

function walkSyntax(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkSyntax(item, visit);
    return;
  }
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "loc" && key !== "range" && key !== "start" && key !== "end") {
      walkSyntax(value, visit);
    }
  }
}

function localSpecifier(node) {
  return node?.type === "Literal" && typeof node.value === "string" && node.value.startsWith(".")
    ? node.value
    : null;
}

export function localImportSpecifiers(source) {
  let syntax;
  try {
    syntax = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    fail(`could not parse module syntax: ${error.message}`);
  }
  const specifiers = [];
  walkSyntax(syntax, (node) => {
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) {
      const specifier = localSpecifier(node.source);
      if (specifier) specifiers.push(specifier);
    }
  });
  return specifiers;
}

export function validateCompatibilityFacades(facades = COMPATIBILITY_FACADES) {
  if (!Array.isArray(facades) || facades.length === 0) fail("facade inventory must be a non-empty array");
  const seenFacades = new Set();
  const seenDomains = new Set();
  const validated = [];
  for (const [index, entry] of facades.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`facades[${index}] must be an object`);
    }
    if (Object.keys(entry).sort().join(",") !== FACADE_KEYS) {
      fail(`facades[${index}] must contain facade and domain paths`);
    }
    const facade = safeRelativePath(entry.facade, `facades[${index}].facade`);
    const domain = safeRelativePath(entry.domain, `facades[${index}].domain`);
    if (!facade.endsWith(".mjs")) fail(`facade is not a .mjs file: ${facade}`);
    if (facade === domain) fail(`facade cannot own itself: ${facade}`);
    if (seenFacades.has(facade)) fail(`duplicate facade: ${facade}`);
    if (seenDomains.has(domain)) fail(`duplicate facade domain: ${domain}`);
    seenFacades.add(facade);
    seenDomains.add(domain);
    validated.push(Object.freeze({ facade, domain }));
  }
  return Object.freeze(validated);
}

function inRoot(filePath, root) {
  return filePath === root || filePath.startsWith(`${root}/`);
}

function inDomain(filePath, domain) {
  if (domain.endsWith(".mjs")) return filePath === domain;
  return filePath === domain || filePath.startsWith(`${domain}/`);
}

function resolveLocalSpecifier(fromPath, specifier) {
  if (typeof specifier !== "string" || !(specifier.startsWith("./") || specifier.startsWith("../"))) {
    return null;
  }
  const directory = path.posix.dirname(fromPath);
  let resolved = path.posix.normalize(path.posix.join(directory, specifier));
  if (!resolved || resolved.startsWith("../") || resolved === ".." || resolved.includes("\\")) {
    fail(`${fromPath} imports an unsafe local module: ${specifier}`);
  }
  if (!resolved.endsWith(".mjs")) resolved = `${resolved}.mjs`;
  return resolved;
}

function firstCycle(graph) {
  const color = new Map();
  const stack = [];
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  for (const node of graph.keys()) color.set(node, WHITE);

  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) return [...stack.slice(stack.indexOf(next)), next];
      if (state === WHITE) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function evaluateLocalImportCycles({ files, facades = COMPATIBILITY_FACADES, roots = null }) {
  const validatedFacades = validateCompatibilityFacades(facades);
  if (!Array.isArray(files)) fail("file inventory must be an array");
  if (roots !== null) {
    if (!Array.isArray(roots) || roots.length === 0) fail("roots must be a non-empty array");
    roots = roots.map((root, index) => safeRelativePath(root, `roots[${index}]`));
  }

  const modules = new Map();
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) fail("file inventory entries must be objects");
    const filePath = safeRelativePath(file.path, `file ${file.path}`);
    if (!filePath.endsWith(".mjs")) continue;
    if (typeof file.source !== "string") fail(`file source must be a string: ${filePath}`);
    if (modules.has(filePath)) fail(`duplicate file inventory entry: ${filePath}`);
    modules.set(filePath, file.source);
  }

  for (const { facade, domain } of validatedFacades) {
    if (!modules.has(facade)) fail(`compatibility facade is missing: ${facade}`);
    if (domain.endsWith(".mjs")) {
      if (!modules.has(domain)) fail(`compatibility domain is missing: ${domain}`);
      continue;
    }
    const hasDomainModule = [...modules.keys()].some((filePath) => inDomain(filePath, domain));
    if (!hasDomainModule) fail(`compatibility domain is missing: ${domain}`);
  }

  const graph = new Map([...modules.keys()].map((filePath) => [filePath, []]));
  const violations = [];
  let edges = 0;
  for (const [filePath, source] of modules) {
    const seen = new Set();
    for (const specifier of localImportSpecifiers(source)) {
      const resolved = resolveLocalSpecifier(filePath, specifier);
      if (!resolved) continue;
      if (!modules.has(resolved)) {
        if (!roots || roots.some((root) => inRoot(resolved, root))) {
          fail(`${filePath} imports missing local module ${resolved}`);
        }
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      graph.get(filePath).push(resolved);
      edges += 1;
      for (const { facade, domain } of validatedFacades) {
        if (inDomain(filePath, domain) && resolved === facade) {
          violations.push(`${filePath} imports its compatibility facade ${facade}`);
        }
      }
    }
  }

  const cycle = firstCycle(graph);
  if (cycle) violations.unshift(`cycle ${cycle.join(" -> ")}`);
  if (violations.length) fail(violations.join("\n"));
  return Object.freeze({
    valid: true,
    modulesChecked: modules.size,
    edges,
    facades: validatedFacades.length,
  });
}

export async function checkRepositoryLocalImportCycles(root = REPOSITORY_ROOT) {
  const configPath = path.join(root, "scripts", "module-boundaries.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    fail(`could not read scripts/module-boundaries.json: ${error.message}`);
  }
  const { roots } = validateModuleBoundaryConfig(config);
  const inventory = await collectModuleBoundaryFiles(root, roots);
  const files = [];
  for (const file of inventory) {
    const absolutePath = path.join(root, ...file.path.split("/"));
    files.push({
      path: file.path,
      source: await readFile(absolutePath, "utf8"),
    });
  }
  return evaluateLocalImportCycles({ files, roots });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  checkRepositoryLocalImportCycles()
    .then((result) => {
      process.stdout.write(
        `local import graph valid; ${result.modulesChecked} modules, ${result.edges} edges, ${result.facades} facades\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
