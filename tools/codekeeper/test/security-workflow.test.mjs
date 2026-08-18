import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { actionPins } from "./workflow-test-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("security workflow uses approved immutable actions and bounded permissions", async () => {
  const source = await read(".github/workflows/codekeeper-security.yml");
  assert.match(source, new RegExp(`github/codeql-action/init@${actionPins["github/codeql-action"]}`));
  assert.match(source, new RegExp(`github/codeql-action/analyze@${actionPins["github/codeql-action"]}`));
  assert.match(source, new RegExp(`actions/dependency-review-action@${actionPins["actions/dependency-review-action"]}`));
  assert.match(source, /permissions:\n  contents: read/);
  assert.equal([...source.matchAll(/security-events: write/g)].length, 1);
  assert.doesNotMatch(source, /\$\{\{\s*secrets\./);
  assert.match(source, /npm audit --package-lock-only --omit=dev --audit-level=high --ignore-scripts/g);
  assert.match(source, /scripts\/generate-sbom\.mjs/);
});

test("dependency review and local license policy deny the same licenses", async () => {
  const config = await read(".github/dependency-review-config.yml");
  const policy = JSON.parse(await read("security/license-policy.json"));
  for (const license of policy.denyLicenses) assert.match(config, new RegExp(`- ${license.replaceAll(".", "\\.")}`));
  assert.equal(policy.allowMissing, true);
});

test("root Dependabot coverage includes the repository lockfile", async () => {
  const source = await read(".github/dependabot.yml");
  assert.match(source, /package-ecosystem: npm\n    directory: \/\n/);
});

test("root checks retain the deterministic SBOM unit suite", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.scripts["security:check"], "node --test scripts/generate-sbom.test.mjs");
  assert.match(packageJson.scripts.check, /npm run security:check/);
});
