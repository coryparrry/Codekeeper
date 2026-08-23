import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MIRRORED_HELPERS,
  checkMirroredHelpers,
  validateMirroredHelperInventory,
  writeMirroredHelpers,
} from "./sync-mirrored-helpers.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABEL_OWNERSHIP = Object.freeze({
  canonical: "tools/codekeeper/src/lib/label-ownership.mjs",
  published: "packages/codekeeper/src/label-ownership.mjs",
});
const POLICY_NORMALIZATION = Object.freeze({
  canonical: "tools/codekeeper/src/lib/policy-normalization.mjs",
  published: "packages/codekeeper/src/policy-normalization.mjs",
});

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-mirrored-helpers-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (contents && typeof contents === "object" && contents.symlink) {
      await symlink(contents.symlink, absolutePath);
      continue;
    }
    await writeFile(absolutePath, contents);
  }
  return root;
}

test("default inventory is the proven helper mirror pairs", () => {
  assert.deepEqual(MIRRORED_HELPERS, [LABEL_OWNERSHIP, POLICY_NORMALIZATION]);
  assert.deepEqual(validateMirroredHelperInventory(MIRRORED_HELPERS), [LABEL_OWNERSHIP, POLICY_NORMALIZATION]);
});

test("current worktree copies stay byte-identical", async () => {
  const result = await checkMirroredHelpers();
  assert.deepEqual(result, { valid: true, helpersChecked: 2 });
});

test("published installer helper remains a physical copy", async () => {
  const canonical = await readFile(path.join(REPOSITORY_ROOT, LABEL_OWNERSHIP.canonical));
  const published = await readFile(path.join(REPOSITORY_ROOT, LABEL_OWNERSHIP.published));
  assert.deepEqual(published, canonical);
  assert.doesNotMatch(published.toString("utf8"), /from\s+["'](?:\.\.\/)+tools\//);
  assert.notEqual(
    path.resolve(REPOSITORY_ROOT, LABEL_OWNERSHIP.published),
    path.resolve(REPOSITORY_ROOT, LABEL_OWNERSHIP.canonical),
  );
});

test("check fails when a published helper drifts", async (context) => {
  const root = await fixture({
    [LABEL_OWNERSHIP.canonical]: "export const canonical = true;\n",
    [LABEL_OWNERSHIP.published]: "export const drifted = true;\n",
    [POLICY_NORMALIZATION.canonical]: "export const canonical = true;\n",
    [POLICY_NORMALIZATION.published]: "export const drifted = true;\n",
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    checkMirroredHelpers({ root }),
    /packages\/codekeeper\/src\/label-ownership\.mjs does not match canonical tools\/codekeeper\/src\/lib\/label-ownership\.mjs; run scripts\/sync-mirrored-helpers\.mjs --write/,
  );
});

test("write restores a drifted published helper from the runtime copy", async (context) => {
  const canonical = "export function isCodekeeperOwnedLabel(label) {\n  return true;\n}\n";
  const root = await fixture({
    [LABEL_OWNERSHIP.canonical]: canonical,
    [LABEL_OWNERSHIP.published]: "export const drifted = true;\n",
    [POLICY_NORMALIZATION.canonical]: "export const normalized = true;\n",
    [POLICY_NORMALIZATION.published]: "export const drifted = true;\n",
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await writeMirroredHelpers({ root }), { written: 2 });
  assert.deepEqual(await checkMirroredHelpers({ root }), { valid: true, helpersChecked: 2 });
});

test("missing helpers fail closed", async (context) => {
  const root = await fixture({
    [LABEL_OWNERSHIP.canonical]: "export const canonical = true;\n",
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    checkMirroredHelpers({ root }),
    /published helper is missing: packages\/codekeeper\/src\/label-ownership\.mjs/,
  );
  await assert.rejects(
    checkMirroredHelpers({
      root,
      mirrors: [{ canonical: "tools/codekeeper/src/lib/missing.mjs", published: LABEL_OWNERSHIP.published }],
    }),
    /canonical helper is missing: tools\/codekeeper\/src\/lib\/missing\.mjs/,
  );
});

test("symlinked helpers fail closed", async (context) => {
  const root = await fixture({
    [LABEL_OWNERSHIP.canonical]: "export const canonical = true;\n",
    "packages/codekeeper/src/other.mjs": "export const other = true;\n",
    [LABEL_OWNERSHIP.published]: { symlink: "other.mjs" },
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    checkMirroredHelpers({ root }),
    /published helper is a symlink: packages\/codekeeper\/src\/label-ownership\.mjs/,
  );
  await assert.rejects(
    writeMirroredHelpers({ root }),
    /published helper is a symlink: packages\/codekeeper\/src\/label-ownership\.mjs/,
  );
});

test("unsafe, duplicate, and cross-package inventory entries fail closed", () => {
  assert.throws(
    () =>
      validateMirroredHelperInventory([
        { canonical: "../secret.mjs", published: LABEL_OWNERSHIP.published },
      ]),
    /safe repository-relative path/,
  );
  assert.throws(
    () =>
      validateMirroredHelperInventory([
        { canonical: LABEL_OWNERSHIP.canonical, published: "packages/other/src/label-ownership.mjs" },
      ]),
    /published helper is outside the installer package/,
  );
  assert.throws(
    () =>
      validateMirroredHelperInventory([
        { canonical: "packages/codekeeper/src/label-ownership.mjs", published: LABEL_OWNERSHIP.published },
      ]),
    /canonical helper is outside the runtime package/,
  );
  assert.throws(
    () => validateMirroredHelperInventory([LABEL_OWNERSHIP, LABEL_OWNERSHIP]),
    /duplicate canonical helper/,
  );
});
