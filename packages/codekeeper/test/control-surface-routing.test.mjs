import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("package entry point lazy-loads the control surface", async () => {
  const source = await readFile(path.join(root, "bin/codekeeper.mjs"), "utf8");
  assert.match(source, /\["status", "explain", "plan"\]\.includes\(argv\[0\]\)/);
  assert.match(source, /await import\("\.\.\/src\/control-surface\.mjs"\)/);
  assert.doesNotMatch(source, /^import .*control-surface/m);
});
