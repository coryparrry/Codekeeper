import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_COMMANDS } from "../src/lib/owner-commands.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "../../..");
export const TARGETS = Object.freeze([
  "examples/workflows/codekeeper-assistant.yml.example",
  "examples/workflows/codekeeper-review.yml.example",
  "packages/codekeeper/assets/workflows/review.yml",
  ".github/workflows/codekeeper-review.yml",
  ".github/workflows/codekeeper-issues.yml",
]);

const START_MARKER = "CODEKEEPER_OWNER_COMMANDS_START";
const END_MARKER = "CODEKEEPER_OWNER_COMMANDS_END";

function commandJson() {
  return JSON.stringify(OWNER_COMMANDS);
}

function slashCommandJson() {
  return JSON.stringify(
    OWNER_COMMANDS.map((command) => `/codekeeper ${command}`),
  );
}

function markerBlock(source, relativePath) {
  const pattern = new RegExp(
    `^([ \\t]*)(//|#) ${START_MARKER}[^\\n]*\\n[\\s\\S]*?^([ \\t]*)(//|#) ${END_MARKER}[^\\n]*(?:\\n|$)`,
    "m",
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(
      `${relativePath} is missing the ${START_MARKER}/${END_MARKER} markers`,
    );
  }
  const duplicates = source.match(new RegExp(START_MARKER, "g")) ?? [];
  if (duplicates.length !== 1) {
    throw new Error(
      `${relativePath} must contain exactly one owner-command marker block`,
    );
  }
  return { match, pattern };
}

function renderActionList(source, relativePath) {
  const { match, pattern } = markerBlock(source, relativePath);
  const replacement = [
    `${match[1]}${match[2]} ${START_MARKER}`,
    `${match[1]}const actions = ${commandJson()};`,
    `${match[3]}${match[4]} ${END_MARKER}`,
    "",
  ].join("\n");
  return source.replace(pattern, replacement);
}

function renderReviewCondition(source, relativePath) {
  const { match, pattern } = markerBlock(source, relativePath);
  const block = match[0];
  const conditionPattern =
    /contains\(fromJSON\('[^']*'\), github\.event\.comment\.body\)(\))?/g;
  const matches = block.match(conditionPattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `${relativePath} must contain exactly one generated review command condition`,
    );
  }
  return source.replace(
    pattern,
    block.replace(
      conditionPattern,
      (_full, extraParen = "") =>
        `contains(fromJSON('${slashCommandJson()}'), github.event.comment.body)${extraParen}`,
    ),
  );
}

export function renderSource(source, relativePath) {
  if (relativePath.startsWith(".github/workflows/")) {
    return renderReviewCondition(source, relativePath);
  }
  if (relativePath.endsWith("codekeeper-review.yml.example") || relativePath.endsWith("assets/workflows/review.yml")) {
    return renderReviewCondition(source, relativePath);
  }
  return renderActionList(source, relativePath);
}

export async function synchronize({
  write = false,
  root = repositoryRoot,
} = {}) {
  const changes = [];
  for (const relativePath of TARGETS) {
    const filePath = path.join(root, relativePath);
    const current = await readFile(filePath, "utf8");
    const expected = renderSource(current, relativePath);
    if (current === expected) continue;
    changes.push(relativePath);
    if (write) await writeFile(filePath, expected, "utf8");
  }
  return changes;
}

async function main() {
  const command = process.argv[2];
  if (command !== "--check" && command !== "--write") {
    throw new Error("Usage: sync-owner-command-lists.mjs [--check|--write]");
  }
  const changes = await synchronize({ write: command === "--write" });
  if (command === "--check" && changes.length > 0) {
    throw new Error(
      `owner-command lists are out of date: ${changes.join(", ")}`,
    );
  }
  if (command === "--write" && changes.length > 0) {
    process.stdout.write(`updated ${changes.join(", ")}\n`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`sync-owner-command-lists: ${error.message}\n`);
    process.exitCode = 1;
  });
}
