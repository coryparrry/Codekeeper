import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateReviewRun } from "../evals/review-safe-outputs.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EVALUATOR = path.join(PACKAGE_ROOT, "evals", "review-safe-outputs.mjs");
const HEAD = "a".repeat(40);
const PROFILE = "# Pull request reviewer\n\nFind concrete defects.\n";
const PROFILE_SHA = createHash("sha256").update(PROFILE).digest("hex");

function manifest(terminal = "review") {
  return {
    version: 1,
    repeat: 1,
    expectedHeadSha: HEAD,
    reviewerProfile: { path: "reviewer.md", sha256: PROFILE_SHA },
    expected: {
      terminal,
      comments:
        terminal === "review"
          ? [
              {
                path: "src/discount.mjs",
                line: 2,
                bodyIncludes: ["above 100", "negative totals"],
              },
            ]
          : [],
      submitReviewEvent: terminal === "review" ? "COMMENT" : null,
      createIssueCount: terminal === "review" ? 1 : 0,
    },
  };
}

function reviewBody() {
  return `# Rivet review

## What this changes

The discount path now handles large values.

## Merge readiness

⚠️ **Ready for maintainer review**

## Verification

| Check | Result | Evidence |
|---|---|---|
| Findings | One | Inline review comment |

## Before merge

- [ ] Resolve the inline finding.

<details>
<summary><strong>Review details</strong></summary>

Exact comparison reviewed.

</details>`;
}

function reviewArtifacts() {
  return {
    metadata: { headSha: HEAD, runId: 42, conclusion: "success" },
    profile: PROFILE,
    prompt: `Trusted instructions\n\n${PROFILE}\nPublication contract`,
    outputs: [
      {
        type: "create_pull_request_review_comment",
        path: "src/discount.mjs",
        line: 2,
        body: "Values above 100 can produce negative totals.",
      },
      {
        type: "submit_pull_request_review",
        event: "COMMENT",
        body: reviewBody(),
      },
      { type: "create_issue", title: "Deferred concern" },
    ],
    receipts: [
      { type: "create_pull_request_review_comment" },
      {
        type: "submit_pull_request_review",
        metadata: { review_event: "COMMENT" },
      },
      { type: "create_issue" },
    ],
    errors: [],
  };
}

test("scores Rivet review outputs against prompt identity and receipts", () => {
  const passing = evaluateReviewRun(manifest(), reviewArtifacts());
  assert.equal(passing.passed, true);
  assert.equal(passing.falsePositiveComments.length, 0);

  const extraComment = reviewArtifacts();
  extraComment.outputs.push({
    type: "create_pull_request_review_comment",
    path: "src/unrelated.mjs",
    line: 9,
    body: "Speculative concern",
  });
  const falsePositive = evaluateReviewRun(manifest(), extraComment);
  assert.equal(falsePositive.passed, false);
  assert.equal(falsePositive.falsePositiveComments.length, 1);
  assert.equal(falsePositive.checks.receipts, false);

  const wrongIdentity = reviewArtifacts();
  wrongIdentity.prompt = "Profile omitted";
  wrongIdentity.metadata.headSha = "b".repeat(40);
  const unbound = evaluateReviewRun(manifest(), wrongIdentity);
  assert.equal(unbound.passed, false);
  assert.equal(unbound.checks.head, false);
  assert.equal(unbound.checks.profileInPrompt, false);

  const disallowedEvent = reviewArtifacts();
  disallowedEvent.outputs.find(
    (item) => item.type === "submit_pull_request_review",
  ).event = "REQUEST_CHANGES";
  const eventMismatch = evaluateReviewRun(manifest(), disallowedEvent);
  assert.equal(eventMismatch.passed, false);
  assert.equal(eventMismatch.checks.reviewEvent, false);
});

test("scores noop and incomplete outcomes without publication receipts", () => {
  const base = {
    metadata: { headSha: HEAD, conclusion: "success" },
    profile: PROFILE,
    prompt: PROFILE,
    receipts: [],
    errors: [],
  };
  assert.equal(
    evaluateReviewRun(manifest("noop"), {
      ...base,
      outputs: [{ type: "noop", reason: "No actionable finding" }],
    }).passed,
    true,
  );
  assert.equal(
    evaluateReviewRun(manifest("report_incomplete"), {
      ...base,
      outputs: [{ type: "missing_data", reason: "Base ref unavailable" }],
    }).passed,
    true,
  );

  const unexpectedReceipt = evaluateReviewRun(manifest("noop"), {
    ...base,
    outputs: [{ type: "noop", reason: "No actionable finding" }],
    receipts: [{ type: "close_issue" }],
  });
  assert.equal(unexpectedReceipt.passed, false);
  assert.equal(unexpectedReceipt.checks.knownReceipts, false);
});

test("requires a useful general review body even without findings", () => {
  const cleanManifest = manifest();
  cleanManifest.expected.comments = [];
  cleanManifest.expected.createIssueCount = 0;
  const clean = reviewArtifacts();
  clean.outputs = clean.outputs.filter(
    ({ type }) =>
      !["create_pull_request_review_comment", "create_issue"].includes(type),
  );
  clean.receipts = clean.receipts.filter(
    ({ type }) =>
      !["create_pull_request_review_comment", "create_issue"].includes(type),
  );
  assert.equal(evaluateReviewRun(cleanManifest, clean).passed, true);

  clean.outputs[0].body = "No findings.";
  const weak = evaluateReviewRun(cleanManifest, clean);
  assert.equal(weak.passed, false);
  assert.equal(weak.checks.reviewBody, false);
});

test("CLI emits JSON and exits nonzero when a run fails", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-review-eval-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runs = path.join(root, "runs");
  const run = path.join(runs, "001");
  const installedBin = path.join(root, "rivet-review-eval");
  await mkdir(path.join(run, "aw-prompts"), { recursive: true });
  await symlink(EVALUATOR, installedBin);
  await Promise.all([
    writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest())),
    writeFile(path.join(root, "reviewer.md"), PROFILE),
    writeFile(
      path.join(run, "run.json"),
      JSON.stringify({ headSha: "b".repeat(40), conclusion: "success" }),
    ),
    writeFile(path.join(run, "aw-prompts", "prompt.txt"), PROFILE),
    writeFile(
      path.join(run, "agent_output.json"),
      JSON.stringify({ items: reviewArtifacts().outputs, errors: [] }),
    ),
    writeFile(
      path.join(run, "safe-output-items.jsonl"),
      `${reviewArtifacts().receipts.map(JSON.stringify).join("\n")}\n`,
    ),
  ]);

  const result = spawnSync(
    process.execPath,
    [
      installedBin,
      "--manifest",
      path.join(root, "manifest.json"),
      "--runs-directory",
      runs,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).passed, false);
  assert.equal(result.stderr, "");
});
