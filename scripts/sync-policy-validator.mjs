import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const command = process.argv[2] ?? "--check";
const runtimeRoot = path.join(repositoryRoot, "tools/codekeeper/src/lib");
const installerRoot = path.join(repositoryRoot, "packages/codekeeper/src");

async function readCanonicalRuntimeFile(file) {
  try {
    return await readFile(path.join(runtimeRoot, file));
  } catch (cause) {
    throw new Error(`Could not load canonical runtime ${file}`, { cause });
  }
}

const validator = await readCanonicalRuntimeFile("policy-validator.mjs");
const mirroredFiles = [
  ["policy-validator.mjs", validator],
  ...(validator.includes('from "./label-ownership.mjs"')
    ? [["label-ownership.mjs", await readCanonicalRuntimeFile("label-ownership.mjs")]]
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
        `The installer ${file} does not match tools/codekeeper/src/lib/${file}; run scripts/sync-policy-validator.mjs --write`,
      );
    }
  }
} else {
  throw new Error("Usage: sync-policy-validator.mjs [--check|--write]");
}
