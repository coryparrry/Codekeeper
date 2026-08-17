import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validatePatch, evaluateAutoMerge, evaluateReviewEligibility, reviewLabels } from "../src/lib/policy.mjs";

const source = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
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

test("review, report publication, and automation mutation use separate eligibility tiers", () => {
  const pullRequest = {
    number: 7,
    state: "open",
    draft: false,
    head: { sha: "a".repeat(40), repo: { full_name: "fork/repository" } },
    base: { sha: "b".repeat(40), ref: config.repository.defaultBranch, repo: { full_name: "owner/repository" } }
  };
  const fork = evaluateReviewEligibility({ config, pullRequest, repository: "owner/repository" });
  assert.equal(fork.readOnlyReview.eligible, false);
  assert.equal(fork.reportPublication.eligible, false);
  assert.equal(fork.automationMutation.eligible, false);
  assert.ok(fork.readOnlyReview.reasons.includes("Fork pull requests are unsupported"));

  const sameRepository = { ...pullRequest, head: { ...pullRequest.head, repo: { full_name: "owner/repository" } } };
  const draft = evaluateReviewEligibility({
    config,
    pullRequest: { ...sameRepository, draft: true },
    repository: "owner/repository"
  });
  assert.equal(draft.readOnlyReview.eligible, true);
  assert.equal(draft.reportPublication.eligible, false);
  assert.equal(draft.automationMutation.eligible, false);

  const oversized = evaluateReviewEligibility({
    config,
    pullRequest: sameRepository,
    repository: "owner/repository",
    reviewReasons: ["Review changed-file context exceeds configured maximum of 200 files"]
  });
  assert.equal(oversized.readOnlyReview.eligible, false);
  assert.equal(oversized.reportPublication.eligible, true);
  assert.equal(oversized.automationMutation.eligible, false);
});

test("review labels distinguish missing coverage from unknown evidence", () => {
  const result = {
    risk: "medium",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    mergeRecommendation: "manual",
    tests: { adequate: false, notes: "External evidence is unavailable.", missingTest: null }
  };

  assert.equal(reviewLabels(result).includes("codekeeper:needs-tests"), false);
  assert.equal(reviewLabels({
    ...result,
    tests: { ...result.tests, missingTest: "Add a dispatch test and expect one durable run name." }
  }).includes("codekeeper:needs-tests"), true);
});

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
    user: { login: "codekeeper[bot]", type: "Bot" },
    head: { ref: `${config.repository.automationBranchPrefix}audit-1`, repo: { full_name: "owner/repository" } },
    base: { ref: config.repository.defaultBranch, repo: { full_name: "owner/repository" } }
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
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(accepted.eligible, true);

  const paused = evaluateAutoMerge({
    config,
    pullRequest: { ...pullRequest, labels: [{ name: "paused" }] },
    files: [{ filename: "docs/README.md", additions: 10, deletions: 2 }],
    reviewResult,
    reviewContextComplete: true,
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(paused.eligible, false);
  assert.ok(paused.reasons.some((reason) => reason.includes("paused")));

  const swift = evaluateAutoMerge({
    config,
    pullRequest,
    files: [{ filename: ".github/workflows/release.yml", additions: 3, deletions: 1 }],
    reviewResult,
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(swift.eligible, false);
  assert.ok(swift.reasons.some((reason) => reason.includes("blocked")));

  const nonMarkdownDocumentation = evaluateAutoMerge({
    config,
    pullRequest,
    files: [{ filename: "docs/architecture.png", additions: 0, deletions: 0 }],
    reviewResult,
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(nonMarkdownDocumentation.eligible, false);

  const agentInstructions = evaluateAutoMerge({
    config,
    pullRequest,
    files: [{ filename: "AGENTS.md", additions: 2, deletions: 1 }],
    reviewResult,
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(agentInstructions.eligible, false);
  assert.ok(agentInstructions.reasons.some((reason) => reason.includes("blocked")));
});

test("auto-merge fails closed when frozen review diff context is incomplete", () => {
  const pullRequest = {
    state: "open",
    draft: false,
    user: { login: "codekeeper[bot]", type: "Bot" },
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
      automationBotLogin: "codekeeper[bot]"
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
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("not opened by a GitHub App bot")));
});

test("auto-merge never admits a human pull request when an unvalidated v2 policy enables it", () => {
  const unsafeConfig = structuredClone(config);
  unsafeConfig.merge.allowUserPullRequests = true;
  unsafeConfig.merge.allowedUserAuthors = ["person"];
  const decision = evaluateAutoMerge({
    config: unsafeConfig,
    pullRequest: {
      state: "open",
      draft: false,
      user: { login: "person", type: "User" },
      head: { ref: "docs/manual-update", repo: { full_name: "owner/repository" } },
      base: { repo: { full_name: "owner/repository" } }
    },
    files: [{ filename: "docs/README.md", additions: 1, deletions: 0 }],
    reviewResult: {
      risk: "low",
      blockingFindings: [],
      tests: { adequate: true },
      mergeRecommendation: "auto"
    },
    reviewContextComplete: true,
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("User pull request auto-merge is not supported")));
});


test("auto-merge cannot be enabled without a current-head AI review result", () => {
  const decision = evaluateAutoMerge({
    config,
    pullRequest: {
      state: "open",
      draft: false,
      user: { login: "codekeeper[bot]", type: "Bot" },
      head: { ref: `${config.repository.automationBranchPrefix}audit-1`, repo: { full_name: "owner/repository" } },
      base: { repo: { full_name: "owner/repository" } }
    },
    files: [{ filename: "docs/README.md", additions: 1, deletions: 0 }],
    automationBotLogin: "codekeeper[bot]"
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
    automationBotLogin: "codekeeper[bot]"
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
      user: { login: "codekeeper[bot]", type: "Bot" },
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
    automationBotLogin: "codekeeper[bot]"
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("critical finding")));
});
