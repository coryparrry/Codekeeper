#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { parseArgs } from "../src/lib/io.mjs";

const KNOWN_FLAGS = new Set(["json-output", "manifest", "markdown-output", "runs-directory"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function roundMetric(value) {
  return Number(value.toFixed(4));
}

function asObject(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

export function validateSuiteManifest(value) {
  const manifest = asObject(structuredClone(value), "manifest");
  assert(manifest.version === 1, "manifest.version must equal 1");
  assert(typeof manifest.name === "string" && manifest.name.trim(), "manifest.name is required");
  assert(Number.isSafeInteger(manifest.repeat) && manifest.repeat >= 1 && manifest.repeat <= 10, "manifest.repeat must be a whole number from 1 through 10");
  assert(typeof manifest.expectedHeadSha === "string" && /^[0-9a-f]{40}$/i.test(manifest.expectedHeadSha), "manifest.expectedHeadSha must be a full commit SHA");
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, "manifest.cases must be a non-empty array");
  const ids = new Set();
  const files = new Set();
  manifest.name = manifest.name.trim();
  manifest.expectedHeadSha = manifest.expectedHeadSha.toLowerCase();
  manifest.cases = manifest.cases.map((candidate, index) => {
    const entry = asObject(candidate, `manifest.cases[${index}]`);
    assert(typeof entry.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id), `manifest.cases[${index}].id must be kebab-case`);
    assert(!ids.has(entry.id), `duplicate case id: ${entry.id}`);
    ids.add(entry.id);
    assert(typeof entry.category === "string" && entry.category.trim(), `manifest.cases[${index}].category is required`);
    assert(Array.isArray(entry.expectedFiles) && entry.expectedFiles.length > 0, `manifest.cases[${index}].expectedFiles must be non-empty`);
    const expectedFiles = entry.expectedFiles.map((file) => {
      assert(typeof file === "string" && file.trim() && !path.isAbsolute(file), `manifest.cases[${index}] expected file must be relative`);
      const normalized = file.split(path.sep).join("/");
      assert(normalized !== ".." && !normalized.startsWith("../"), `manifest.cases[${index}] expected file escapes the repository`);
      assert(!files.has(normalized), `expected file belongs to more than one case: ${normalized}`);
      files.add(normalized);
      return normalized;
    });
    return { id: entry.id, category: entry.category.trim(), expectedFiles, blocking: entry.blocking !== false };
  });
  manifest.expectedRecommendation = manifest.expectedRecommendation ?? "block";
  assert(["block", "manual", "auto"].includes(manifest.expectedRecommendation), "manifest.expectedRecommendation is invalid");
  return Object.freeze(manifest);
}

function reviewFindings(result) {
  assert(result?.mode === "review", "result.mode must equal review");
  assert(Array.isArray(result.blockingFindings), "result.blockingFindings must be an array");
  assert(Array.isArray(result.nonBlockingFindings), "result.nonBlockingFindings must be an array");
  return [
    ...result.blockingFindings.map((finding) => ({ ...finding, blocking: true })),
    ...result.nonBlockingFindings.map((finding) => ({ ...finding, blocking: false })),
  ];
}

export function scoreReviewResult(manifestInput, result, metadata = {}) {
  const manifest = validateSuiteManifest(manifestInput);
  const findings = reviewFindings(result);
  const matchedIndexes = new Set();
  const cases = manifest.cases.map((entry) => {
    const findingIndex = findings.findIndex((finding, index) => !matchedIndexes.has(index)
      && entry.expectedFiles.includes(String(finding.file ?? "").split(path.sep).join("/")));
    if (findingIndex >= 0) matchedIndexes.add(findingIndex);
    const finding = findingIndex >= 0 ? findings[findingIndex] : null;
    return {
      id: entry.id,
      category: entry.category,
      found: finding !== null,
      blockingCorrect: finding !== null && finding.blocking === entry.blocking,
      expectedFiles: entry.expectedFiles,
      finding: finding ? {
        title: finding.title,
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        confidence: finding.confidence,
        blocking: finding.blocking,
      } : null,
    };
  });
  const falsePositives = findings.filter((_finding, index) => !matchedIndexes.has(index)).map((finding) => ({
    title: finding.title,
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    confidence: finding.confidence,
    blocking: finding.blocking,
  }));
  const diagramValid = result.diagram === null || /^flowchart\s+LR\b/.test(result.diagram);
  const recommendationCorrect = result.mergeRecommendation === manifest.expectedRecommendation;
  const matched = cases.filter((entry) => entry.found).length;
  const blockingCorrect = cases.filter((entry) => entry.blockingCorrect).length;
  return {
    runId: metadata.runId ?? null,
    runUrl: metadata.runUrl ?? null,
    headSha: metadata.headSha ?? null,
    matched,
    expected: cases.length,
    missed: cases.length - matched,
    blockingCorrect,
    blockingIncorrect: cases.length - blockingCorrect,
    falsePositiveCount: falsePositives.length,
    recommendationCorrect,
    diagramValid,
    passed: matched === cases.length && blockingCorrect === cases.length && falsePositives.length === 0 && recommendationCorrect && diagramValid,
    cases,
    falsePositives,
  };
}

export function aggregateReviewScores(manifestInput, runs) {
  const manifest = validateSuiteManifest(manifestInput);
  assert(Array.isArray(runs) && runs.length > 0, "at least one scored run is required");
  const expected = manifest.cases.length * runs.length;
  const matched = runs.reduce((total, run) => total + run.matched, 0);
  const blockingCorrect = runs.reduce((total, run) => total + run.blockingCorrect, 0);
  const falsePositives = runs.reduce((total, run) => total + run.falsePositiveCount, 0);
  const predicted = matched + falsePositives;
  const caseResults = manifest.cases.map((entry) => {
    const hits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.found).length;
    const blockingHits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.blockingCorrect).length;
    return {
      id: entry.id,
      category: entry.category,
      hits,
      blockingHits,
      runs: runs.length,
      recall: roundMetric(hits / runs.length),
      blockingAccuracy: roundMetric(blockingHits / runs.length),
    };
  });
  return {
    suite: manifest.name,
    requestedRepeats: manifest.repeat,
    completedRuns: runs.length,
    passedRuns: runs.filter((run) => run.passed).length,
    expectedFindings: expected,
    matchedFindings: matched,
    missedFindings: expected - matched,
    blockingClassificationsCorrect: blockingCorrect,
    blockingClassificationAccuracy: roundMetric(blockingCorrect / expected),
    falsePositives,
    recall: roundMetric(matched / expected),
    precision: predicted === 0 ? 1 : roundMetric(matched / predicted),
    recommendationAccuracy: roundMetric(runs.filter((run) => run.recommendationCorrect).length / runs.length),
    diagramCompliance: roundMetric(runs.filter((run) => run.diagramValid).length / runs.length),
    caseResults,
    runs,
  };
}

export function renderReviewSuiteMarkdown(report) {
  return [
    `# ${report.suite} evaluation`,
    "",
    `Completed ${report.completedRuns}/${report.requestedRepeats} requested runs; ${report.passedRuns} passed every assertion.`,
    "",
    `- Recall: **${report.matchedFindings}/${report.expectedFindings} (${(report.recall * 100).toFixed(1)}%)**`,
    `- Precision: **${(report.precision * 100).toFixed(1)}%** with ${report.falsePositives} false positives`,
    `- Blocking classification: **${report.blockingClassificationsCorrect}/${report.expectedFindings} (${(report.blockingClassificationAccuracy * 100).toFixed(1)}%)**`,
    `- Merge recommendation accuracy: **${(report.recommendationAccuracy * 100).toFixed(1)}%**`,
    `- Left-to-right diagram compliance: **${(report.diagramCompliance * 100).toFixed(1)}%**`,
    "",
    "## Category results",
    "",
    "| Case | Category | Detected | Blocking classification |",
    "|---|---|---:|---:|",
    ...report.caseResults.map((entry) => `| ${entry.id} | ${entry.category} | ${entry.hits}/${entry.runs} | ${entry.blockingHits}/${entry.runs} |`),
    "",
    "## Runs",
    "",
    "| Run | Result | Findings | Blocking classification | False positives | Recommendation | Diagram |",
    "|---|---|---:|---:|---:|---|---|",
    ...report.runs.map((run, index) => {
      const runLabel = run.runUrl ? `[${run.runId ?? index + 1}](${run.runUrl})` : String(run.runId ?? index + 1);
      return `| ${runLabel} | ${run.passed ? "Pass" : "Fail"} | ${run.matched}/${run.expected} | ${run.blockingCorrect}/${run.expected} | ${run.falsePositiveCount} | ${run.recommendationCorrect ? "Correct" : "Wrong"} | ${run.diagramValid ? "LR or none" : "Invalid"} |`;
    }),
    "",
    "## Interpretation boundary",
    "",
    "This report grades detection, blocking classification, evidence localization by file, false positives, merge recommendation, and diagram direction. It does not prove semantic correctness for untested repositories or expose internal workspace tool spans.",
    "",
  ].join("\n");
}

export async function loadReviewSuiteRuns(runsDirectory, manifestInput) {
  const manifest = validateSuiteManifest(manifestInput);
  const entries = (await readdir(runsDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  const runs = [];
  for (const entry of entries) {
    const directory = path.join(runsDirectory, entry.name);
    const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`${entry.name}/run.json is required for immutable-head evaluation`);
      throw error;
    }
    metadata = asObject(metadata, `${entry.name}/run.json`);
    assert(typeof metadata.headSha === "string" && /^[0-9a-f]{40}$/i.test(metadata.headSha), `${entry.name}/run.json headSha must be a full commit SHA`);
    assert(metadata.headSha.toLowerCase() === manifest.expectedHeadSha, `${entry.name}/run.json headSha does not match manifest.expectedHeadSha`);
    runs.push(scoreReviewResult(manifest, result, { ...metadata, headSha: metadata.headSha.toLowerCase() }));
  }
  return runs;
}

export async function runLiveReviewSuite({ argv = process.argv.slice(2), report = (line) => console.log(line) } = {}) {
  const args = parseArgs(argv);
  args.assertKnown(KNOWN_FLAGS);
  const manifestPath = path.resolve(args.require("manifest"));
  const runsDirectory = path.resolve(args.require("runs-directory"));
  const jsonOutput = path.resolve(args.require("json-output"));
  const markdownOutput = path.resolve(args.require("markdown-output"));
  const manifest = validateSuiteManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const scores = await loadReviewSuiteRuns(runsDirectory, manifest);
  const aggregate = aggregateReviewScores(manifest, scores);
  await Promise.all([
    mkdir(path.dirname(jsonOutput), { recursive: true }).then(() => writeFile(jsonOutput, `${JSON.stringify(aggregate, null, 2)}\n`, { flag: "wx" })),
    mkdir(path.dirname(markdownOutput), { recursive: true }).then(() => writeFile(markdownOutput, renderReviewSuiteMarkdown(aggregate), { flag: "wx" })),
  ]);
  report(`LIVE_EVAL suite=${aggregate.suite} passed=${aggregate.passedRuns}/${aggregate.completedRuns} recall=${aggregate.matchedFindings}/${aggregate.expectedFindings} false_positives=${aggregate.falsePositives}`);
  if (aggregate.completedRuns !== aggregate.requestedRepeats) {
    throw new Error(`Live review evaluation completed ${aggregate.completedRuns}/${aggregate.requestedRepeats} requested runs`);
  }
  if (aggregate.passedRuns !== aggregate.requestedRepeats) {
    throw new Error(`Live review evaluation failed because only ${aggregate.passedRuns}/${aggregate.requestedRepeats} runs passed`);
  }
  return aggregate;
}

async function main() {
  await runLiveReviewSuite();
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Live review evaluation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
