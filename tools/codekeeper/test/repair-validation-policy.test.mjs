import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePolicy } from "../src/lib/policy-validator.mjs";
import { normalizeLivePolicy } from "../src/lib/policy-normalization.mjs";

const source = normalizeLivePolicy(JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8"),
));

const writeAuthorityControls = [
  ["review.autoRepair", (config) => { config.review.autoRepair = true; }],
  ["audit.repair.enabled", (config) => { config.audit.repair.enabled = true; }],
  ["issues.allowAiImplementation", (config) => { config.issues.allowAiImplementation = true; }],
];

test("the starter policy permits git diff check when no write authority is enabled", () => {
  assert.doesNotThrow(() => validatePolicy(structuredClone(source)));
});

for (const [control, enableControl] of writeAuthorityControls) {
  test(`${control} requires a repository-specific validation command`, () => {
    for (const validationCommands of [[], ["git diff --check"], ["  git diff --check  "]]) {
      const config = structuredClone(source);
      enableControl(config);
      config.audit.repair.validationCommands = validationCommands;
      assert.throws(
        () => validatePolicy(config),
        /repository-specific validation command beyond git diff --check/,
        `${control} should reject ${JSON.stringify(validationCommands)}`,
      );
    }

    const whitespaceOnly = structuredClone(source);
    enableControl(whitespaceOnly);
    whitespaceOnly.audit.repair.validationCommands = [" \t "];
    assert.throws(
      () => validatePolicy(whitespaceOnly),
      /audit\.repair\.validationCommands must contain strings/,
    );

    const valid = structuredClone(source);
    enableControl(valid);
    valid.audit.repair.validationCommands = ["git diff --check", "npm test"];
    assert.doesNotThrow(() => validatePolicy(valid));
  });
}
