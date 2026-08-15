#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELECTION_PATH = path.join(
  SCRIPT_DIR,
  "qodo-pr-review-selection-v1.json",
);
const OUTPUT_PATH = process.argv[2];
const GITHUB_OWNER = "agentic-review-benchmarks";
const MAX_CONCURRENCY = 6;

if (!OUTPUT_PATH) {
  throw new Error("Usage: prepare-qodo-pr-review-bench-v1.mjs <output.json>");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "Codekeeper-Qodo-calibration/1" },
    redirect: "follow",
  });
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function mapConcurrent(values, worker) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, values.length) }, run),
  );
  return results;
}

function parsePrNumber(url) {
  const value = Number(url.split("/").at(-1));
  if (!Number.isInteger(value)) throw new Error(`Invalid PR URL: ${url}`);
  return value;
}

const selection = JSON.parse(await readFile(SELECTION_PATH, "utf8"));
if (selection.version !== 1 || selection.cases.length !== 30) {
  throw new Error("Qodo selection must contain exactly 30 version-1 cases");
}

const sourceUrl = `https://huggingface.co/datasets/${selection.source.dataset}/resolve/${selection.source.revision}/${selection.source.file}`;
const sourceText = await fetchText(sourceUrl);
if (sha256(sourceText) !== selection.source.sha256) {
  throw new Error("Pinned Qodo source checksum mismatch");
}
const sourceRows = sourceText
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

const dataset = await mapConcurrent(selection.cases, async (selected) => {
  const source = sourceRows.find(
    (row) =>
      row.repo === selected.repo &&
      parsePrNumber(row.pr_url_to_review) === selected.pr,
  );
  if (!source) throw new Error(`Missing source row for ${selected.id}`);
  if (
    source.num_of_issues !== selected.issues ||
    source.issues.length !== selected.issues
  ) {
    throw new Error(`Ground-truth count changed for ${selected.id}`);
  }
  if (
    source.issues.some(
      (issue) =>
        typeof issue.file_path !== "string" ||
        !Number.isInteger(issue.start_line) ||
        !Number.isInteger(issue.end_line),
    )
  ) {
    throw new Error(`Unlocatable ground truth in ${selected.id}`);
  }

  const compareUrl = `https://github.com/${GITHUB_OWNER}/${selected.repo}/compare/${selected.base}...${selected.head}.diff`;
  const diff = await fetchText(compareUrl);
  if (!diff.startsWith("diff --git "))
    throw new Error(`Invalid unified diff for ${selected.id}`);
  const issues = source.issues.map((issue, index) => ({
    id: `${selected.id}-issue-${index + 1}`,
    ...issue,
    rule_name: issue.rule_name ?? null,
  }));
  const functionalIssues = issues.filter(
    (issue) => issue.rule_name === null,
  ).length;

  return {
    input: {
      caseId: selected.id,
      repository: `${GITHUB_OWNER}/${selected.repo}`,
      prUrl: source.pr_url_to_review,
      baseCommit: selected.base,
      headCommit: selected.head,
      diff,
    },
    expected: { caseId: selected.id, issues },
    metadata: {
      benchmark: "Qodo PR-Review-Bench",
      benchmarkRevision: selection.source.revision,
      repository: selected.repo,
      prNumber: selected.pr,
      issueCount: selected.issues,
      functionalIssues,
      ruleIssues: selected.issues - functionalIssues,
      changedFiles: selected.changedFiles,
      additions: selected.additions,
      deletions: selected.deletions,
      diffLines: diff.split("\n").length - 1,
      diffBytes: Buffer.byteLength(diff),
    },
    tags: ["qodo", "pr-review", selected.repo],
  };
});

await writeFile(
  path.resolve(OUTPUT_PATH),
  `${JSON.stringify(dataset, null, 2)}\n`,
  "utf8",
);
const totalIssues = dataset.reduce(
  (sum, row) => sum + row.expected.issues.length,
  0,
);
const totalBytes = dataset.reduce(
  (sum, row) => sum + row.metadata.diffBytes,
  0,
);
process.stdout.write(
  `Prepared ${dataset.length} cases with ${totalIssues} issues and ${totalBytes} diff bytes at ${path.resolve(OUTPUT_PATH)}\n`,
);
