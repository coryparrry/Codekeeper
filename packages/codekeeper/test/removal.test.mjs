import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeManagedPath,
  parseRemovalArgs,
  removalFileEntries
} from "../src/removal.mjs";

test("removal arguments require explicit apply", () => {
  assert.deepEqual(parseRemovalArgs([]), { apply: false, json: false });
  assert.deepEqual(parseRemovalArgs(["--json", "--apply"]), { apply: true, json: true });
  assert.throws(() => parseRemovalArgs(["--force"]), /Unsupported remove option/);
});

test("managed paths reject traversal, absolute paths, empty components, and backslashes", () => {
  assert.equal(assertSafeManagedPath(".github/codekeeper.json"), ".github/codekeeper.json");
  for (const value of ["../secret", "/tmp/file", ".github//file", ".github\\file", "./.github/file"]) {
    assert.throws(() => assertSafeManagedPath(value), /unsafe managed path/);
  }
});

test("removal inventory requires policy and workflow ownership and appends the release manifest", () => {
  const entries = removalFileEntries({
    managedFiles: {
      ".github/codekeeper.json": "a".repeat(64),
      ".github/workflows/codekeeper-review.yml": "b".repeat(64),
      ".github/codekeeper/agents/pr-reviewer.md": "c".repeat(64)
    }
  });
  assert.deepEqual(entries, [
    { path: ".github/codekeeper-release.json", sha256: null },
    { path: ".github/codekeeper.json", sha256: "a".repeat(64) },
    { path: ".github/codekeeper/agents/pr-reviewer.md", sha256: "c".repeat(64) },
    { path: ".github/workflows/codekeeper-review.yml", sha256: "b".repeat(64) }
  ]);
});

test("removal refuses malformed or incomplete release manifests", () => {
  assert.throws(() => removalFileEntries({ managedFiles: {} }), /empty or duplicate/);
  assert.throws(
    () => removalFileEntries({ managedFiles: { ".github/codekeeper.json": "a".repeat(64) } }),
    /does not own any Codekeeper workflow/
  );
  assert.throws(
    () => removalFileEntries({
      managedFiles: {
        ".github/codekeeper.json": "nope",
        ".github/workflows/codekeeper-review.yml": "b".repeat(64)
      }
    }),
    /invalid digest/
  );
});
