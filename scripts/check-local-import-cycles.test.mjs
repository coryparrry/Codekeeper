import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPATIBILITY_FACADES,
  checkRepositoryLocalImportCycles,
  evaluateLocalImportCycles,
  localImportSpecifiers,
} from "./check-local-import-cycles.mjs";

const facades = Object.freeze([
  Object.freeze({ facade: "src/github.mjs", domain: "src/github" }),
]);

function files(entries) {
  return Object.entries(entries).map(([pathName, source]) => ({ path: pathName, source }));
}

test("compatibility facades are the recorded public module map", () => {
  assert.deepEqual(COMPATIBILITY_FACADES, []);
});

test("current tree has no local import cycles or facade back-imports", async () => {
  const result = await checkRepositoryLocalImportCycles();
  assert.equal(result.valid, true);
  assert.equal(result.facades, COMPATIBILITY_FACADES.length);
  assert.ok(result.modulesChecked > result.facades);
  assert.ok(result.edges > 0);
});

test("acyclic facade-to-domain imports are allowed", () => {
  assert.deepEqual(
    evaluateLocalImportCycles({
      facades,
      files: files({
        "src/github.mjs": "export { GitHubClient } from \"./github/index.mjs\";\n",
        "src/github/index.mjs": "export { GitHubClient } from \"./client.mjs\";\n",
        "src/github/client.mjs": "export class GitHubClient {}\n",
      }),
    }),
    { valid: true, modulesChecked: 3, edges: 2, facades: 1 },
  );
});

test("a local import cycle fails closed", () => {
  assert.throws(
    () =>
      evaluateLocalImportCycles({
        facades,
        files: files({
          "src/github.mjs": "export { GitHubClient } from \"./github/index.mjs\";\n",
          "src/github/index.mjs": "export { helper } from \"./client.mjs\";\n",
          "src/github/client.mjs": "export { helper } from \"./index.mjs\";\n",
        }),
      }),
    /cycle src\/github\/index\.mjs -> src\/github\/client\.mjs -> src\/github\/index\.mjs/,
  );
});

test("a domain module cannot import its compatibility facade", () => {
  assert.throws(
    () =>
      evaluateLocalImportCycles({
        facades,
        files: files({
          "src/github.mjs": "export { GitHubClient } from \"./github/index.mjs\";\n",
          "src/github/index.mjs": "export { GitHubClient } from \"./client.mjs\";\n",
          "src/github/client.mjs": "import { GitHubClient } from \"../github.mjs\";\nexport { GitHubClient };\n",
        }),
      }),
    /src\/github\/client\.mjs imports its compatibility facade src\/github\.mjs/,
  );
});

test("domain modules may import a different facade", () => {
  assert.deepEqual(
    evaluateLocalImportCycles({
      facades: [
        { facade: "src/github.mjs", domain: "src/github" },
        { facade: "src/publish.mjs", domain: "src/publish" },
      ],
      files: files({
        "src/github.mjs": "export { GitHubClient } from \"./github/index.mjs\";\n",
        "src/github/index.mjs": "export class GitHubClient {}\n",
        "src/publish.mjs": "export { publishReview } from \"./publish/review.mjs\";\n",
        "src/publish/review.mjs": "import { GitHubClient } from \"../github.mjs\";\nexport function publishReview() { return GitHubClient; }\n",
      }),
    }),
    { valid: true, modulesChecked: 4, edges: 3, facades: 2 },
  );
});

test("unresolved local imports fail closed", () => {
  assert.throws(
    () =>
      evaluateLocalImportCycles({
        facades,
        files: files({
          "src/github.mjs": "export { GitHubClient } from \"./github/missing.mjs\";\n",
          "src/github/index.mjs": "export const ok = true;\n",
        }),
      }),
    /src\/github\.mjs imports missing local module src\/github\/missing\.mjs/,
  );
});

test("node builtins and package imports are ignored", () => {
  assert.deepEqual(
    localImportSpecifiers(
      "import fs from \"node:fs\";\nimport path from \"path\";\nexport { GitHubClient } from \"./github/index.mjs\";\n",
    ),
    ["./github/index.mjs"],
  );
  assert.deepEqual(
    evaluateLocalImportCycles({
      facades,
      files: files({
        "src/github.mjs": "import fs from \"node:fs\";\nexport { GitHubClient } from \"./github/index.mjs\";\n",
        "src/github/index.mjs": "export class GitHubClient {}\n",
      }),
    }),
    { valid: true, modulesChecked: 2, edges: 1, facades: 1 },
  );
});

test("commented imports are not edges", () => {
  assert.deepEqual(
    localImportSpecifiers("export { GitHubClient } from \"./github/index.mjs\";\n// import \"./dead.mjs\";\n"),
    ["./github/index.mjs"],
  );
});

test("import-looking strings, templates, and regular expressions are not edges", () => {
  assert.deepEqual(
    localImportSpecifiers([
      "const stringExample = 'import \\\"./string-example.mjs\\\";';",
      "const templateExample = `export { value } from './template-example.mjs';`;",
      "const pattern = /import\\s+\\\"\\.\\/regex-example\\.mjs\\\"/;",
      "export { GitHubClient } from './github/index.mjs';"
    ].join("\n")),
    ["./github/index.mjs"],
  );
});

test("configured facade files fail closed when missing", () => {
  assert.throws(
    () => evaluateLocalImportCycles({ facades, files: files({ "src/ok.mjs": "export const ok = true;\n" }) }),
    /compatibility facade is missing: src\/github\.mjs/,
  );
});
