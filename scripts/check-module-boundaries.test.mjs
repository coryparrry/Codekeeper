import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModuleBoundaries } from "./check-module-boundaries.mjs";

const config = Object.freeze({
  version: 1,
  newModuleMaxLines: 800,
  newModuleMaxBytes: 40000,
  roots: ["src"],
  legacy: {
    "src/legacy.mjs": { maxBytes: 50000 }
  }
});

const validFiles = Object.freeze([
  { path: "src/legacy.mjs", bytes: 50000, lines: 1200 },
  { path: "src/new.mjs", bytes: 20000, lines: 500 }
]);

test("legacy ceilings and bounded new modules pass", () => {
  assert.deepEqual(evaluateModuleBoundaries({ config, files: validFiles }), {
    valid: true,
    modulesChecked: 2,
    legacyModules: 1
  });
});

test("legacy modules cannot grow", () => {
  assert.throws(
    () => evaluateModuleBoundaries({
      config,
      files: validFiles.map((file) => file.path === "src/legacy.mjs" ? { ...file, bytes: 50001 } : file)
    }),
    /grew from its legacy 50000-byte ceiling/
  );
});

test("new modules must remain below line and byte budgets", () => {
  assert.throws(
    () => evaluateModuleBoundaries({
      config,
      files: [
        validFiles[0],
        { path: "src/new.mjs", bytes: 40001, lines: 801 }
      ]
    }),
    /new modules are limited to 800/
  );
});

test("missing legacy modules and duplicate inventory fail closed", () => {
  assert.throws(
    () => evaluateModuleBoundaries({ config, files: [validFiles[1]] }),
    /legacy module is missing/
  );
  assert.throws(
    () => evaluateModuleBoundaries({ config, files: [validFiles[0], validFiles[0]] }),
    /duplicate file inventory/
  );
});

test("unsafe paths and malformed legacy limits are rejected", () => {
  assert.throws(
    () => evaluateModuleBoundaries({ config: { ...config, roots: ["../src"] }, files: validFiles }),
    /safe repository-relative path/
  );
  assert.throws(
    () => evaluateModuleBoundaries({
      config: { ...config, legacy: { "src/legacy.mjs": { maxBytes: 1, extra: true } } },
      files: validFiles
    }),
    /must contain one positive maxBytes/
  );
});
