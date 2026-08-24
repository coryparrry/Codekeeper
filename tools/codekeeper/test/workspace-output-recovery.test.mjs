import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runWorkspaceAgentFromBundle } from "../src/lib/agents-runtime-core.mjs";

const sourceConfig = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8"),
);

function validReview(overrides = {}) {
  return {
    mode: "review",
    summary: "No blocking defect was found.",
    risk: "low",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    tests: { adequate: true, notes: "The changed behavior is covered.", missingTest: null },
    diagram: null,
    mergeRecommendation: "manual",
    noActionReason: null,
    ...overrides,
  };
}

function validFix(overrides = {}) {
  return {
    mode: "fix",
    summary: "Implemented the requested regression repair.",
    risk: "low",
    targetKind: "issue",
    targetNumber: 63,
    changedSummary: "Updated the implementation and its regression test.",
    testsRun: [{ command: "npm test", result: "passed" }],
    resolvedReviewThreadIds: [],
    readyForReview: true,
    noChangeReason: null,
    ...overrides,
  };
}

async function writeBundle(context, t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-workspace-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([
    writeFile(path.join(directory, "workspace-prompt.md"), "Inspect the current checkout and return the requested result.\n"),
    writeFile(path.join(directory, "schema.json"), JSON.stringify({ type: "object" })),
    writeFile(path.join(directory, "context.json"), JSON.stringify(context)),
  ]);
  return { directory, resultPath: path.join(directory, "workspace-result.json") };
}

function fakeSdk(outputs, calls) {
  return async () => ({
    MCPServerStdio: class {
      async connect() {}
      async close() {}
      async listTools() { return [{ name: "codex" }]; }
      async callToolResult(name, args) {
        calls.push({ name, args });
        if (outputs.length === 0) throw new Error("No fake workspace output remains");
        return { structuredContent: { content: outputs.shift() }, content: [] };
      }
    },
  });
}

function reviewContext() {
  return {
    mode: "review",
    pullRequest: {
      labels: [],
      changedFiles: ["src/example.mjs"],
      changeSummary: { changedLines: 20, largestFileChangedLines: 20 },
    },
  };
}

test("workspace review repairs a malformed final response instead of failing the workflow", async (t) => {
  const { directory, resultPath } = await writeBundle(reviewContext(), t);
  const config = structuredClone(sourceConfig);
  config.review.reasoningEscalation.enabled = false;
  config.ai.agents.review.maximumAttempts = 2;
  const calls = [];

  const result = await runWorkspaceAgentFromBundle({
    mode: "review",
    directory,
    config,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: fakeSdk([
      "Review completed, but the object was truncated: {\"mode\":\"review\"",
      validReview(),
    ], calls),
    codexAuthenticator: async () => {},
  });

  assert.deepEqual(result, { completed: true, passes: 1, postReviewEscalated: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.sandbox, "read-only");
  assert.equal(calls[1].args.sandbox, "read-only");
  assert.match(calls[1].args.prompt, /WORKSPACE OUTPUT REPAIR ATTEMPT 2/);
  assert.match(calls[1].args.prompt, /did not contain one valid top-level JSON object/);
  assert.match(calls[1].args.prompt, /PREVIOUS RESPONSE \(UNTRUSTED DRAFT/);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), validReview());

  const metadata = JSON.parse(
    await readFile(path.join(directory, "workspace-runtime-metadata.json"), "utf8"),
  );
  assert.equal(metadata.passes.length, 1);
  assert.equal(metadata.passes[0].attempts, 2);
});

test("workspace Fixer repairs schema-invalid output without mutating the checkout twice", async (t) => {
  const context = { mode: "fix", target: { kind: "issue", number: 63 } };
  const { directory, resultPath } = await writeBundle(context, t);
  const config = structuredClone(sourceConfig);
  config.ai.agents.fix.maximumAttempts = 2;
  const calls = [];

  await runWorkspaceAgentFromBundle({
    mode: "fix",
    directory,
    config,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: fakeSdk([
      JSON.stringify(validFix({ risk: "impossible" })),
      validFix(),
    ], calls),
    codexAuthenticator: async () => {},
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.sandbox, "workspace-write");
  assert.equal(calls[1].args.sandbox, "read-only");
  assert.match(calls[1].args.prompt, /risk must be one of low, medium, high/);
  assert.match(calls[1].args.prompt, /Do not edit it again/);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), validFix());
});

test("independent fixer clusters launch one workspace agent each", async (t) => {
  const context = {
    mode: "fix",
    target: { kind: "pull_request", number: 74, reviewThreadIds: [] },
    repairClusters: [
      {
        id: "settlement",
        items: [{
          kind: "finding",
          title: "FX exposure truncation",
          file: "src/settlement.mjs",
          line: 65,
          explanation: "Integer division floors converted exposure.",
          validation: "Round up."
        }]
      },
      {
        id: "idempotency",
        items: [{
          kind: "finding",
          title: "TTL counted twice",
          file: "src/idempotency.mjs",
          line: 50,
          explanation: "Expiry adds the TTL twice.",
          validation: "Expire once."
        }]
      }
    ]
  };
  const { directory, resultPath } = await writeBundle(context, t);
  const config = structuredClone(sourceConfig);
  const calls = [];
  const first = validFix({
    targetKind: "pull_request",
    targetNumber: 74,
    summary: "Rounded FX exposure up.",
    changedSummary: "Use ceiling rounding in settlement."
  });
  const second = validFix({
    targetKind: "pull_request",
    targetNumber: 74,
    summary: "Expired idempotency keys once.",
    changedSummary: "Compare against expiresAt."
  });

  const metadata = await runWorkspaceAgentFromBundle({
    mode: "fix",
    directory,
    config,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: fakeSdk([JSON.stringify(first), JSON.stringify(second)], calls),
    codexAuthenticator: async () => {},
  });

  assert.deepEqual(metadata, { completed: true, passes: 2, postReviewEscalated: false, fixerAgents: 2 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].args.prompt, /ASSIGNED REPAIR CLUSTER 1 of 2/);
  assert.match(calls[0].args.prompt, /FX exposure truncation/);
  assert.doesNotMatch(calls[0].args.prompt, /TTL counted twice/);
  assert.match(calls[1].args.prompt, /ASSIGNED REPAIR CLUSTER 2 of 2/);
  assert.match(calls[1].args.prompt, /TTL counted twice/);
  const merged = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(merged.readyForReview, true);
  assert.match(merged.changedSummary, /ceiling rounding/);
  assert.match(merged.changedSummary, /expiresAt/);
});

test("larger fixer plans use one bounded workspace pass until isolation is available", async (t) => {
  const context = {
    mode: "fix",
    target: { kind: "pull_request", number: 74, reviewThreadIds: [] },
    repairClusters: ["settlement", "idempotency", "ledger"].map((id) => ({
      id,
      items: [{
        kind: "finding",
        title: `${id} defect`,
        file: `src/${id}.mjs`,
        line: 1,
        explanation: `${id} is wrong.`,
        validation: `Fix ${id}.`
      }]
    }))
  };
  const { directory, resultPath } = await writeBundle(context, t);
  const config = structuredClone(sourceConfig);
  const calls = [];
  const metadata = await runWorkspaceAgentFromBundle({
    mode: "fix",
    directory,
    config,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: fakeSdk([JSON.stringify(validFix({ targetKind: "pull_request", targetNumber: 74 }))], calls),
    codexAuthenticator: async () => {},
  });

  assert.equal(metadata.passes, 1);
  assert.equal(metadata.fixerAgents, undefined);
  assert.equal(calls.length, 1);
});

test("workspace output recovery remains bounded by the configured attempt limit", async (t) => {
  const { directory, resultPath } = await writeBundle(reviewContext(), t);
  const config = structuredClone(sourceConfig);
  config.review.reasoningEscalation.enabled = false;
  config.ai.agents.review.maximumAttempts = 2;
  const calls = [];

  await assert.rejects(
    runWorkspaceAgentFromBundle({
      mode: "review",
      directory,
      config,
      resultPath,
      apiKey: "workspace-secret",
      environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
      sdkLoader: fakeSdk(["not-json", "still-not-json"], calls),
      codexAuthenticator: async () => {},
    }),
    /workspace configured pass failed after 2 attempt\(s\)/,
  );
  assert.equal(calls.length, 2);
});
