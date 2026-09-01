#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/i;
const MUTATIONS = [
  "create_pull_request_review_comment",
  "submit_pull_request_review",
  "create_issue",
];
const OUTPUT_TYPES = new Set([
  ...MUTATIONS,
  "noop",
  "report_incomplete",
  "missing_data",
  "missing_tool",
]);
const REVIEW_BODY_SECTIONS = [
  "# Rivet review",
  "## What this changes",
  "## Merge readiness",
  "## Verification",
  "## Before merge",
  "<summary><strong>Review details</strong></summary>",
];
const REVIEW_VERIFICATION_LABELS = [
  "- **Findings:**",
  "- **Tests:**",
  "- **Risk:**",
];
const MARKDOWN_TABLE_DELIMITER =
  /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/mu;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateManifest(manifest) {
  invariant(manifest?.version === 1, "manifest.version must equal 1");
  invariant(
    Number.isSafeInteger(manifest.repeat) && manifest.repeat > 0,
    "manifest.repeat must be a positive integer",
  );
  invariant(
    SHA.test(manifest.expectedHeadSha ?? ""),
    "manifest.expectedHeadSha must be a full commit SHA",
  );
  invariant(
    typeof manifest.reviewerProfile?.path === "string" &&
      manifest.reviewerProfile.path.trim() &&
      DIGEST.test(manifest.reviewerProfile.sha256 ?? ""),
    "manifest.reviewerProfile must contain path and sha256",
  );
  invariant(
    ["review", "noop", "report_incomplete"].includes(
      manifest.expected?.terminal,
    ),
    "manifest.expected.terminal is invalid",
  );
  invariant(
    Array.isArray(manifest.expected.comments) &&
      Number.isSafeInteger(manifest.expected.createIssueCount) &&
      manifest.expected.createIssueCount >= 0 &&
      manifest.expected.createIssueCount <= 1,
    "manifest.expected must contain comments and createIssueCount",
  );
  for (const [index, finding] of manifest.expected.comments.entries()) {
    invariant(
      typeof finding?.path === "string" &&
        Number.isSafeInteger(finding.line) &&
        finding.line > 0 &&
        Array.isArray(finding.bodyIncludes) &&
        finding.bodyIncludes.length > 0 &&
        finding.bodyIncludes.every(
          (term) => typeof term === "string" && term.trim(),
        ),
      `manifest.expected.comments[${index}] is invalid`,
    );
  }
  if (manifest.expected.terminal === "review") {
    invariant(
      ["COMMENT", "REQUEST_CHANGES"].includes(
        manifest.expected.submitReviewEvent,
      ),
      "review expects submitReviewEvent",
    );
  } else {
    invariant(
      manifest.expected.submitReviewEvent === null &&
        manifest.expected.comments.length === 0 &&
        manifest.expected.createIssueCount === 0,
      `${manifest.expected.terminal} cannot expect mutations`,
    );
  }
  return manifest;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function count(items, type) {
  return items.filter((item) => item.type === type).length;
}

function countByType(items) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item.type))].map((type) => [
      type,
      count(items, type),
    ]),
  );
}

function incompleteCount(items) {
  return ["report_incomplete", "missing_data", "missing_tool"].reduce(
    (total, type) => total + count(items, type),
    0,
  );
}

function hasReadableVerification(body) {
  const section =
    body.match(
      /(?:^|\n)## Verification[^\n]*\n([\s\S]*?)(?=\n## |\n<details>|$)/u,
    )?.[1] ?? "";
  return (
    REVIEW_VERIFICATION_LABELS.every((label) => section.includes(label)) &&
    !MARKDOWN_TABLE_DELIMITER.test(section)
  );
}

function scoreComments(expected, outputs) {
  const comments = outputs.filter(
    (item) => item.type === "create_pull_request_review_comment",
  );
  const used = new Set();
  const missed = expected.filter((finding) => {
    const match = comments.findIndex((comment, index) => {
      if (used.has(index)) return false;
      const body =
        typeof comment.body === "string" ? comment.body.toLowerCase() : "";
      return (
        comment.path === finding.path &&
        comment.line === finding.line &&
        finding.bodyIncludes.every((term) => body.includes(term.toLowerCase()))
      );
    });
    if (match >= 0) used.add(match);
    return match < 0;
  });
  return {
    missed,
    falsePositives: comments
      .filter((_comment, index) => !used.has(index))
      .map(({ path: findingPath, line, body }) => ({
        path: findingPath ?? null,
        line: line ?? null,
        body: body ?? null,
      })),
  };
}

export function evaluateReviewRun(
  manifestInput,
  { metadata, profile, prompt, outputs, receipts, errors },
) {
  const manifest = validateManifest(manifestInput);
  invariant(
    SHA.test(metadata?.headSha ?? ""),
    "run.json headSha must be a full commit SHA",
  );
  invariant(
    Array.isArray(outputs) && Array.isArray(receipts) && Array.isArray(errors),
    "agent outputs, errors, and publication receipts must be arrays",
  );
  const expected = manifest.expected;
  const comments = scoreComments(expected.comments, outputs);
  const submits = outputs.filter(
    (item) => item.type === "submit_pull_request_review",
  );
  const submitReceipts = receipts.filter(
    (item) => item.type === "submit_pull_request_review",
  );
  const checks = {
    runConclusion: metadata.conclusion === "success",
    agentErrors: errors.length === 0,
    head:
      metadata.headSha.toLowerCase() === manifest.expectedHeadSha.toLowerCase(),
    profileHash:
      sha256(profile) === manifest.reviewerProfile.sha256.toLowerCase(),
    profileInPrompt: prompt.includes(profile),
    expectedComments: comments.missed.length === 0,
    falsePositives: comments.falsePositives.length === 0,
    reviewEvent:
      expected.terminal !== "review" ||
      (submits.length === 1 &&
        submits[0].event === expected.submitReviewEvent &&
        submitReceipts.length === 1 &&
        submitReceipts[0].metadata?.review_event ===
          expected.submitReviewEvent),
    reviewBody:
      expected.terminal !== "review" ||
      (submits.length === 1 &&
        typeof submits[0].body === "string" &&
        REVIEW_BODY_SECTIONS.every((section) =>
          submits[0].body.includes(section),
        ) &&
        hasReadableVerification(submits[0].body)),
    issueCount: count(outputs, "create_issue") === expected.createIssueCount,
    terminal:
      expected.terminal === "review"
        ? submits.length === 1 &&
          count(outputs, "noop") === 0 &&
          incompleteCount(outputs) === 0
        : expected.terminal === "noop"
          ? count(outputs, "noop") === 1 &&
            submits.length === 0 &&
            incompleteCount(outputs) === 0
          : incompleteCount(outputs) === 1 &&
            submits.length === 0 &&
            count(outputs, "noop") === 0,
    receipts: MUTATIONS.every(
      (type) => count(outputs, type) === count(receipts, type),
    ),
    knownOutputs: outputs.every((item) => OUTPUT_TYPES.has(item.type)),
    knownReceipts: receipts.every((item) => MUTATIONS.includes(item.type)),
  };
  return {
    schemaVersion: 1,
    runId: metadata.runId ?? null,
    headSha: metadata.headSha.toLowerCase(),
    profileSha256: sha256(profile),
    outputs: countByType(outputs),
    receipts: countByType(receipts),
    missedComments: comments.missed,
    falsePositiveComments: comments.falsePositives,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

function parseJsonLines(value, label) {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} line ${index + 1}: ${error.message}`);
      }
    });
}

async function loadRun(manifest, profile, directory) {
  const [metadata, prompt, agentOutput, receipts] = await Promise.all([
    readFile(path.join(directory, "run.json"), "utf8").then(JSON.parse),
    readFile(path.join(directory, "aw-prompts", "prompt.txt"), "utf8"),
    readFile(path.join(directory, "agent_output.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(path.join(directory, "safe-output-items.jsonl"), "utf8").then(
      (value) => parseJsonLines(value, "safe-output-items.jsonl"),
    ),
  ]);
  return evaluateReviewRun(manifest, {
    metadata,
    profile,
    prompt,
    outputs: agentOutput.items,
    errors: agentOutput.errors,
    receipts,
  });
}

function requiredArg(argv, name) {
  const index = argv.indexOf(name);
  invariant(index >= 0 && argv[index + 1], `missing ${name}`);
  return path.resolve(argv[index + 1]);
}

export async function runCli(
  argv = process.argv.slice(2),
  write = (value) => process.stdout.write(`${value}\n`),
) {
  const manifestPath = requiredArg(argv, "--manifest");
  const runsDirectory = requiredArg(argv, "--runs-directory");
  invariant(
    argv.length === 4,
    "only --manifest and --runs-directory are supported",
  );
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const profile = await readFile(
    path.resolve(path.dirname(manifestPath), manifest.reviewerProfile.path),
    "utf8",
  );
  const entries = (await readdir(runsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  invariant(entries.length > 0, "runs directory contains no run directories");
  invariant(
    entries.length === manifest.repeat,
    `expected ${manifest.repeat} run directories, found ${entries.length}`,
  );
  const runs = [];
  for (const entry of entries) {
    runs.push(
      await loadRun(manifest, profile, path.join(runsDirectory, entry.name)),
    );
  }
  const report = {
    schemaVersion: 1,
    expectedHeadSha: manifest.expectedHeadSha.toLowerCase(),
    expectedRuns: manifest.repeat,
    passedRuns: runs.filter((run) => run.passed).length,
    completedRuns: runs.length,
    passed: runs.every((run) => run.passed),
    runs,
  };
  write(JSON.stringify(report, null, 2));
  return report.passed ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, passed: false, error: error.message })}\n`,
      );
      process.exitCode = 1;
    });
}
