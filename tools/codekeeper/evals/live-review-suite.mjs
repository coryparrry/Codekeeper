#!/usr/bin/env node
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { parseArgs } from "../src/lib/io.mjs";
import { assertRepositoryRelativePath, assertRootCauseTags } from "../src/lib/schemas.mjs";

const KNOWN_FLAGS = new Set(["json-output", "manifest", "markdown-output", "runs-directory"]);

export const ANSWER_KEY_SCHEMA_VERSION = 2;
export const RESULT_SCHEMA_VERSION = 2;
export const REPORT_SCHEMA_VERSION = 2;
export const SCORER_VERSION = "2.0.0";

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

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    assert(Number.isFinite(value), "canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  throw new Error("canonical JSON cannot contain undefined or unsupported values");
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalizeRelativePath(value, label) {
  assertRepositoryRelativePath(value, label);
  assert(typeof value === "string" && value.trim(), `${label} must be a non-empty relative path`);
  const normalized = path.posix.normalize(value);
  assert(normalized !== "." && normalized !== ".." && !normalized.startsWith("../"), `${label} escapes the repository`);
  return normalized;
}

function normalizeTags(value, label, { required = true } = {}) {
  if (value === undefined && !required) return [];
  assert(Array.isArray(value) && (required ? value.length > 0 : true), `${label} must be a non-empty array`);
  if (value.length === 0) return [];
  assertRootCauseTags(value, label);
  return [...value];
}

function normalizeLineRanges(value, label) {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return [];
  assert(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array`);
  return value.map((range, index) => {
    assert(Array.isArray(range) && range.length === 2, `${label}[${index}] must contain [start, end]`);
    const [start, end] = range;
    assert(Number.isSafeInteger(start) && start > 0, `${label}[${index}][0] must be a positive integer`);
    assert(Number.isSafeInteger(end) && end >= start, `${label}[${index}][1] must be an integer at or after start`);
    return [start, end];
  });
}

export function validateSuiteManifest(value) {
  const manifest = asObject(structuredClone(value), "manifest");
  const version = manifest.version ?? manifest.schemaVersion;
  assert(version === 1 || version === ANSWER_KEY_SCHEMA_VERSION, `manifest.version must equal 1 or ${ANSWER_KEY_SCHEMA_VERSION}`);
  assert(typeof manifest.name === "string" && manifest.name.trim(), "manifest.name is required");
  assert(Number.isSafeInteger(manifest.repeat) && manifest.repeat >= 1 && manifest.repeat <= 10, "manifest.repeat must be a whole number from 1 through 10");
  assert(typeof manifest.expectedHeadSha === "string" && /^[0-9a-f]{40}$/i.test(manifest.expectedHeadSha), "manifest.expectedHeadSha must be a full commit SHA");
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, "manifest.cases must be a non-empty array");
  const ids = new Set();
  const files = new Set();
  manifest.name = manifest.name.trim();
  manifest.version = version;
  manifest.schemaVersion = version;
  manifest.expectedHeadSha = manifest.expectedHeadSha.toLowerCase();
  manifest.cases = manifest.cases.map((candidate, index) => {
    const entry = asObject(candidate, `manifest.cases[${index}]`);
    assert(typeof entry.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id), `manifest.cases[${index}].id must be kebab-case`);
    assert(!ids.has(entry.id), `duplicate case id: ${entry.id}`);
    ids.add(entry.id);
    assert(typeof entry.category === "string" && entry.category.trim(), `manifest.cases[${index}].category is required`);
    assert(Array.isArray(entry.expectedFiles) && entry.expectedFiles.length > 0, `manifest.cases[${index}].expectedFiles must be non-empty`);
    const expectedFiles = entry.expectedFiles.map((file, fileIndex) => {
      const normalized = normalizeRelativePath(file, `manifest.cases[${index}].expectedFiles[${fileIndex}]`);
      assert(!files.has(normalized), `expected file belongs to more than one case: ${normalized}`);
      files.add(normalized);
      return normalized;
    });
    const legacy = version === 1;
    if (!legacy) {
      assert(Object.hasOwn(entry, "blocking") && typeof entry.blocking === "boolean", `manifest.cases[${index}].blocking must be a boolean`);
      normalizeTags(entry.rootCauseTags, `manifest.cases[${index}].rootCauseTags`);
    }
    return {
      id: entry.id,
      category: entry.category.trim(),
      expectedFiles,
      rootCauseTags: normalizeTags(entry.rootCauseTags, `manifest.cases[${index}].rootCauseTags`, { required: !legacy }),
      expectedLineRanges: normalizeLineRanges(entry.expectedLineRanges, `manifest.cases[${index}].expectedLineRanges`),
      reproductionTest: entry.reproductionTest === undefined || entry.reproductionTest === null
        ? null
        : normalizeRelativePath(entry.reproductionTest, `manifest.cases[${index}].reproductionTest`),
      blocking: legacy ? entry.blocking !== false : entry.blocking,
    };
  });
  manifest.expectedRecommendation = manifest.expectedRecommendation ?? "block";
  assert(["block", "manual", "auto"].includes(manifest.expectedRecommendation), "manifest.expectedRecommendation is invalid");
  return Object.freeze(manifest);
}

function validateFindingEvidence(finding, name, resultSchemaVersion) {
  asObject(finding, name);
  if (resultSchemaVersion >= RESULT_SCHEMA_VERSION) {
    for (const field of ["title", "explanation", "validation", "preventionTest"]) {
      assert(typeof finding[field] === "string" && finding[field].trim(), `${name}.${field} must be a non-empty string`);
    }
    assert(["critical", "high", "medium", "low"].includes(finding.severity), `${name}.severity is invalid`);
    assert(["high", "medium", "low"].includes(finding.confidence), `${name}.confidence is invalid`);
    assert(["current", "stale", "already-fixed", "pre-existing", "preference-only", "not-actionable"].includes(finding.classification), `${name}.classification is invalid`);
  }
  assert(finding.file === null || finding.file === undefined || typeof finding.file === "string", `${name}.file must be a string or null`);
  if (finding.file !== null && finding.file !== undefined) normalizeRelativePath(finding.file, `${name}.file`);
  assert(finding.line === null || finding.line === undefined || (Number.isSafeInteger(finding.line) && finding.line > 0), `${name}.line must be a positive integer or null`);
  if (resultSchemaVersion >= RESULT_SCHEMA_VERSION) {
    normalizeTags(finding.rootCauseTags, `${name}.rootCauseTags`);
    if (finding.reproductionTest !== undefined && finding.reproductionTest !== null) {
      normalizeRelativePath(finding.reproductionTest, `${name}.reproductionTest`);
    }
  }
}

function reviewFindingsForVersion(result, resultSchemaVersion) {
  assert(result?.mode === "review", "result.mode must equal review");
  assert(Array.isArray(result.blockingFindings), "result.blockingFindings must be an array");
  assert(Array.isArray(result.nonBlockingFindings), "result.nonBlockingFindings must be an array");
  result.blockingFindings.forEach((finding, index) => validateFindingEvidence(finding, `blockingFindings[${index}]`, resultSchemaVersion));
  result.nonBlockingFindings.forEach((finding, index) => validateFindingEvidence(finding, `nonBlockingFindings[${index}]`, resultSchemaVersion));
  return [
    ...result.blockingFindings.map((finding) => ({ ...finding, blocking: true })),
    ...result.nonBlockingFindings.map((finding) => ({ ...finding, blocking: false })),
  ];
}

function unpackResult(value, metadata = {}) {
  const input = asObject(value, "result");
  if (Object.hasOwn(input, "result")) {
    assert(input.schemaVersion === RESULT_SCHEMA_VERSION, `result.schemaVersion must equal ${RESULT_SCHEMA_VERSION}`);
    return { result: asObject(input.result, "result.result"), schemaVersion: input.schemaVersion };
  }
  const schemaVersion = metadata.resultSchemaVersion ?? input.schemaVersion ?? 1;
  assert(schemaVersion === 1 || schemaVersion === RESULT_SCHEMA_VERSION, `result schema version must equal 1 or ${RESULT_SCHEMA_VERSION}`);
  return { result: input, schemaVersion };
}

function findingSummary(finding) {
  return finding ? {
    title: finding.title,
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    confidence: finding.confidence,
    blocking: finding.blocking,
    rootCauseTags: finding.rootCauseTags ?? null,
    reproductionTest: finding.reproductionTest ?? null,
  } : null;
}

function lineRangeMatches(finding, expectedLineRanges) {
  if (expectedLineRanges.length === 0) return true;
  return Number.isSafeInteger(finding?.line) && expectedLineRanges.some(([start, end]) => finding.line >= start && finding.line <= end);
}

function reproductionMatches(finding, expectedReproductionTest) {
  if (expectedReproductionTest === null) return true;
  if (typeof finding?.reproductionTest !== "string") return false;
  return normalizeRelativePath(finding.reproductionTest, "finding.reproductionTest") === expectedReproductionTest;
}

function semanticParts(entry, finding, manifestVersion, resultSchemaVersion) {
  const fileLocalized = finding !== null;
  const findingTags = finding && resultSchemaVersion >= RESULT_SCHEMA_VERSION
    ? normalizeTags(finding.rootCauseTags, "finding.rootCauseTags")
    : [];
  const rootCauseCorrect = fileLocalized
    && manifestVersion >= ANSWER_KEY_SCHEMA_VERSION
    && resultSchemaVersion >= RESULT_SCHEMA_VERSION
    && entry.rootCauseTags.every((tag) => findingTags.includes(tag));
  const lineRangeCorrect = fileLocalized && lineRangeMatches(finding, entry.expectedLineRanges);
  const reproductionCorrect = fileLocalized && reproductionMatches(finding, entry.reproductionTest);
  return {
    fileLocalized,
    rootCauseCorrect,
    lineRangeCorrect,
    reproductionCorrect,
    semanticCorrect: rootCauseCorrect && lineRangeCorrect && reproductionCorrect,
  };
}

export function scoreReviewResult(manifestInput, result, metadata = {}) {
  const manifest = validateSuiteManifest(manifestInput);
  const answerKeySha256 = sha256Canonical(manifest);
  const runResultSha256 = sha256Canonical(result);
  const unpacked = unpackResult(result, metadata);
  const findings = reviewFindingsForVersion(unpacked.result, unpacked.schemaVersion);
  const matchedIndexes = new Set();
  const cases = manifest.cases.map((entry) => {
    const isLocalized = (finding) => finding.file !== null && finding.file !== undefined
      && entry.expectedFiles.includes(normalizeRelativePath(finding.file, "finding.file"));
    const semanticCandidate = (finding, index) => !matchedIndexes.has(index)
      && isLocalized(finding)
      && semanticParts(entry, finding, manifest.version, unpacked.schemaVersion).semanticCorrect;
    const localizedCandidate = (finding, index) => !matchedIndexes.has(index) && isLocalized(finding);
    const semanticFindingIndex = manifest.version >= ANSWER_KEY_SCHEMA_VERSION && unpacked.schemaVersion >= RESULT_SCHEMA_VERSION
      ? findings.findIndex(semanticCandidate)
      : -1;
    const findingIndex = semanticFindingIndex >= 0
      ? semanticFindingIndex
      : findings.findIndex(localizedCandidate);
    if (findingIndex >= 0) matchedIndexes.add(findingIndex);
    const finding = findingIndex >= 0 ? findings[findingIndex] : null;
    const { fileLocalized, rootCauseCorrect, lineRangeCorrect, reproductionCorrect, semanticCorrect } = semanticParts(
      entry,
      finding,
      manifest.version,
      unpacked.schemaVersion,
    );
    return {
      id: entry.id,
      category: entry.category,
      found: fileLocalized,
      fileLocalized,
      rootCauseCorrect,
      lineRangeCorrect,
      reproductionCorrect,
      semanticCorrect,
      blockingCorrect: finding !== null && finding.blocking === entry.blocking,
      expectedFiles: entry.expectedFiles,
      expectedRootCauseTags: entry.rootCauseTags,
      expectedLineRanges: entry.expectedLineRanges,
      expectedReproductionTest: entry.reproductionTest,
      finding: findingSummary(finding),
    };
  });
  const falsePositives = findings.filter((_finding, index) => !matchedIndexes.has(index)).map((finding) => ({
    title: finding.title,
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    confidence: finding.confidence,
    blocking: finding.blocking,
    rootCauseTags: finding.rootCauseTags ?? null,
    reproductionTest: finding.reproductionTest ?? null,
  }));
  const diagramValid = unpacked.result.diagram === null || unpacked.result.diagram === undefined || /^flowchart\s+LR\b/.test(unpacked.result.diagram);
  const recommendationCorrect = unpacked.result.mergeRecommendation === manifest.expectedRecommendation;
  const matched = cases.filter((entry) => entry.found).length;
  const semanticCorrect = cases.filter((entry) => entry.semanticCorrect).length;
  const blockingCorrect = cases.filter((entry) => entry.blockingCorrect).length;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    scorerVersion: SCORER_VERSION,
    runId: metadata.runId ?? null,
    runUrl: metadata.runUrl ?? null,
    headSha: metadata.headSha ?? null,
    answerKeySchemaVersion: manifest.version,
    resultSchemaVersion: unpacked.schemaVersion,
    answerKeySha256,
    runResultSha256,
    legacyAnswerKey: manifest.version < ANSWER_KEY_SCHEMA_VERSION,
    legacyResult: unpacked.schemaVersion < RESULT_SCHEMA_VERSION,
    matched,
    expected: cases.length,
    missed: cases.length - matched,
    semanticCorrect,
    semanticIncorrect: cases.length - semanticCorrect,
    semanticAccuracy: roundMetric(semanticCorrect / cases.length),
    blockingCorrect,
    blockingIncorrect: cases.length - blockingCorrect,
    falsePositiveCount: falsePositives.length,
    recommendationCorrect,
    diagramValid,
    passed: manifest.version >= ANSWER_KEY_SCHEMA_VERSION
      && unpacked.schemaVersion >= RESULT_SCHEMA_VERSION
      && matched === cases.length
      && semanticCorrect === cases.length
      && blockingCorrect === cases.length
      && falsePositives.length === 0
      && recommendationCorrect
      && diagramValid,
    cases,
    falsePositives,
  };
}

export function aggregateReviewScores(manifestInput, runs) {
  const manifest = validateSuiteManifest(manifestInput);
  assert(Array.isArray(runs) && runs.length > 0, "at least one scored run is required");
  const expected = manifest.cases.length * runs.length;
  const matched = runs.reduce((total, run) => total + run.matched, 0);
  const semanticCorrect = runs.reduce((total, run) => total + run.semanticCorrect, 0);
  const blockingCorrect = runs.reduce((total, run) => total + run.blockingCorrect, 0);
  const falsePositives = runs.reduce((total, run) => total + run.falsePositiveCount, 0);
  const predicted = matched + falsePositives;
  const caseResults = manifest.cases.map((entry) => {
    const hits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.found).length;
    const semanticHits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.semanticCorrect).length;
    const rootCauseHits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.rootCauseCorrect).length;
    const lineRangeHits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.lineRangeCorrect).length;
    const reproductionHits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.reproductionCorrect).length;
    const blockingHits = runs.filter((run) => run.cases.find((candidate) => candidate.id === entry.id)?.blockingCorrect).length;
    return {
      id: entry.id,
      category: entry.category,
      hits,
      semanticHits,
      rootCauseHits,
      lineRangeHits,
      reproductionHits,
      blockingHits,
      runs: runs.length,
      recall: roundMetric(hits / runs.length),
      semanticAccuracy: roundMetric(semanticHits / runs.length),
      rootCauseAccuracy: roundMetric(rootCauseHits / runs.length),
      lineRangeAccuracy: roundMetric(lineRangeHits / runs.length),
      reproductionAccuracy: roundMetric(reproductionHits / runs.length),
      blockingAccuracy: roundMetric(blockingHits / runs.length),
    };
  });
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    scorerVersion: SCORER_VERSION,
    suite: manifest.name,
    answerKeySchemaVersion: manifest.version,
    resultSchemaVersions: [...new Set(runs.map((run) => run.resultSchemaVersion))].sort((left, right) => left - right),
    answerKeySha256: sha256Canonical(manifest),
    runResultSha256: runs.map((run) => run.runResultSha256),
    runResultDigests: runs.map((run) => ({ runId: run.runId, sha256: run.runResultSha256 })),
    requestedRepeats: manifest.repeat,
    completedRuns: runs.length,
    passedRuns: runs.filter((run) => run.passed).length,
    expectedFindings: expected,
    matchedFindings: matched,
    missedFindings: expected - matched,
    semanticCorrectFindings: semanticCorrect,
    semanticIncorrectFindings: expected - semanticCorrect,
    semanticAccuracy: roundMetric(semanticCorrect / expected),
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
    `- File localization: **${report.matchedFindings}/${report.expectedFindings} (${(report.recall * 100).toFixed(1)}%)**`,
    `- Root-cause semantic correctness: **${report.semanticCorrectFindings}/${report.expectedFindings} (${(report.semanticAccuracy * 100).toFixed(1)}%)**`,
    `- Precision: **${(report.precision * 100).toFixed(1)}%** with ${report.falsePositives} false positives`,
    `- Blocking classification: **${report.blockingClassificationsCorrect}/${report.expectedFindings} (${(report.blockingClassificationAccuracy * 100).toFixed(1)}%)**`,
    `- Merge recommendation accuracy: **${(report.recommendationAccuracy * 100).toFixed(1)}%**`,
    `- Left-to-right diagram compliance: **${(report.diagramCompliance * 100).toFixed(1)}%**`,
    "",
    "## Contract and provenance",
    "",
    `- Report schema: **${report.schemaVersion}**; scorer: **${report.scorerVersion}**`,
    `- Answer-key schema: **${report.answerKeySchemaVersion}**`,
    `- Run-result schema(s): **${report.resultSchemaVersions.join(", ")}**`,
    `- Answer-key SHA-256: **${report.answerKeySha256}**`,
    "- Run-result SHA-256:",
    ...report.runResultDigests.map((entry) => `  - ${entry.runId ?? "run"}: **${entry.sha256}**`),
    "",
    "## Category results",
    "",
    "| Case | Category | File localized | Semantic | Blocking classification |",
    "|---|---|---:|---:|---:|",
    ...report.caseResults.map((entry) => `| ${entry.id} | ${entry.category} | ${entry.hits}/${entry.runs} | ${entry.semanticHits}/${entry.runs} | ${entry.blockingHits}/${entry.runs} |`),
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
    "This report grades file localization, root-cause tags, optional line-range and reproduction-test agreement, blocking classification, false positives, merge recommendation, and diagram direction. File localization is not semantic correctness: a finding that names the right file but the wrong defect is a semantic miss. The digests bind the report to canonical JSON inputs, not to an independently attested GitHub workflow, model trace, provider response, or source-built package.",
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
    runs.push(scoreReviewResult(manifest, result, {
      ...metadata,
      resultSchemaVersion: metadata.resultSchemaVersion ?? result.schemaVersion,
      headSha: metadata.headSha.toLowerCase(),
    }));
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
