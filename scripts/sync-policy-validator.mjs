import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_COMMIT } from "../packages/codekeeper/src/constants.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const command = process.argv[2] ?? "--check";
const runtimeRoot = "tools/codekeeper/src/lib";
const installerRoot = path.join(repositoryRoot, "packages/codekeeper/src");

function readPinnedRuntimeFile(file) {
  try {
    return execFileSync(
      "git",
      ["show", `${SOURCE_COMMIT}:${runtimeRoot}/${file}`],
      {
        cwd: repositoryRoot,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  } catch (cause) {
    throw new Error(
      `Could not load ${file} from pinned source commit ${SOURCE_COMMIT}`,
      { cause },
    );
  }
}

const validator = readPinnedRuntimeFile("policy-validator.mjs");
const mirroredFiles = [
  ["policy-validator.mjs", validator],
  ...(validator.includes('from "./label-ownership.mjs"')
    ? [["label-ownership.mjs", readPinnedRuntimeFile("label-ownership.mjs")]]
    : []),
];

if (command === "--write") {
  for (const [file, canonical] of mirroredFiles) {
    await writeFile(path.join(installerRoot, file), canonical);
  }
} else if (command === "--check") {
  for (const [file, canonical] of mirroredFiles) {
    const installer = await readFile(path.join(installerRoot, file));
    if (!installer.equals(canonical)) {
      throw new Error(
        `The installer ${file} does not match pinned source commit ${SOURCE_COMMIT}; run scripts/sync-policy-validator.mjs --write`,
      );
    }
  }
} else {
  throw new Error("Usage: sync-policy-validator.mjs [--check|--write]");
}
