import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

test("the installer ships the canonical runtime policy validator byte for byte", async () => {
  const [runtime, installer] = await Promise.all([
    readFile(path.join(repositoryRoot, "tools/codekeeper/src/lib/policy-validator.mjs")),
    readFile(path.join(packageRoot, "src/policy-validator.mjs"))
  ]);
  assert.deepEqual(installer, runtime);
});
