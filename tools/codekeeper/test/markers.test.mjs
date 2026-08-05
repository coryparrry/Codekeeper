import test from "node:test";
import assert from "node:assert/strict";
import { findingFingerprint, findingMarker } from "../src/lib/markers.mjs";

test("finding fingerprints are stable across presentation changes", () => {
  const base = {
    title: "Docs describe a removed command",
    category: "docs",
    problemKey: "removed-command",
    owningPath: "docs/README.md"
  };
  const changedTitle = { ...base, title: "The docs still describe a removed command" };
  assert.equal(findingFingerprint(base), findingFingerprint(changedTitle));
  assert.match(findingMarker(findingFingerprint(base)), /^<!-- codekeeper:fingerprint=[a-f0-9]{64} -->$/);
});

test("finding fingerprints retain full structured identity fields", () => {
  const common = { category: "docs", owningPath: "README.md" };
  const first = { ...common, problemKey: `same-${"a".repeat(240)}-first` };
  const second = { ...common, problemKey: `same-${"a".repeat(240)}-second` };
  assert.notEqual(findingFingerprint(first), findingFingerprint(second));
});
