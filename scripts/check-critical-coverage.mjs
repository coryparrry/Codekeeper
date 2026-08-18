#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const METRICS = Object.freeze(["lines", "branches", "functions"]);

function fail(message) {
  throw new Error(`Critical coverage gate failed: ${message}`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--report", "--config"].includes(flag) || !value || value.startsWith("--")) {
      fail("usage: check-critical-coverage.mjs --report FILE --config FILE");
    }
    if (values.has(flag)) fail(`${flag} was provided more than once`);
    values.set(flag, value);
    index += 1;
  }
  if (values.size !== 2) fail("--report and --config are required");
  return {
    report: path.resolve(values.get("--report")),
    config: path.resolve(values.get("--config")),
  };
}

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function coverageRow(line) {
  const normalized = stripAnsi(line).replace(/^\s*ℹ\s?/, "");
  if (!normalized.includes("|")) return null;
  const cells = normalized.split("|");
  if (cells.length < 4) return null;
  const rawName = cells[0];
  const name = rawName.trim();
  if (!name || name === "file" || /^-+$/.test(name)) return null;
  const numeric = cells.slice(1, 4).map((cell) => {
    const value = cell.trim();
    return value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
  });
  return {
    name,
    indent: rawName.match(/^\s*/)?.[0].length ?? 0,
    lines: numeric[0],
    branches: numeric[1],
    functions: numeric[2],
  };
}

export function parseCoverageReport(report) {
  const files = new Map();
  const directories = [];
  for (const line of String(report).split(/\r?\n/)) {
    const row = coverageRow(line);
    if (!row || row.name === "all files") continue;
    const isDirectory = METRICS.every((metric) => row[metric] === null);
    while (directories.length > 0 && directories.at(-1).indent >= row.indent) {
      directories.pop();
    }
    if (isDirectory) {
      directories.push({ indent: row.indent, name: row.name });
      continue;
    }
    if (METRICS.some((metric) => row[metric] === null)) continue;
    const prefix = directories.filter((item) => item.indent < row.indent).map((item) => item.name);
    const filePath = [...prefix, row.name].join("/");
    files.set(filePath, Object.freeze({
      lines: row.lines,
      branches: row.branches,
      functions: row.functions,
    }));
  }
  if (files.size === 0) fail("coverage report contains no file rows");
  return files;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || config.version !== 1) {
    fail("config must be a version 1 object");
  }
  if (!config.files || typeof config.files !== "object" || Array.isArray(config.files)) {
    fail("config.files must be an object");
  }
  const entries = Object.entries(config.files);
  if (entries.length === 0) fail("config.files must not be empty");
  for (const [file, thresholds] of entries) {
    if (!file || file.includes("\\") || file.startsWith("/") || file.split("/").some((part) => !part || part === "." || part === "..")) {
      fail(`config contains unsafe file path ${file}`);
    }
    if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds)) {
      fail(`thresholds for ${file} must be an object`);
    }
    if (Object.keys(thresholds).length !== METRICS.length || METRICS.some((metric) => !Object.hasOwn(thresholds, metric))) {
      fail(`thresholds for ${file} must define lines, branches, and functions exactly`);
    }
    for (const metric of METRICS) {
      const value = thresholds[metric];
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        fail(`${file}.${metric} must be between 0 and 100`);
      }
    }
  }
  return entries;
}

export function evaluateCoverageGates(report, config) {
  const files = parseCoverageReport(report);
  const failures = [];
  const checked = [];
  for (const [file, thresholds] of validateConfig(config)) {
    const actual = files.get(file);
    if (!actual) {
      failures.push(`${file}: missing from coverage report`);
      continue;
    }
    checked.push(file);
    for (const metric of METRICS) {
      if (actual[metric] + Number.EPSILON < thresholds[metric]) {
        failures.push(`${file}.${metric}: ${actual[metric].toFixed(2)} < ${thresholds[metric].toFixed(2)}`);
      }
    }
  }
  return Object.freeze({ checked: Object.freeze(checked), failures: Object.freeze(failures) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [report, configText] = await Promise.all([
    readFile(args.report, "utf8"),
    readFile(args.config, "utf8"),
  ]);
  let config;
  try {
    config = JSON.parse(configText);
  } catch (error) {
    fail(`config is invalid JSON: ${error.message}`);
  }
  const result = evaluateCoverageGates(report, config);
  if (result.failures.length > 0) fail(result.failures.join("; "));
  process.stdout.write(`critical coverage gates passed for ${result.checked.length} files\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
