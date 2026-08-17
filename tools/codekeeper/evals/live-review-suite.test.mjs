import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { aggregateReviewScores, canonicalJson, loadReviewSuiteRuns, renderReviewSuiteMarkdown, runLiveReviewSuite, scoreReviewResult, sha256Canonical, validateSuiteManifest } from "./live-review-suite.mjs";

const manifest = {
  version: 2,
  name: "multi-domain-review",
  repeat: 2,
  expectedHeadSha: "a".repeat(40),
  expectedRecommendation: "block",
  cases: [
    {
      id: "security",
      category: "Security",
      expectedFiles: ["src/archive.mjs"],
      rootCauseTags: ["path-traversal", "containment-before-write"],
      expectedLineRanges: [[10, 20]],
      reproductionTest: "test/archive-containment.test.mjs",
      blocking: true,
    },
    {
      id: "concurrency",
      category: "Concurrency",
      expectedFiles: ["src/reservations.mjs"],
      rootCauseTags: ["check-before-write", "atomicity"],
      blocking: true,
    },
  ],
};

function finding(file, title = "Defect") {
  const archive = file.includes("archive");
  return {
    title,
    explanation: "Exact evidence.",
    severity: "high",
    confidence: "high",
    classification: "current",
    validation: "A deterministic test fails.",
    preventionTest: "Keep the regression test.",
    rootCauseTags: archive ? ["path-traversal", "containment-before-write"] : ["check-before-write", "atomicity"],
    reproductionTest: archive ? "test/archive-containment.test.mjs" : "test/reservations.test.mjs",
    file,
    line: archive ? 12 : 12,
  };
}

function result(overrides = {}) {
  return {
    schemaVersion: 2,
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
  assert.throws(() => validateSuiteManifest({ ...manifest, cases: [{ ...manifest.cases[0], rootCauseTags: [] }] }), /rootCauseTags/);
  assert.throws(() => validateSuiteManifest({ ...manifest, cases: [{ ...manifest.cases[0], blocking: "yes" }] }), /blocking/);
  assert.throws(() => validateSuiteManifest({ ...manifest, cases: [{ ...manifest.cases[0], expectedLineRanges: [[20, 10]] }] }), /at or after/);
  assert.throws(() => validateSuiteManifest({ ...manifest, repeat: 0 }), /manifest.repeat/);
  assert.throws(() => validateSuiteManifest({ ...manifest, expectedHeadSha: "abc123" }), /expectedHeadSha/);
  assert.throws(() => validateSuiteManifest({ ...manifest, cases: [...manifest.cases, { id: "duplicate", category: "Duplicate", expectedFiles: ["src/archive.mjs"] }] }), /belongs to more than one case/);
  assert.throws(() => validateSuiteManifest({ ...manifest, cases: [{ id: "escape", category: "Unsafe", expectedFiles: ["../secret"] }] }), /traverse parent directories/);
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
  assert.equal(wrong.semanticCorrect, 2);
});

test("semantic scoring rejects a right file with the wrong root cause", () => {
  const wrongRootCause = scoreReviewResult(manifest, result({
    blockingFindings: [finding("src/archive.mjs"), finding("src/reservations.mjs")].map((candidate) => ({
      ...candidate,
      rootCauseTags: ["wrong-defect"],
    })),
  }));
  assert.equal(wrongRootCause.matched, 2);
  assert.equal(wrongRootCause.semanticCorrect, 0);
  assert.equal(wrongRootCause.cases[0].fileLocalized, true);
  assert.equal(wrongRootCause.cases[0].rootCauseCorrect, false);
  assert.equal(wrongRootCause.passed, false);
});

test("v2 matching prefers a semantically correct later finding on the same file", () => {
  const wrong = { ...finding("src/archive.mjs", "Wrong same-file explanation"), rootCauseTags: ["wrong-defect"] };
  const correct = finding("src/archive.mjs", "Correct same-file explanation");
  const singleCaseManifest = { ...manifest, cases: [manifest.cases[0]] };
  const scored = scoreReviewResult(singleCaseManifest, result({ blockingFindings: [wrong, correct], nonBlockingFindings: [] }));
  assert.equal(scored.cases[0].semanticCorrect, true);
  assert.equal(scored.cases[0].finding.title, "Correct same-file explanation");
  assert.equal(scored.falsePositiveCount, 1);
});

test("version two results reject malformed evidence and legacy keys cannot pass semantically", () => {
  assert.throws(() => scoreReviewResult(manifest, result({
    blockingFindings: [finding("src/archive.mjs", "Missing tags")].map(({ rootCauseTags: _rootCauseTags, ...candidate }) => candidate),
  })), /rootCauseTags/);
  const legacyManifest = {
    ...manifest,
    version: 1,
    schemaVersion: undefined,
    cases: manifest.cases.map(({ rootCauseTags: _rootCauseTags, expectedLineRanges: _expectedLineRanges, reproductionTest: _reproductionTest, blocking, ...entry }) => ({ ...entry, blocking })),
  };
  const legacy = scoreReviewResult(legacyManifest, result(), { resultSchemaVersion: 1 });
  assert.equal(legacy.matched, 2);
  assert.equal(legacy.semanticCorrect, 0);
  assert.equal(legacy.passed, false);
  assert.equal(legacy.legacyAnswerKey, true);
  assert.equal(legacy.legacyResult, true);
});

test("raw sealed results can be stamped v2 by run metadata without changing the result object", () => {
  const raw = structuredClone(result());
  delete raw.schemaVersion;
  const scored = scoreReviewResult(manifest, raw, { resultSchemaVersion: 2 });
  assert.equal(scored.resultSchemaVersion, 2);
  assert.equal(scored.semanticCorrect, 2);
  assert.equal(scored.passed, true);
});

test("canonical JSON and report digests are deterministic", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: true, c: 2 } }), '{"a":{"c":2,"d":true},"z":1}');
  assert.equal(sha256Canonical({ z: 1, a: 2 }), sha256Canonical({ a: 2, z: 1 }));
  const run = scoreReviewResult(manifest, result(), { runId: 17 });
  const report = aggregateReviewScores(manifest, [run]);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.scorerVersion, "2.0.0");
  assert.equal(report.answerKeySha256, run.answerKeySha256);
  assert.deepEqual(report.runResultSha256, [run.runResultSha256]);
  assert.match(renderReviewSuiteMarkdown(report), /Answer-key SHA-256/);
  assert.match(renderReviewSuiteMarkdown(report), /Root-cause semantic correctness/);
});

test("aggregation reports recall, precision, recommendation accuracy, and diagram compliance", () => {
  const first = scoreReviewResult(manifest, result(), { runId: 1 });
  const second = scoreReviewResult(manifest, result({ blockingFindings: [finding("src/archive.mjs")], mergeRecommendation: "manual", diagram: null }), { runId: 2 });
  const report = aggregateReviewScores(manifest, [first, second]);
  assert.equal(report.passedRuns, 1);
  assert.equal(report.matchedFindings, 3);
  assert.equal(report.expectedFindings, 4);
  assert.equal(report.semanticCorrectFindings, 3);
  assert.equal(report.semanticAccuracy, 0.75);
  assert.equal(report.recall, 0.75);
  assert.equal(report.blockingClassificationAccuracy, 0.75);
  assert.equal(report.precision, 1);
  assert.equal(report.recommendationAccuracy, 0.5);
  assert.equal(report.diagramCompliance, 1);
  assert.deepEqual(report.caseResults.map(({ hits }) => hits), [2, 1]);
  assert.match(renderReviewSuiteMarkdown(report), /File localization: \*\*3\/4 \(75\.0%\)\*\*/);
  assert.match(renderReviewSuiteMarkdown(report), /Root-cause semantic correctness: \*\*3\/4 \(75\.0%\)\*\*/);
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
  await writeFile(path.join(runsDirectory, "001", "run.json"), JSON.stringify({ runId: 3187, runUrl: "https://example.invalid/run/3187", headSha: manifest.expectedHeadSha }));
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

test("run loading requires immutable metadata for the manifest head", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-live-eval-head-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runsDirectory = path.join(root, "runs");
  await mkdir(path.join(runsDirectory, "001"), { recursive: true });
  await writeFile(path.join(runsDirectory, "001", "result.json"), JSON.stringify(result()));
  await assert.rejects(() => loadReviewSuiteRuns(runsDirectory, manifest), /run.json is required/);
  await writeFile(path.join(runsDirectory, "001", "run.json"), JSON.stringify({ headSha: "b".repeat(40) }));
  await assert.rejects(() => loadReviewSuiteRuns(runsDirectory, manifest), /does not match manifest.expectedHeadSha/);
});

test("CLI writes evidence and then fails closed for incomplete or failing suites", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-live-eval-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "manifest.json");
  const runsDirectory = path.join(root, "runs");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(path.join(runsDirectory, "001"), { recursive: true });
  await writeFile(path.join(runsDirectory, "001", "result.json"), JSON.stringify(result()));
  await writeFile(path.join(runsDirectory, "001", "run.json"), JSON.stringify({ headSha: manifest.expectedHeadSha }));
  const jsonOutput = path.join(root, "incomplete.json");
  const markdownOutput = path.join(root, "incomplete.md");
  await assert.rejects(
    () => runLiveReviewSuite({
      argv: ["--manifest", manifestPath, "--runs-directory", runsDirectory, "--json-output", jsonOutput, "--markdown-output", markdownOutput],
    }),
    /completed 1\/2 requested runs/,
  );
  assert.equal(JSON.parse(await readFile(jsonOutput, "utf8")).completedRuns, 1);

  await writeFile(path.join(runsDirectory, "001", "result.json"), JSON.stringify(result({ blockingFindings: [] })));
  await mkdir(path.join(runsDirectory, "002"), { recursive: true });
  await writeFile(path.join(runsDirectory, "002", "result.json"), JSON.stringify(result()));
  await writeFile(path.join(runsDirectory, "002", "run.json"), JSON.stringify({ headSha: manifest.expectedHeadSha }));
  await assert.rejects(
    () => runLiveReviewSuite({
      argv: ["--manifest", manifestPath, "--runs-directory", runsDirectory, "--json-output", path.join(root, "failing.json"), "--markdown-output", path.join(root, "failing.md")],
    }),
    /only 1\/2 runs passed/,
  );
});
