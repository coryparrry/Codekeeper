import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const DATASET_URL = new URL("./luna-flow-dataset-v1.json", import.meta.url);
const PROMPT_URL = new URL("./luna-flow-prompt-v1.md", import.meta.url);
const SCORER_URL = new URL("./luna-flow-scorer-v1.ts", import.meta.url);
const EXPECTED_KEYS = [
  "caseId",
  "decision",
  "findingKeys",
  "blockingKeys",
  "duplicateOf",
  "patchOption",
];

async function dataset() {
  return JSON.parse(await readFile(DATASET_URL, "utf8"));
}

async function scorer() {
  const source = await readFile(SCORER_URL, "utf8");
  const context = vm.createContext({});
  new vm.Script(`${source}\nglobalThis.score = handler;`).runInContext(context);
  return context.score;
}

test("Luna flow dataset covers each complex flow with stable exact contracts", async () => {
  const rows = await dataset();
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.deepEqual(
    Object.fromEntries(
      ["issue", "review", "fix"].map((flow) => [
        flow,
        rows.filter((row) => row.metadata.flow === flow).length,
      ]),
    ),
    { issue: 4, review: 4, fix: 4 },
  );
  assert.deepEqual(
    [...new Set(rows.map((row) => row.metadata.difficulty))].sort(),
    ["easy", "hard", "medium"],
  );
  for (const row of rows) {
    assert.equal(row.id, row.expected.caseId);
    assert.equal(typeof row.input.case, "string");
    assert.match(row.input.case, new RegExp(`CASE ID: ${row.id}`));
    assert.deepEqual(Object.keys(row.expected), EXPECTED_KEYS);
    assert.ok(Array.isArray(row.expected.findingKeys));
    assert.ok(Array.isArray(row.expected.blockingKeys));
    assert.ok(
      row.expected.blockingKeys.every((key) =>
        row.expected.findingKeys.includes(key),
      ),
    );
    assert.ok(Array.isArray(row.metadata.sourcePaths));
    assert.ok(row.metadata.sourcePaths.length > 0);
  }
});

test("Luna flow prompt requires compact source-bounded output", async () => {
  const prompt = await readFile(PROMPT_URL, "utf8");
  assert.match(prompt, /\{\{input\.case\}\}/);
  assert.match(prompt, /Copy the exact non-empty value after `CASE ID:`/);
  assert.match(prompt, /Only PR review emits `findingKeys` or `blockingKeys`/);
  assert.match(prompt, /both arrays must be empty/);
  assert.match(prompt, /smallest complete safe patch option/);
  assert.match(prompt, /Return exactly one compact JSON object/);
});

test("Braintrust scorer passes exact outputs and rejects every contract mutation", async () => {
  const rows = await dataset();
  const score = await scorer();
  for (const row of rows) {
    const exact = score({
      output: JSON.stringify(row.expected),
      expected: row.expected,
    });
    assert.equal(exact.score, 1, row.id);
    assert.deepEqual(Array.from(exact.metadata.failed), []);

    const mutations = [
      { ...row.expected, caseId: `${row.id}-wrong` },
      { ...row.expected, decision: "manual" },
      { ...row.expected, findingKeys: [...row.expected.findingKeys, "extra.mjs:1"] },
      { ...row.expected, blockingKeys: [...row.expected.blockingKeys, "extra.mjs:1"] },
      { ...row.expected, duplicateOf: row.expected.duplicateOf === null ? 999 : null },
      { ...row.expected, patchOption: row.expected.patchOption === null ? "Z" : null },
    ];
    for (const mutation of mutations) {
      assert.ok(
        score({ output: mutation, expected: row.expected }).score < 1,
        `${row.id} mutation should fail`,
      );
    }
  }
});

test("Braintrust scorer accepts fenced JSON but fails closed on malformed output", async () => {
  const [row] = await dataset();
  const score = await scorer();
  const fence = String.fromCharCode(96, 96, 96);
  assert.equal(
    score({
      output: `${fence}json\n${JSON.stringify(row.expected)}\n${fence}`,
      expected: row.expected,
    }).score,
    1,
  );
  assert.equal(score({ output: "not json", expected: row.expected }).score, 0);
  assert.equal(score({ output: row.expected, expected: null }).score, 0);
});
