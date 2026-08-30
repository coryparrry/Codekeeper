import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkRepositoryModuleBoundaries,
  evaluateModuleBoundaries,
} from "./check-module-boundaries.mjs";

function config(overrides = {}) {
  return {
    version: 1,
    newModuleMaxLines: 800,
    newModuleMaxBytes: 40000,
    newTestMaxLines: 1000,
    newTestMaxBytes: 60000,
    roots: ["src", "test"],
    legacy: {
      "src/legacy.mjs": { maxLines: 1200, maxBytes: 50000 },
    },
    ...overrides,
  };
}

const validFiles = Object.freeze([
  { path: "src/legacy.mjs", bytes: 50000, lines: 1200 },
  { path: "src/new.mjs", bytes: 20000, lines: 500 },
  { path: "test/new.test.mjs", bytes: 10000, lines: 200 },
]);

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-module-boundaries-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (contents && typeof contents === "object" && contents.symlink) {
      await symlink(contents.symlink, absolutePath);
      continue;
    }
    await writeFile(absolutePath, contents, "utf8");
  }
  return root;
}

test("valid current tree satisfies recorded module boundaries", async () => {
  const result = await checkRepositoryModuleBoundaries();
  assert.equal(result.valid, true);
  assert.equal(result.legacyModules, 3);
  assert.ok(result.modulesChecked > result.legacyModules);
});

test("legacy modules cannot grow", () => {
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: validFiles.map((file) => (file.path === "src/legacy.mjs" ? { ...file, bytes: 50001 } : file)),
      }),
    /grew from its legacy 50000-byte ceiling/,
  );
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: validFiles.map((file) => (file.path === "src/legacy.mjs" ? { ...file, lines: 1201 } : file)),
      }),
    /grew from its legacy 1200-line ceiling/,
  );
  assert.deepEqual(
    evaluateModuleBoundaries({
      config: config(),
      files: validFiles.map((file) =>
        file.path === "src/legacy.mjs" ? { ...file, bytes: 49999, lines: 1199 } : file,
      ),
    }),
    { valid: true, modulesChecked: 3, legacyModules: 1 },
  );
});

test("new implementation modules over the line limit fail", () => {
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: [validFiles[0], { path: "src/new.mjs", bytes: 1000, lines: 801 }, validFiles[2]],
      }),
    /src\/new\.mjs has 801 lines; new modules are limited to 800/,
  );
});

test("new implementation modules over the byte limit fail", () => {
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: [validFiles[0], { path: "src/new.mjs", bytes: 40001, lines: 10 }, validFiles[2]],
      }),
    /src\/new\.mjs has 40001 bytes; new modules are limited to 40000/,
  );
});

test("oversized new tests fail", () => {
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: [validFiles[0], validFiles[1], { path: "test/new.test.mjs", bytes: 1000, lines: 1001 }],
      }),
    /test\/new\.test\.mjs has 1001 lines; new tests are limited to 1000/,
  );
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: [validFiles[0], validFiles[1], { path: "test/new.test.mjs", bytes: 60001, lines: 10 }],
      }),
    /test\/new\.test\.mjs has 60001 bytes; new tests are limited to 60000/,
  );
});

test("unsafe paths are rejected", () => {
  assert.throws(
    () => evaluateModuleBoundaries({ config: config({ roots: ["../src"] }), files: validFiles }),
    /safe repository-relative path/,
  );
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: [{ path: "src/../secret.mjs", bytes: 1, lines: 1 }],
      }),
    /safe repository-relative path/,
  );
});

test("duplicate inventory and legacy entries fail closed", () => {
  assert.throws(
    () => evaluateModuleBoundaries({ config: config(), files: [validFiles[0], validFiles[0]] }),
    /duplicate file inventory/,
  );
  assert.throws(
    () => evaluateModuleBoundaries({ config: config({ roots: ["src", "src"] }), files: validFiles }),
    /roots must not contain duplicates/,
  );
});

test("missing legacy modules fail closed", () => {
  assert.throws(
    () => evaluateModuleBoundaries({ config: config(), files: validFiles.slice(1) }),
    /legacy module is missing: src\/legacy\.mjs/,
  );
});

test("completed legacy exemptions must be removed", () => {
  assert.throws(
    () =>
      evaluateModuleBoundaries({
        config: config(),
        files: validFiles.map((file) =>
          file.path === "src/legacy.mjs" ? { ...file, bytes: 20000, lines: 500 } : file,
        ),
      }),
    /src\/legacy\.mjs is within the normal 800-line\/40000-byte limit; remove its legacy exemption/,
  );
});

test("symlinks in scanned roots fail closed", async (context) => {
  const root = await fixture({
    "scripts/module-boundaries.json": `${JSON.stringify(
      {
        version: 1,
        newModuleMaxLines: 800,
        newModuleMaxBytes: 40000,
        newTestMaxLines: 1000,
        newTestMaxBytes: 60000,
        roots: ["src"],
        legacy: {},
      },
      null,
      2,
    )}\n`,
    "src/ok.mjs": "export const ok = true;\n",
    "src/link.mjs": { symlink: "ok.mjs" },
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(checkRepositoryModuleBoundaries(root), /source root contains a symlink: src\/link\.mjs/);
});
