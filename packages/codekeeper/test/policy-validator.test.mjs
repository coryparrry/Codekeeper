import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_COMMIT } from "../src/constants.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "../..");

function pinnedRuntimeFile(file) {
  return execFileSync(
    "git",
    ["show", `${SOURCE_COMMIT}:tools/codekeeper/src/lib/${file}`],
    { cwd: repositoryRoot },
  );
}

test("the installer ships the pinned runtime policy validator byte for byte", async () => {
  const validator = pinnedRuntimeFile("policy-validator.mjs");
  assert.deepEqual(
    await readFile(path.join(packageRoot, "src/policy-validator.mjs")),
    validator,
  );
  if (validator.includes('from "./label-ownership.mjs"')) {
    assert.deepEqual(
      await readFile(path.join(packageRoot, "src/label-ownership.mjs")),
      pinnedRuntimeFile("label-ownership.mjs"),
    );
  }
});
