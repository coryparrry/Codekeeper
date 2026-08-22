import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "../..");

async function canonicalRuntimeFile(file) {
  return readFile(path.join(repositoryRoot, "tools/codekeeper/src/lib", file));
}

test("the installer ships the current runtime policy validator byte for byte", async () => {
  const validator = await canonicalRuntimeFile("policy-validator.mjs");
  assert.deepEqual(
    await readFile(path.join(packageRoot, "src/policy-validator.mjs")),
    validator,
  );
  if (validator.includes('from "./label-ownership.mjs"')) {
    assert.deepEqual(
      await readFile(path.join(packageRoot, "src/label-ownership.mjs")),
      await canonicalRuntimeFile("label-ownership.mjs"),
    );
  }
});
