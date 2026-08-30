import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";
import { assessPullRequestTargetTrust } from "../src/gh-aw/trust.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const NATIVE_IMPORT = ".github/rivet/aw/review-extension.md";
const LOCAL_ACTION = "./.github/rivet/actions/authority-receipt";

async function compiledAuthority() {
  const source = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test",
      "fixtures",
      "review",
      ".github",
      "workflows",
      "rivet-review.lock.yml",
    ),
    "utf8",
  );
  return { source, authority: inspectCompiledWorkflow(source) };
}

test("accepts the self-contained base-branch Rivet review authority", async () => {
  const { source, authority } = await compiledAuthority();
  const trust = assessPullRequestTargetTrust({
    authority,
    expectedImports: [NATIVE_IMPORT],
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.deepEqual(trust, {
    trusted: true,
    baseContext: "pull_request_target default branch",
    violations: [],
  });
  assert.match(source, /Native Rivet extension proof/);
  assert.match(source, /"toolTimeout": 240/);
});

test("rejects PR-head prompt loading and mutable action authority", async () => {
  const { authority } = await compiledAuthority();
  const untrusted = {
    ...authority,
    runtimeImports: [".github/workflows/rivet-review.md"],
    unpinnedActions: [{ uses: "owner/action@main" }],
    checkouts: authority.checkouts.map((checkout, index) =>
      index === 0
        ? { ...checkout, ref: "${{ github.event.pull_request.head.sha }}" }
        : checkout,
    ),
  };
  const trust = assessPullRequestTargetTrust({
    authority: untrusted,
    expectedImports: [NATIVE_IMPORT],
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "runtime prompt imports are not allowed",
    "all actions must use immutable commit pins",
    "checkouts must use the base context without persisted credentials",
  ]);
});

test("rejects a native import inventory change without approval", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessPullRequestTargetTrust({
    authority,
    expectedImports: [
      NATIVE_IMPORT,
      ".github/rivet/aw/unreviewed-extension.md",
    ],
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "resolved native imports differ from the approved inventory",
  ]);
});

test("rejects an unapproved local extension action", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessPullRequestTargetTrust({
    authority,
    expectedImports: [NATIVE_IMPORT],
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "local actions differ from the approved inventory",
  ]);
});
