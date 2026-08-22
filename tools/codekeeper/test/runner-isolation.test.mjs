import assert from "node:assert/strict";
import test from "node:test";

import { repositoryFile, workflow } from "./workflow-test-helpers.mjs";

const runtimeModes = Object.freeze(["assistant", "review", "maintain", "issues", "fix"]);

test("product runtime workflows keep every job on GitHub-hosted Ubuntu", async () => {
  for (const mode of runtimeModes) {
    const source = await workflow(mode);
    const runsOn = source.match(/^\s+runs-on: .*$/gm) ?? [];

    if (mode === "assistant") {
      assert.ok(runsOn.length > 0, `${mode} must declare at least one job runner`);
    } else {
      assert.deepEqual(runsOn, [], `${mode} wrapper must not allocate a runner`);
      assert.match(
        source,
        /uses: \.\/\.github\/workflows\/codekeeper-runtime\.yml/,
      );
    }
    assert.ok(
      runsOn.every((line) => line.trim() === "runs-on: ubuntu-latest"),
      `${mode} must not route a product job through a configurable or persistent runner`,
    );
    assert.doesNotMatch(source, /inputs\.runner|CODEKEEPER_RUNNER/);

    const callInputs = source.slice(0, source.indexOf("\npermissions:"));
    assert.doesNotMatch(
      callInputs,
      /^\s+runner:\s*$/m,
      `${mode} must not expose a reusable-workflow runner override`,
    );
  }

  const generic = await repositoryFile(
    ".github/workflows/codekeeper-runtime.yml",
  );
  const genericRunners = generic.match(/^\s+runs-on: .*$/gm) ?? [];
  assert.equal(genericRunners.length, 4);
  assert.ok(
    genericRunners.every((line) => line.trim() === "runs-on: ubuntu-latest"),
  );
  assert.doesNotMatch(generic, /inputs\.runner|CODEKEEPER_RUNNER/);
});

test("generated callers do not pass a custom runtime runner", async () => {
  for (const mode of runtimeModes) {
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );

    assert.doesNotMatch(caller, /CODEKEEPER_RUNNER|vars\.CODEKEEPER_RUNNER/);
    assert.doesNotMatch(
      caller,
      /^\s+runner:\s+/m,
      `${mode} caller must not pass a runner input to the reusable workflow`,
    );

    const runsOn = caller.match(/^\s+runs-on: .*$/gm) ?? [];
    assert.ok(
      runsOn.every((line) => line.trim() === "runs-on: ubuntu-latest"),
      `${mode} caller jobs must use GitHub-hosted Ubuntu`,
    );
  }
});

test("architecture records the supported runner trust boundary", async () => {
  const architecture = await repositoryFile("docs/ARCHITECTURE.md");
  assert.match(architecture, /fresh GitHub-hosted Ubuntu runners/);
  assert.match(architecture, /custom or persistent self-hosted runner overrides/);
  assert.match(architecture, /literal `ubuntu-latest`/);
});
