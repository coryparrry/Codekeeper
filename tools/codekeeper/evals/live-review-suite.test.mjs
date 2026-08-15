import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aggregateReviewScores, loadReviewSuiteRuns, renderReviewSuiteMarkdown, runLiveReviewSuite, scoreReviewResult, validateSuiteManifest } from "./live-review-suite.mjs";

const manifest = {
  version: 1,
  name: "multi-domain-review",
  repeat: 2,
  expectedRecommendation: "block",
  cases: [
    { id: "security", category: "Security", expectedFiles: ["src/archive.mjs"] },
    { id: "concurrency", category: "Concurrency", expectedFiles: ["src/reservations.mjs"] },
  ],
};

function finding(file, title = "Defect") {
  return { title, explanation: "Exact evidence.", severity: "high", confidence: "high", classification: "current", validation: "A deterministic test fails.", preventionTest: "Keep the regression test.", file, line: 12 };
}

function result(overrides = {}) {
  return {
    mode: "review",
    summary: "Two introduced defects block the change.",
    risk: "high",
    labels: ["bug"],
    blockingFindings: [finding("src/archive.mjs", "Archive traversal"), finding("src/reservations.mjs", "Duplicate reservation")],
    nonBlockingFindings: [],
    tests: { adequate: true, notes: "Covered.", missingTest: null },
    diagram: "flowchart LR\nInput --> Validation --> Storage",
    mergeRecommendation: "block",
    noActionReason: null,
    ...overrides,
  };
}

test("manifest validation rejects ambiguous or unsafe answer keys", () => {
  assert.equal(validateSuiteManifest(manifest).cases.length, 2);
  assert.throws(() => validateSuiteManifest({ ...manifest, repeat: 0 }), /manifest.repeat/);
  assert.throws(() => validateSuiteManifest({ ...manifest, cases: [...manifest.cases, { id: "duplicate", category: "Duplicate", expectedFiles: ["src/archive.mjs"] }] }), /belongs to more than one case/);
  assert.throws(() => validateSuiteManifest({ ...manifest, cases: [{ id: "escape", category: "Unsafe", expectedFiles: ["../secret"] }] }), /escapes the repository/);
});

test("scoring matches exact evidence files and rejects false positives or wrong blocking classification", () => {
  const passing = scoreReviewResult(manifest, result(), { runId: 42, runUrl: "https://example.invalid/run/42", headSha: "a".repeat(40) });
  assert.equal(passing.passed, true);
  assert.equal(passing.matched, 2);
  assert.equal(passing.blockingCorrect, 2);
  assert.equal(passing.falsePositiveCount, 0);
  const wrong = scoreReviewResult(manifest, result({
    blockingFindings: [finding("src/archive.mjs")],
    nonBlockingFindings: [finding("src/reservations.mjs"), finding("src/unrelated.mjs")],
    diagram: "flowchart TD\nA --> B",
  }));
  assert.equal(wrong.passed, false);
  assert.equal(wrong.matched, 2);
  assert.equal(wrong.missed, 0);
  assert.equal(wrong.blockingCorrect, 1);
  assert.equal(wrong.falsePositiveCount, 1);
  assert.equal(wrong.diagramValid, false);
});

test("aggregation reports recall, precision, recommendation accuracy, and diagram compliance", () => {
  const first = scoreReviewResult(manifest, result(), { runId: 1 });
  const second = scoreReviewResult(manifest, result({ blockingFindings: [finding("src/archive.mjs")], mergeRecommendation: "manual", diagram: null }), { runId: 2 });
  const report = aggregateReviewScores(manifest, [first, second]);
  assert.equal(report.passedRuns, 1);
  assert.equal(report.matchedFindings, 3);
  assert.equal(report.expectedFindings, 4);
  assert.equal(report.recall, 0.75);
  assert.equal(report.blockingClassificationAccuracy, 0.75);
  assert.equal(report.precision, 1);
  assert.equal(report.recommendationAccuracy, 0.5);
  assert.equal(report.diagramCompliance, 1);
  assert.deepEqual(report.caseResults.map(({ hits }) => hits), [2, 1]);
  assert.match(renderReviewSuiteMarkdown(report), /Recall: \*\*3\/4 \(75\.0%\)\*\*/);
  assert.match(renderReviewSuiteMarkdown(report), /Blocking classification: \*\*3\/4 \(75\.0%\)\*\*/);
});

test("CLI loads run directories and writes create-only JSON and Markdown reports", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-live-eval-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "manifest.json");
  const runsDirectory = path.join(root, "runs");
  await writeFile(manifestPath, JSON.stringify({ ...manifest, repeat: 1 }));
  await mkdir(path.join(runsDirectory, "001"), { recursive: true });
  await writeFile(path.join(runsDirectory, "001", "result.json"), JSON.stringify(result()));
  await writeFile(path.join(runsDirectory, "001", "run.json"), JSON.stringify({ runId: 3187, runUrl: "https://example.invalid/run/3187" }));
  assert.equal((await loadReviewSuiteRuns(runsDirectory, { ...manifest, repeat: 1 }))[0].runId, 3187);
  const jsonOutput = path.join(root, "report", "result.json");
  const markdownOutput = path.join(root, "report", "result.md");
  const messages = [];
  const report = await runLiveReviewSuite({
    argv: ["--manifest", manifestPath, "--runs-directory", runsDirectory, "--json-output", jsonOutput, "--markdown-output", markdownOutput],
    report: (message) => messages.push(message),
  });
  assert.equal(report.passedRuns, 1);
  assert.match(await readFile(markdownOutput, "utf8"), /\[3187\]\(https:\/\/example\.invalid\/run\/3187\)/);
  assert.equal(JSON.parse(await readFile(jsonOutput, "utf8")).matchedFindings, 2);
  assert.deepEqual(messages, ["LIVE_EVAL suite=multi-domain-review passed=1/1 recall=2/2 false_positives=0"]);
  await assert.rejects(() => runLiveReviewSuite({ argv: ["--manifest", manifestPath, "--runs-directory", runsDirectory, "--json-output", jsonOutput, "--markdown-output", markdownOutput] }), /EEXIST/);
});
