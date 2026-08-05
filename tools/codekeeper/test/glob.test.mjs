import test from "node:test";
import assert from "node:assert/strict";
import { matchesGlob, matchesAny } from "../src/lib/glob.mjs";

test("glob matcher handles repository paths", () => {
  assert.equal(matchesGlob("docs/architecture.md", "docs/**"), true);
  assert.equal(matchesGlob("README.md", "*.md"), true);
  assert.equal(matchesGlob("src/App.swift", "**/*.swift"), true);
  assert.equal(matchesGlob("src/App.swift", "docs/**"), false);
  assert.equal(matchesGlob("Nested/README.md", "*.md"), false);
  assert.equal(matchesAny(".github/workflows/ci.yml", [".github/**", "docs/**"]), true);
});
