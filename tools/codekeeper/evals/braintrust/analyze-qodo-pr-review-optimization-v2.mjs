import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const ROUTING_POLICY = Object.freeze({
  minimumChangedFiles: 6,
  minimumChangedLines: 400,
  duplicateLineDistance: 6,
  maximumFindings: 15,
});

function parseOutput(output) {
  const parsed = typeof output === "string" ? JSON.parse(output) : output;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Experiment output must be a JSON object");
  }
  if (typeof parsed.caseId !== "string" || !Array.isArray(parsed.findings)) {
    throw new Error("Experiment output must contain caseId and findings");
  }
  return parsed;
}

function rowsByCase(rows, label) {
  if (!Array.isArray(rows)) throw new Error(`${label} export must be a JSON array`);
  const indexed = new Map();
  for (const row of rows) {
    const caseId = row?.input?.caseId;
    if (typeof caseId !== "string" || !caseId) throw new Error(`${label} row is missing input.caseId`);
    if (indexed.has(caseId)) throw new Error(`${label} contains duplicate case ${caseId}`);
    indexed.set(caseId, row);
  }
  return indexed;
}

export function shouldRouteSecondPass(metadata = {}, policy = ROUTING_POLICY) {
  const changedFiles = Number(metadata.changedFiles ?? 0);
  const changedLines = Number(metadata.additions ?? 0) + Number(metadata.deletions ?? 0);
  return changedFiles >= policy.minimumChangedFiles || changedLines >= policy.minimumChangedLines;
}

function nearbyFinding(findings, candidate, policy) {
  return findings.some(
    (finding) =>
      finding.file === candidate.file &&
      Number.isSafeInteger(finding.line) &&
      Number.isSafeInteger(candidate.line) &&
      Math.abs(finding.line - candidate.line) <= policy.duplicateLineDistance,
  );
}

export function mergeReviewOutputs(primaryOutput, secondaryOutput, policy = ROUTING_POLICY) {
  const primary = parseOutput(primaryOutput);
  const secondary = parseOutput(secondaryOutput);
  if (primary.caseId !== secondary.caseId) {
    throw new Error(`Cannot merge different cases: ${primary.caseId} and ${secondary.caseId}`);
  }
  const findings = [...primary.findings];
  for (const finding of secondary.findings) {
    if (!nearbyFinding(findings, finding, policy)) findings.push(finding);
    if (findings.length === policy.maximumFindings) break;
  }
  return { caseId: primary.caseId, findings };
}

export function fuseExperimentRows(primaryRows, secondaryRows, policy = ROUTING_POLICY) {
  rowsByCase(primaryRows, "Primary");
  const secondaryByCase = rowsByCase(secondaryRows, "Secondary");
  return primaryRows.map((row) => {
    if (!shouldRouteSecondPass(row.metadata, policy)) return { ...row, output: parseOutput(row.output), routed: false };
    const secondary = secondaryByCase.get(row.input.caseId);
    if (!secondary) throw new Error(`Secondary export is missing routed case ${row.input.caseId}`);
    return {
      ...row,
      output: mergeReviewOutputs(row.output, secondary.output, policy),
      routed: true,
      secondaryMetrics: secondary.metrics,
    };
  });
}

export function summarizeFusedRows(rows, score) {
  const totals = {};
  let metricNames;
  for (const row of rows) {
    const scored = score({ output: row.output, expected: row.expected });
    const currentNames = scored.map((metric) => metric.name);
    metricNames ??= currentNames;
    if (currentNames.join("\0") !== metricNames.join("\0")) throw new Error("Scorer returned inconsistent metrics");
    for (const metric of scored) totals[metric.name] = (totals[metric.name] ?? 0) + metric.score;
  }
  const metrics = Object.fromEntries(metricNames.map((name) => [name, totals[name] / rows.length]));
  const routedRows = rows.filter((row) => row.routed);
  const secondaryTotals = routedRows.reduce(
    (total, row) => ({
      llmDuration: total.llmDuration + Number(row.secondaryMetrics?.llm_duration ?? 0),
      estimatedCost: total.estimatedCost + Number(row.secondaryMetrics?.estimated_cost ?? 0),
      promptTokens: total.promptTokens + Number(row.secondaryMetrics?.prompt_tokens ?? 0),
      cachedPromptTokens: total.cachedPromptTokens + Number(row.secondaryMetrics?.prompt_cached_tokens ?? 0),
      completionTokens: total.completionTokens + Number(row.secondaryMetrics?.completion_tokens ?? 0),
      reasoningTokens: total.reasoningTokens + Number(row.secondaryMetrics?.completion_reasoning_tokens ?? 0),
    }),
    { llmDuration: 0, estimatedCost: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
  );
  return { cases: rows.length, routedCases: routedRows.length, metrics, secondaryTotals };
}

async function loadScorer(filePath) {
  const source = await readFile(filePath, "utf8");
  const context = vm.createContext({});
  new vm.Script(`${source}\nglobalThis.score = handler;`).runInContext(context);
  return context.score;
}

async function main() {
  const [primaryPath, secondaryPath, scorerPath] = process.argv.slice(2);
  if (!primaryPath || !secondaryPath || !scorerPath) {
    throw new Error("Usage: analyze-qodo-pr-review-optimization-v2.mjs PRIMARY_EXPORT SECONDARY_EXPORT SCORER");
  }
  const [primaryRows, secondaryRows, score] = await Promise.all([
    readFile(primaryPath, "utf8").then(JSON.parse),
    readFile(secondaryPath, "utf8").then(JSON.parse),
    loadScorer(scorerPath),
  ]);
  const summary = summarizeFusedRows(fuseExperimentRows(primaryRows, secondaryRows), score);
  process.stdout.write(`${JSON.stringify({ routingPolicy: ROUTING_POLICY, ...summary }, null, 2)}\n`);
}

if (typeof process !== "undefined" && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
