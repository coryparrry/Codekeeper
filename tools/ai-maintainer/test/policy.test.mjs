import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validatePatch, evaluateAutoMerge } from "../src/lib/policy.mjs";

const source = JSON.parse(
  await readFile(new URL("../../../.github/ai-maintainer.json", import.meta.url), "utf8")
);
const config = structuredClone(source);
config.merge.enabled = true;
config.audit.repair.maximumPatchBytes ??= 1024;
config.audit.repair.maximumFileBytes ??= 512;

function change(path, overrides = {}) {
  return { path, status: "M", additions: 1, deletions: 0, bytes: 32, ...overrides };
}

function patch(files, overrides = {}) {
  const additions = files.reduce((sum, file) => sum + Number(file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + Number(file.deletions ?? 0), 0);
  return {
    files,
    additions,
    deletions,
    changedLines: additions + deletions,
    patchBytes: 64,
    ...overrides
  };
}

test("patch policy accepts bounded source changes but rejects protected paths", () => {
  const accepted = validatePatch(
    patch([change("docs/README.md", { additions: 12, deletions: 3 })], { patchBytes: 128 }),
    config
  );
  assert.equal(accepted.valid, true);

  const rejected = validatePatch(
    patch([change(".github/workflows/release.yml", { additions: 2, deletions: 1 })]),
    config
  );
  assert.equal(rejected.valid, false);
  assert.ok(rejected.reasons.some((reason) => reason.includes("protected")));

  const authority = validatePatch(
    patch([change("AGENTS.md", { additions: 2, deletions: 1 })]),
    config
  );
  assert.equal(authority.valid, false);
  assert.ok(authority.reasons.some((reason) => reason.includes("protected")));
});

test("auto-merge is limited to low-risk allowlisted automation PRs", () => {
  const pullRequest = {
    state: "open",
    draft: false,
    user: { login: "ai-maintainer[bot]", type: "Bot" },
    head: { ref: `${config.repository.automationBranchPrefix}audit-1`, repo: { full_name: "owner/repository" } },
    base: { repo: { full_name: "owner/repository" } }
  };
  const reviewResult = {
    risk: "low",
    blockingFindings: [],
    tests: { adequate: true },
    mergeRecommendation: "auto"
  };
  const accepted = evaluateAutoMerge({
    config,
    pullRequest,
    files: [{ filename: "docs/README.md", additions: 10, deletions: 2 }],
    reviewResult,
    reviewContextComplete: true,
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(accepted.eligible, true);

  const swift = evaluateAutoMerge({
    config,
    pullRequest,
    files: [{ filename: ".github/workflows/release.yml", additions: 3, deletions: 1 }],
    reviewResult,
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(swift.eligible, false);
  assert.ok(swift.reasons.some((reason) => reason.includes("blocked")));

  const nonMarkdownDocumentation = evaluateAutoMerge({
    config,
    pullRequest,
    files: [{ filename: "docs/architecture.png", additions: 0, deletions: 0 }],
    reviewResult,
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(nonMarkdownDocumentation.eligible, false);

  const agentInstructions = evaluateAutoMerge({
    config,
    pullRequest,
    files: [{ filename: "AGENTS.md", additions: 2, deletions: 1 }],
    reviewResult,
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(agentInstructions.eligible, false);
  assert.ok(agentInstructions.reasons.some((reason) => reason.includes("blocked")));
});

test("auto-merge fails closed when frozen review diff context is incomplete", () => {
  const pullRequest = {
    state: "open",
    draft: false,
    user: { login: "ai-maintainer[bot]", type: "Bot" },
    head: { ref: `${config.repository.automationBranchPrefix}audit-1`, repo: { full_name: "owner/repository" } },
    base: { repo: { full_name: "owner/repository" } }
  };
  const reviewResult = {
    risk: "low",
    blockingFindings: [],
    tests: { adequate: true },
    mergeRecommendation: "auto"
  };
  for (const reviewContextComplete of [false, undefined]) {
    const decision = evaluateAutoMerge({
      config,
      pullRequest,
      files: [{ filename: "docs/README.md", additions: 1, deletions: 0 }],
      reviewResult,
      reviewContextComplete,
      automationBotLogin: "ai-maintainer[bot]"
    });
    assert.equal(decision.eligible, false);
    assert.ok(decision.reasons.some((reason) => reason.includes("Frozen review diff context is incomplete")));
  }
});


test("patch policy rejects links, special files and mode changes", () => {
  const rejected = validatePatch(
    patch([
      change("docs/link.md", { status: "A", symlink: true, specialMode: true, additions: 0, deletions: 0 }),
      change("docs/device.md", { status: "A", specialMode: true, additions: 0, deletions: 0 }),
      change("README.md", { modeChanged: true, additions: 1, deletions: 1 })
    ]),
    config
  );
  assert.equal(rejected.valid, false);
  assert.ok(rejected.reasons.some((reason) => reason.includes("symbolic link")));
  assert.ok(rejected.reasons.some((reason) => reason.includes("not a regular file")));
  assert.ok(rejected.reasons.some((reason) => reason.includes("changes file mode")));
});

test("patch policy rejects oversized content and new executable files", () => {
  const rejected = validatePatch(
    patch([
      change("docs/huge.md", { bytes: config.audit.repair.maximumFileBytes + 1 }),
      change("docs/tool.md", { status: "A", newMode: "100755" })
    ], { patchBytes: config.audit.repair.maximumPatchBytes + 1 }),
    config
  );
  assert.equal(rejected.valid, false);
  assert.ok(rejected.reasons.some((reason) => reason.includes("Patch is")));
  assert.ok(rejected.reasons.some((reason) => reason.includes("maximum")));
  assert.ok(rejected.reasons.some((reason) => reason.includes("adds an executable")));
});

test("patch policy rejects deletion and rename records", () => {
  const rejected = validatePatch(
    patch([
      change("docs/removed.md", { status: "D", bytes: 0 }),
      change("docs/renamed.md", { status: "R100", sourcePath: "docs/old-name.md" })
    ]),
    config
  );
  assert.equal(rejected.valid, false);
  assert.ok(rejected.reasons.some((reason) => reason.includes("deletes a file")));
  assert.ok(rejected.reasons.some((reason) => reason.includes("renames or copies")));
});

test("auto-merge rejects a human author using the automation branch prefix", () => {
  const decision = evaluateAutoMerge({
    config,
    pullRequest: {
      state: "open",
      draft: false,
      user: { login: "person", type: "User" },
      head: { ref: `${config.repository.automationBranchPrefix}fake`, repo: { full_name: "owner/repository" } },
      base: { repo: { full_name: "owner/repository" } }
    },
    files: [{ filename: "docs/README.md", additions: 1, deletions: 0 }],
    reviewResult: {
      risk: "low",
      blockingFindings: [],
      tests: { adequate: true },
      mergeRecommendation: "auto"
    },
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("not opened by a GitHub App bot")));
});


test("auto-merge cannot be enabled without a current-head AI review result", () => {
  const decision = evaluateAutoMerge({
    config,
    pullRequest: {
      state: "open",
      draft: false,
      user: { login: "ai-maintainer[bot]", type: "Bot" },
      head: { ref: `${config.repository.automationBranchPrefix}audit-1`, repo: { full_name: "owner/repository" } },
      base: { repo: { full_name: "owner/repository" } }
    },
    files: [{ filename: "docs/README.md", additions: 1, deletions: 0 }],
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("current-head AI review")));
});

test("auto-merge rejects an unconfigured bot even on the automation branch", () => {
  const decision = evaluateAutoMerge({
    config,
    pullRequest: {
      state: "open",
      draft: false,
      user: { login: "other-app[bot]", type: "Bot" },
      head: { ref: `${config.repository.automationBranchPrefix}audit-1`, repo: { full_name: "owner/repository" } },
      base: { repo: { full_name: "owner/repository" } }
    },
    files: [{ filename: "docs/README.md", additions: 1, deletions: 0 }],
    reviewResult: {
      risk: "low",
      blockingFindings: [],
      tests: { adequate: true },
      mergeRecommendation: "auto"
    },
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("not the configured automation bot")));
});

test("auto-merge defensively rejects a critical finding outside the blocking array", () => {
  const decision = evaluateAutoMerge({
    config,
    pullRequest: {
      state: "open",
      draft: false,
      user: { login: "ai-maintainer[bot]", type: "Bot" },
      head: { ref: `${config.repository.automationBranchPrefix}audit-1`, repo: { full_name: "owner/repository" } },
      base: { repo: { full_name: "owner/repository" } }
    },
    files: [{ filename: "docs/README.md", additions: 1, deletions: 0 }],
    reviewResult: {
      risk: "low",
      blockingFindings: [],
      nonBlockingFindings: [{ severity: "critical" }],
      tests: { adequate: true },
      mergeRecommendation: "auto"
    },
    automationBotLogin: "ai-maintainer[bot]"
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("critical finding")));
});
