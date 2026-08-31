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
const NATIVE_IMPORTS = [
  ".github/rivet/agents/pr-reviewer.md",
  ".github/rivet/aw/review-extension.md",
];
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
    expectedImports: NATIVE_IMPORTS,
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.deepEqual(trust, {
    trusted: true,
    baseContext: "pull_request_target default branch",
    violations: [],
  });
  assert.match(source, /Rivet review contract/);
  assert.match(source, /actively disprove each one/);
  assert.match(source, /"toolTimeout": 240/);
  assert.ok(
    source.indexOf("- name: Checkout repository") <
      source.indexOf("name: Record Rivet authority receipt"),
  );
  assert.match(source, /Tools: create_issue,/);
  assert.match(source, /permission-issues: write/);
  assert.match(source, /permission-pull-requests: write/);
  assert.doesNotMatch(
    source,
    /permission-(?:actions|contents|deployments|discussions|packages|statuses): write/,
  );
});

test("rejects PR-head prompt loading and mutable action authority", async () => {
  const { authority } = await compiledAuthority();
  const untrusted = {
    ...authority,
    runtimeImports: [".github/workflows/rivet-review.md"],
    unpinnedActions: [{ uses: "owner/action@main" }],
    unpinnedContainers: [{ image: "owner/image:latest" }],
    checkouts: authority.checkouts.map((checkout, index) =>
      index === 0
        ? { ...checkout, ref: "${{ github.event.pull_request.head.sha }}" }
        : checkout,
    ),
  };
  const trust = assessPullRequestTargetTrust({
    authority: untrusted,
    expectedImports: NATIVE_IMPORTS,
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "runtime prompt imports are not allowed",
    "all actions must use immutable commit pins",
    "all containers must use immutable digest pins",
    "checkouts must use the base context without persisted credentials",
  ]);
});

test("rejects a native import inventory change without approval", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessPullRequestTargetTrust({
    authority,
    expectedImports: [
      ...NATIVE_IMPORTS,
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
    expectedImports: NATIVE_IMPORTS,
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "local actions differ from the approved inventory",
  ]);
});
