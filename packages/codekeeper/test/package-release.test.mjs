import assert from "node:assert/strict";
import test from "node:test";
import { isReleaseVersion } from "../src/package-release.mjs";

test("release versions accept semantic versions used by package receipts", () => {
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3-alpha-1+build.05"
  ]) {
    assert.equal(isReleaseVersion(version), true, version);
  }
});

test("release versions reject malformed and oversized prereleases without backtracking", () => {
  for (const version of [
    "01.2.3",
    "1.2",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3+build+again",
    `0.0.0-0.${"--.".repeat(256)}`
  ]) {
    assert.equal(isReleaseVersion(version), false, version.slice(0, 40));
  }
});
