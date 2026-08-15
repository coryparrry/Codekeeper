import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  ROUTING_POLICY,
  fuseExperimentRows,
  mergeReviewOutputs,
  shouldRouteSecondPass,
  summarizeFusedRows,
} from "./analyze-qodo-pr-review-optimization-v2.mjs";

const SELECTION_URL = new URL(
  "./qodo-pr-review-selection-v1.json",
  import.meta.url,
);
const PROMPT_URL = new URL("./qodo-pr-review-prompt-v1.md", import.meta.url);
const SYSTEMATIC_PROMPT_URL = new URL(
  "./qodo-pr-review-prompt-v2.md",
  import.meta.url,
);
const SCORER_URL = new URL("./qodo-pr-review-scorer-v1.ts", import.meta.url);
const OPTIMIZATION_URL = new URL(
  "./qodo-pr-review-optimization-v2.json",
  import.meta.url,
);

async function scorer() {
  const source = await readFile(SCORER_URL, "utf8");
  const context = vm.createContext({});
  new vm.Script(`${source}\nglobalThis.score = handler;`).runInContext(context);
  return context.score;
}

function scoresByName(scores) {
  return Object.fromEntries(Array.from(scores, (score) => [score.name, score]));
}

const expected = {
  caseId: "qodo-test-1",
  issues: [
    {
      id: "functional-await",
      title: "Missing await on async service call",
      description: "The handler returns before the service promise resolves.",
      file_path: "src/handler.ts",
      start_line: 20,
      end_line: 20,
      rule_name: null,
    },
    {
      id: "functional-auth",
      title: "Authorization bypass accepts regular members",
      description:
        "The inverted permission check lets an unauthorized member create an invite.",
      file_path: "src/invite.ts",
      start_line: 40,
      end_line: 42,
      rule_name: null,
    },
  ],
};

const exactFindings = [
  {
    file: "src/handler.ts",
    line: 20,
    severity: "high",
    title: "Async service call is not awaited",
    reason:
      "The handler returns before the promise resolves and exposes incomplete data.",
  },
  {
    file: "src/invite.ts",
    line: 41,
    severity: "critical",
    title: "Permission check authorizes regular members",
    reason:
      "The reversed authorization branch permits an unauthorized member to create invites.",
  },
];

test("Qodo selection is pinned, balanced, and fully locatable", async () => {
  const selection = JSON.parse(await readFile(SELECTION_URL, "utf8"));
  assert.equal(selection.version, 1);
  assert.equal(selection.source.dataset, "Qodo/PR-Review-Bench");
  assert.match(selection.source.revision, /^[a-f0-9]{40}$/);
  assert.match(selection.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(selection.cases.length, 30);
  assert.equal(new Set(selection.cases.map((row) => row.id)).size, 30);
  const counts = Object.fromEntries(
    [...new Set(selection.cases.map((row) => row.repo))]
      .sort()
      .map((repo) => [
        repo,
        selection.cases.filter((row) => row.repo === repo).length,
      ]),
  );
  assert.deepEqual(counts, {
    Ghost: 4,
    aspnetcore: 4,
    "cal.com": 4,
    dify: 4,
    "firefox-ios": 4,
    prefect: 4,
    redis: 3,
    tauri: 3,
  });
  for (const row of selection.cases) {
    assert.match(row.id, /^qodo-[a-z0-9-]+$/);
    assert.match(row.base, /^[a-f0-9]{40}$/);
    assert.match(row.head, /^[a-f0-9]{40}$/);
    assert.ok(row.issues >= 4);
    assert.ok(row.changedFiles >= 3);
  }
});

test("Qodo prompt fixes the evidence and output boundaries", async () => {
  const prompt = await readFile(PROMPT_URL, "utf8");
  assert.match(prompt, /\{\{input\.caseId\}\}/);
  assert.match(prompt, /\{\{input\.diff\}\}/);
  assert.match(prompt, /added\/right-hand side/);
  assert.match(prompt, /Do not report pre-existing problems/);
  assert.match(prompt, /Return at most 15 findings/);
  assert.match(prompt, /one compact JSON object and no Markdown/);
});

test("systematic Medium prompt requires complete bounded review passes", async () => {
  const prompt = await readFile(SYSTEMATIC_PROMPT_URL, "utf8");
  assert.match(prompt, /Do not stop after the first obvious defect/);
  assert.match(prompt, /Compile and contract/);
  assert.match(prompt, /Control and data flow/);
  assert.match(prompt, /Safety and lifecycle/);
  assert.match(prompt, /Integration and platform behavior/);
  assert.match(prompt, /every added or modified hunk/);
  assert.match(prompt, /Return at most 15 findings/);
});

test("retained Medium optimization results preserve the experiment boundary", async () => {
  const result = JSON.parse(await readFile(OPTIMIZATION_URL, "utf8"));
  assert.equal(result.version, 3);
  assert.equal(result.model, "gpt-5.6-luna");
  assert.equal(result.reasoningEffort, "medium");
  assert.equal(result.maxConcurrency, 1);
  assert.equal(result.singlePass.runs.length, 2);
  assert.ok(result.singlePass.runs.every((run) => run.errors === 0));
  assert.equal(result.selectiveFusion.routedCases, 21);
  assert.equal(result.selectiveFusion.mean.functionalRecall, 0.6028);
  assert.match(result.selectiveFusion.status, /not a single Braintrust pipeline experiment/);
  assert.match(result.maxEscalation.status, /without a separate Max evaluation/);
  assert.match(result.maxEscalation.status, /qualifying blockers receive one focused Max replacement pass/);
  assert.ok(result.maxEscalation.nonTriggers.includes("Medium overall risk high"));
  assert.equal(result.maxEscalation.evaluation, "not run");
  assert.equal(result.maxEscalation.highIsNotAProxy, true);
});

test("selective Medium fusion routes large diffs and suppresses nearby duplicates", () => {
  assert.equal(shouldRouteSecondPass({ changedFiles: 6, additions: 1, deletions: 1 }), true);
  assert.equal(shouldRouteSecondPass({ changedFiles: 2, additions: 300, deletions: 100 }), true);
  assert.equal(shouldRouteSecondPass({ changedFiles: 5, additions: 300, deletions: 99 }), false);
  assert.deepEqual(ROUTING_POLICY, {
    minimumChangedFiles: 6,
    minimumChangedLines: 400,
    duplicateLineDistance: 6,
    maximumFindings: 15,
  });

  const primary = {
    caseId: "qodo-test-1",
    findings: [
      { file: "src/a.ts", line: 20, title: "Primary defect" },
      { file: "src/b.ts", line: 4, title: "Separate primary defect" },
    ],
  };
  const secondary = {
    caseId: "qodo-test-1",
    findings: [
      { file: "src/a.ts", line: 26, title: "Nearby duplicate" },
      { file: "src/a.ts", line: 27, title: "Distinct defect" },
      { file: "src/c.ts", line: 20, title: "Same line, different file" },
    ],
  };
  assert.deepEqual(mergeReviewOutputs(primary, secondary).findings.map((finding) => finding.title), [
    "Primary defect",
    "Separate primary defect",
    "Distinct defect",
    "Same line, different file",
  ]);
});

test("selective Medium fusion leaves small diffs on the primary pass", () => {
  const primaryRows = [
    {
      input: { caseId: "small" },
      output: { caseId: "small", findings: [] },
      expected: { caseId: "small", issues: [] },
      metadata: { changedFiles: 2, additions: 20, deletions: 10 },
    },
    {
      input: { caseId: "large" },
      output: { caseId: "large", findings: [] },
      expected: { caseId: "large", issues: [] },
      metadata: { changedFiles: 6, additions: 20, deletions: 10 },
    },
  ];
  const secondaryRows = [
    {
      input: { caseId: "large" },
      output: {
        caseId: "large",
        findings: [{ file: "src/a.ts", line: 1, title: "Found on second pass" }],
      },
      metrics: { llm_duration: 2, estimated_cost: 0.01 },
    },
  ];
  const fused = fuseExperimentRows(primaryRows, secondaryRows);
  assert.equal(fused[0].routed, false);
  assert.deepEqual(fused[0].output.findings, []);
  assert.equal(fused[1].routed, true);
  assert.equal(fused[1].output.findings.length, 1);

  const summary = summarizeFusedRows(fused, ({ output }) => [
    { name: "finding count", score: output.findings.length },
  ]);
  assert.equal(summary.cases, 2);
  assert.equal(summary.routedCases, 1);
  assert.equal(summary.metrics["finding count"], 0.5);
  assert.equal(summary.secondaryTotals.llmDuration, 2);
  assert.equal(summary.secondaryTotals.estimatedCost, 0.01);
});

test("Qodo scorer emits perfect metrics for localized paraphrases", async () => {
  const score = await scorer();
  const metrics = scoresByName(
    score({
      output: JSON.stringify({
        caseId: expected.caseId,
        findings: exactFindings,
      }),
      expected,
    }),
  );
  for (const metric of Object.values(metrics))
    assert.equal(metric.score, 1, metric.name);
});

test("Qodo scorer separates recall from false-positive precision", async () => {
  const score = await scorer();
  const extra = {
    file: "src/other.ts",
    line: 99,
    severity: "medium",
    title: "Speculative unrelated failure",
    reason: "This does not match the frozen ground truth.",
  };
  const withExtra = scoresByName(
    score({
      output: JSON.stringify({
        caseId: expected.caseId,
        findings: [...exactFindings, extra],
      }),
      expected,
    }),
  );
  assert.equal(withExtra["Qodo overall recall"].score, 1);
  assert.equal(withExtra["Qodo precision"].score, 2 / 3);
  assert.equal(withExtra["Qodo F1"].score, 0.8);

  const missing = scoresByName(
    score({
      output: { caseId: expected.caseId, findings: exactFindings.slice(0, 1) },
      expected,
    }),
  );
  assert.equal(missing["Qodo functional recall"].score, 0.5);
  assert.equal(missing["Qodo overall recall"].score, 0.5);
  assert.equal(missing["Qodo precision"].score, 1);
});

test("Qodo scorer fails closed on malformed or mislocalized output", async () => {
  const score = await scorer();
  const malformed = scoresByName(score({ output: "not json", expected }));
  assert.ok(Object.values(malformed).every((metric) => metric.score === 0));

  const wrongCase = scoresByName(
    score({ output: { caseId: "wrong", findings: exactFindings }, expected }),
  );
  assert.ok(Object.values(wrongCase).every((metric) => metric.score === 0));

  const wrongLine = scoresByName(
    score({
      output: {
        caseId: expected.caseId,
        findings: [{ ...exactFindings[0], line: 200 }],
      },
      expected,
    }),
  );
  assert.equal(wrongLine["Qodo overall recall"].score, 0);
  assert.equal(wrongLine["Qodo precision"].score, 0);
});
