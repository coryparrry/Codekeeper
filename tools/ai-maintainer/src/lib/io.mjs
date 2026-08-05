import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readRegularFile(filePath) {
  const information = await lstat(filePath);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Expected a regular file: ${filePath}`);
  }
  return readFile(filePath);
}

export async function readRegularJson(filePath) {
  const text = (await readRegularFile(filePath)).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

export async function readOptionalRegularJson(filePath) {
  try {
    return await readRegularJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
  }
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

export function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, "true");
    }
  }
  return {
    positional,
    flags,
    get(name, fallback = undefined) {
      return flags.has(name) ? flags.get(name) : fallback;
    },
    require(name) {
      const value = flags.get(name);
      if (value === undefined || value === "") {
        throw new Error(`Missing required argument --${name}`);
      }
      return value;
    },
    boolean(name, fallback = false) {
      if (!flags.has(name)) return fallback;
      const value = String(flags.get(name)).trim().toLowerCase();
      return !["false", "0", "no", "off", ""].includes(value);
    }
  };
}

export function setGitHubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const normalized = value === undefined || value === null ? "" : String(value);
  const delimiter = `AI_MAINTAINER_${Math.random().toString(16).slice(2)}`;
  const payload = `${name}<<${delimiter}\n${normalized}\n${delimiter}\n`;
  return import("node:fs").then(({ appendFileSync }) => appendFileSync(outputPath, payload));
}

export function log(message, details = undefined) {
  if (details === undefined) {
    console.log(`[ai-maintainer] ${message}`);
  } else {
    console.log(`[ai-maintainer] ${message}`, details);
  }
}

export function warn(message) {
  console.warn(`::warning::${message}`);
}
