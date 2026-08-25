import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePolicy } from "../src/policy-validator.mjs";
import { normalizeLivePolicy } from "../src/policy-normalization.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "../..");

async function canonicalRuntimeFile(file) {
  return readFile(path.join(repositoryRoot, "tools/codekeeper/src/lib", file));
}

const installerPolicy = normalizeLivePolicy(JSON.parse(
  await readFile(path.join(repositoryRoot, ".github/codekeeper.json"), "utf8"),
));

test("the installer ships the current runtime policy validator byte for byte", async () => {
  const validator = await canonicalRuntimeFile("policy-validator.mjs");
  assert.deepEqual(
    await readFile(path.join(packageRoot, "src/policy-validator.mjs")),
    validator,
  );
  if (validator.includes('from "./label-ownership.mjs"')) {
    assert.deepEqual(
      await readFile(path.join(packageRoot, "src/label-ownership.mjs")),
      await canonicalRuntimeFile("label-ownership.mjs"),
    );
  }
});

test("the installer validator enforces orchestration boundaries directly", () => {
  assert.doesNotThrow(() => validatePolicy(structuredClone(installerPolicy)));
  const invalidPolicies = [
    (policy) => { policy.ai.orchestration.role = "correctness"; },
    (policy) => { policy.ai.orchestration.modes.correctness = false; },
    (policy) => { policy.ai.orchestration.maximumTokensPerAgent = 0; },
    (policy) => { policy.ai.orchestration.maximumTokensPerAgent = 32001; },
    (policy) => { policy.ai.orchestration.maximumTotalTokens = 31999; },
    (policy) => { policy.ai.orchestration.maximumTotalTokens = 32000; },
    (policy) => { policy.ai.orchestration.maximumOutputBytes = 262145; },
    (policy) => { policy.ai.orchestration.maximumConcurrency = 4; },
    (policy) => { policy.ai.orchestration.maximumConcurrency = 3; policy.ai.orchestration.maximumSpecialists = 2; },
    (policy) => { policy.ai.orchestration.modes.review = true; },
    (policy) => { policy.ai.orchestration.providerMultiAgent = true; },
  ];
  for (const mutate of invalidPolicies) {
    const invalid = structuredClone(installerPolicy);
    mutate(invalid);
    assert.throws(
      () => validatePolicy(invalid),
      /Invalid Codekeeper policy/,
    );
  }
});
