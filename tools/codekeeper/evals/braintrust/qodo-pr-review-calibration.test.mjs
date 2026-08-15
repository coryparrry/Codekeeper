import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const SELECTION_URL = new URL(
  "./qodo-pr-review-selection-v1.json",
  import.meta.url,
);
const PROMPT_URL = new URL("./qodo-pr-review-prompt-v1.md", import.meta.url);
const SCORER_URL = new URL("./qodo-pr-review-scorer-v1.ts", import.meta.url);

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
