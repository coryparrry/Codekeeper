import assert from "node:assert/strict";
import test from "node:test";
import { buildSpdxDocument, collectPackages, evaluateLicenses } from "./generate-sbom.mjs";

function lock(packages) {
  return { lockfileVersion: 3, packages };
}

test("collects deterministic npm package identities", () => {
  const result = collectPackages(lock({
    "": { name: "root", version: "1.0.0" },
    "node_modules/zeta": { version: "2.0.0", license: "MIT", resolved: "https://registry/zeta.tgz" },
    "node_modules/@scope/alpha": { version: "1.0.0", license: "Apache-2.0", dev: true },
  }), "root-lock.json");
  assert.deepEqual(result.map(({ name, version, license, dev }) => ({ name, version, license, dev })), [
    { name: "@scope/alpha", version: "1.0.0", license: "Apache-2.0", dev: true },
    { name: "zeta", version: "2.0.0", license: "MIT", dev: false },
  ]);
  const first = buildSpdxDocument(result, { environment: { SOURCE_DATE_EPOCH: "0" } });
  const second = buildSpdxDocument(result, { environment: { SOURCE_DATE_EPOCH: "0" } });
  assert.deepEqual(first, second);
  assert.equal(first.creationInfo.created, "1970-01-01T00:00:00Z");
});

test("rejects denied SPDX license identifiers inside expressions", () => {
  const packages = collectPackages(lock({
    "node_modules/example": { version: "1.0.0", license: "MIT OR AGPL-3.0-only" },
  }));
  const result = evaluateLicenses(packages, {
    version: 1,
    allowMissing: true,
    denyLicenses: ["AGPL-3.0-only"],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.denied[0].matched, ["AGPL-3.0-ONLY"]);
});

test("reports missing licenses without failing when policy permits them", () => {
  const packages = collectPackages(lock({
    "node_modules/example": { version: "1.0.0" },
  }));
  const result = evaluateLicenses(packages, {
    version: 1,
    allowMissing: true,
    denyLicenses: [],
  });
  assert.equal(result.valid, true);
  assert.equal(result.missing.length, 1);
});

test("deduplicates a package while retaining all source lockfiles", () => {
  const first = collectPackages(lock({
    "node_modules/example": { version: "1.0.0", license: "MIT" },
  }), "first-lock.json");
  const second = collectPackages(lock({
    "node_modules/example": { version: "1.0.0", license: "MIT" },
  }), "second-lock.json");
  const merged = new Map();
  for (const item of [...first, ...second]) {
    const key = `${item.name}\0${item.version}`;
    const existing = merged.get(key);
    if (existing) existing.sources = [...new Set([...existing.sources, ...item.sources])].sort();
    else merged.set(key, structuredClone(item));
  }
  assert.deepEqual([...merged.values()][0].sources, ["first-lock.json", "second-lock.json"]);
});

test("fails closed for unsupported lockfile shapes", () => {
  assert.throws(
    () => collectPackages({ lockfileVersion: 1, dependencies: {} }, "old-lock.json"),
    /lockfile version 2 or 3/,
  );
});
