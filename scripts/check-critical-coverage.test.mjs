import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCoverageGates, parseCoverageReport } from "./check-critical-coverage.mjs";

const REPORT = `
ℹ --------------------------------------------------------------------
ℹ file                     | line % | branch % | funcs % | uncovered lines
ℹ --------------------------------------------------------------------
ℹ src                      |        |          |         |
ℹ  cli.mjs                 |  64.97 |    20.51 |   63.64 | 24-28
ℹ  lib                     |        |          |         |
ℹ   github-core.mjs        |  86.92 |    76.33 |   87.50 | 17-19
ℹ   publish.mjs            |  91.11 |    77.74 |   93.83 | 46-47
ℹ all files                |  88.84 |    74.69 |   91.12 |
`;

test("parses nested Node coverage table paths", () => {
  assert.deepEqual(Object.fromEntries(parseCoverageReport(REPORT)), {
    "src/cli.mjs": { lines: 64.97, branches: 20.51, functions: 63.64 },
    "src/lib/github-core.mjs": { lines: 86.92, branches: 76.33, functions: 87.5 },
    "src/lib/publish.mjs": { lines: 91.11, branches: 77.74, functions: 93.83 },
  });
});

test("passes when every critical file meets its ratchet", () => {
  const result = evaluateCoverageGates(REPORT, {
    version: 1,
    files: {
      "src/lib/github-core.mjs": { lines: 85, branches: 75, functions: 85 },
      "src/lib/publish.mjs": { lines: 90, branches: 75, functions: 90 },
    },
  });
  assert.deepEqual(result, {
    checked: ["src/lib/github-core.mjs", "src/lib/publish.mjs"],
    failures: [],
  });
});

test("reports exact metric regressions", () => {
  const result = evaluateCoverageGates(REPORT, {
    version: 1,
    files: {
      "src/lib/github-core.mjs": { lines: 90, branches: 80, functions: 90 },
    },
  });
  assert.deepEqual(result.failures, [
    "src/lib/github-core.mjs.lines: 86.92 < 90.00",
    "src/lib/github-core.mjs.branches: 76.33 < 80.00",
    "src/lib/github-core.mjs.functions: 87.50 < 90.00",
  ]);
});

test("fails closed when a configured file disappears", () => {
  const result = evaluateCoverageGates(REPORT, {
    version: 1,
    files: {
      "src/lib/missing.mjs": { lines: 1, branches: 1, functions: 1 },
    },
  });
  assert.deepEqual(result.failures, ["src/lib/missing.mjs: missing from coverage report"]);
});

test("rejects malformed threshold configuration", () => {
  assert.throws(
    () => evaluateCoverageGates(REPORT, {
      version: 1,
      files: { "../escape.mjs": { lines: 1, branches: 1, functions: 1 } },
    }),
    /unsafe file path/,
  );
});
