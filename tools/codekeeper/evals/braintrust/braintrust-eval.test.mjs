import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BRAINTRUST_PROJECT,
  runBraintrustEvaluation,
} from "./braintrust-eval.mjs";

function dependencies(events, { flushError = null } = {}) {
  class Processor {
    constructor(options) {
      events.processorOptions = options;
      events.processor = this;
    }

    async forceFlush() {
      events.flushes += 1;
      if (flushError) throw flushError;
    }
  }
  return {
    initLogger(options) {
      events.loggerOptions = options;
      return { kind: "logger" };
    },
    OpenAIAgentsTraceProcessor: Processor,
    sdk: {
      setTraceProcessors(processors) {
        events.processors = processors;
      },
    },
  };
}

test("Braintrust evaluation stays opt-in and requires its dedicated credential", async () => {
  let loaded = false;
  await assert.rejects(
    runBraintrustEvaluation({
      environment: {},
      loadBraintrust: async () => {
        loaded = true;
        return dependencies({});
      },
    }),
    /BRAINTRUST_API_KEY is required/,
  );
  assert.equal(loaded, false);
});

test("Braintrust evaluation replaces only the current process trace processor and flushes it", async () => {
  const events = { flushes: 0 };
  const reports = [];
  let evaluationOptions;
  const summary = await runBraintrustEvaluation({
    argv: [
      "--preset",
      "openai",
      "--repeat",
      "2",
      "--scenario",
      "prompt-injection",
    ],
    environment: { BRAINTRUST_API_KEY: "braintrust-secret" },
    loadBraintrust: async () => dependencies(events),
    evaluate: async (options) => {
      evaluationOptions = options;
      return { preset: options.preset, passed: 2, failed: 0, total: 2 };
    },
    report: (line) => reports.push(line),
  });

  assert.equal(events.loggerOptions.apiKey, "braintrust-secret");
  assert.equal(events.loggerOptions.projectName, DEFAULT_BRAINTRUST_PROJECT);
  assert.deepEqual(events.processors, [events.processor]);
  assert.equal(events.flushes, 1);
  assert.equal(evaluationOptions.includeSensitiveTraceData, true);
  assert.equal(evaluationOptions.preset, "openai");
  assert.equal(evaluationOptions.repeat, 2);
  assert.equal(evaluationOptions.scenario, "prompt-injection");
  await evaluationOptions.configureTracing();
  assert.deepEqual(summary, {
    preset: "openai",
    passed: 2,
    failed: 0,
    total: 2,
  });
  assert.match(reports[0], /^SUMMARY preset=openai passed=2 failed=0 total=2$/);
  assert.doesNotMatch(reports.join("\n"), /braintrust-secret/);
});

test("Braintrust evaluation flushes traces when evaluation fails", async () => {
  const events = { flushes: 0 };
  await assert.rejects(
    runBraintrustEvaluation({
      environment: {
        BRAINTRUST_API_KEY: "braintrust-secret",
        BRAINTRUST_PROJECT: "Release candidate",
      },
      loadBraintrust: async () => dependencies(events),
      evaluate: async () => {
        throw new Error("evaluation failed");
      },
      report: () => {},
    }),
    /evaluation failed/,
  );
  assert.equal(events.loggerOptions.projectName, "Release candidate");
  assert.equal(events.flushes, 1);
});

test("Braintrust evaluation can target an existing project by id", async () => {
  const events = { flushes: 0 };
  await runBraintrustEvaluation({
    environment: {
      BRAINTRUST_API_KEY: "braintrust-secret",
      BRAINTRUST_PROJECT: "ignored-name",
      BRAINTRUST_PROJECT_ID: "existing-project-id",
    },
    loadBraintrust: async () => dependencies(events),
    evaluate: async () => ({
      preset: "openai",
      passed: 1,
      failed: 0,
      total: 1,
    }),
    report: () => {},
  });

  assert.deepEqual(events.loggerOptions, {
    apiKey: "braintrust-secret",
    projectId: "existing-project-id",
  });
});
