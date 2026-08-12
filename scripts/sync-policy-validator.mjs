import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPath = path.join(repositoryRoot, "tools/codekeeper/src/lib/policy-validator.mjs");
const installerPath = path.join(repositoryRoot, "packages/codekeeper/src/policy-validator.mjs");
const command = process.argv[2] ?? "--check";
const canonical = await readFile(canonicalPath);

if (command === "--write") {
  await writeFile(installerPath, canonical);
} else if (command === "--check") {
  const installer = await readFile(installerPath);
  if (!installer.equals(canonical)) {
    throw new Error("The installer policy validator is not the canonical runtime validator; run scripts/sync-policy-validator.mjs --write");
  }
} else {
  throw new Error("Usage: sync-policy-validator.mjs [--check|--write]");
}
