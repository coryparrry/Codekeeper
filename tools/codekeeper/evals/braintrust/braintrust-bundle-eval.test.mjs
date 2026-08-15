import assert from "node:assert/strict";
import test from "node:test";
import { runBraintrustBundleEvaluation } from "./braintrust-bundle-eval.mjs";

function dependencies(events) {
  class Processor {
    constructor(options) {
      events.processor = this;
      events.processorOptions = options;
    }

    async forceFlush() {
      events.flushes += 1;
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

test("bundle tracing requires both observability and coordinator credentials before loading dependencies", async () => {
  let loaded = false;
  await assert.rejects(
    runBraintrustBundleEvaluation({
      environment: {},
      loadBraintrust: async () => {
        loaded = true;
        return dependencies({});
      },
    }),
    /BRAINTRUST_API_KEY is required/,
  );
  assert.equal(loaded, false);

  await assert.rejects(
    runBraintrustBundleEvaluation({
      environment: { BRAINTRUST_API_KEY: "braintrust-secret" },
      loadBraintrust: async () => {
        loaded = true;
        return dependencies({});
      },
    }),
    /CODEKEEPER_MODEL_API_KEY is required/,
  );
  assert.equal(loaded, false);
});

test("bundle tracing evaluates the real workspace result with sensitive evaluation trace data", async () => {
  const events = { flushes: 0 };
  const reports = [];
  let agentOptions;
  const metadata = await runBraintrustBundleEvaluation({
    argv: [
      "--config",
      "/fixture/config.json",
      "--directory",
      "/private/tmp/codekeeper-braintrust-bundle",
      "--mode",
      "review",
      "--workspace-result",
      "/private/tmp/codekeeper-braintrust-bundle/workspace-result.json",
      "--result",
      "/private/tmp/codekeeper-braintrust-bundle/result.json",
    ],
    environment: {
      BRAINTRUST_API_KEY: "braintrust-secret",
      CODEKEEPER_MODEL_API_KEY: "model-secret",
      BRAINTRUST_PROJECT_ID: "project-id",
    },
    loadBraintrust: async () => dependencies(events),
    loadPolicy: async () => ({
      config: {
        ai: { tracing: { enabled: false, includeSensitiveData: false } },
      },
    }),
    runAgent: async (options) => {
      agentOptions = options;
      return {
        model: "gpt-5.6-luna",
        attempt: 1,
        workspaceSpecialistUsed: true,
      };
    },
    report: (line) => reports.push(line),
  });

  assert.deepEqual(events.loggerOptions, {
    apiKey: "braintrust-secret",
    projectId: "project-id",
  });
  assert.deepEqual(events.processors, [events.processor]);
  assert.equal(events.flushes, 1);
  assert.equal(agentOptions.apiKey, "model-secret");
  assert.equal(agentOptions.config.ai.tracing.enabled, true);
  assert.equal(agentOptions.config.ai.tracing.includeSensitiveData, true);
  assert.equal(typeof agentOptions.configureTracing, "function");
  assert.deepEqual(metadata, {
    model: "gpt-5.6-luna",
    attempt: 1,
    workspaceSpecialistUsed: true,
  });
  assert.deepEqual(reports, [
    "BUNDLE_PASS mode=review model=gpt-5.6-luna attempt=1 workspace=true",
  ]);
  assert.doesNotMatch(reports.join("\n"), /braintrust-secret|model-secret/);
});

test("bundle tracing flushes when the coordinator fails", async () => {
  const events = { flushes: 0 };
  await assert.rejects(
    runBraintrustBundleEvaluation({
      argv: [
        "--config",
        "/fixture/config.json",
        "--directory",
        "/private/tmp/codekeeper-braintrust-bundle",
        "--mode",
        "review",
        "--result",
        "/private/tmp/codekeeper-braintrust-bundle/result.json",
      ],
      environment: {
        BRAINTRUST_API_KEY: "braintrust-secret",
        CODEKEEPER_MODEL_API_KEY: "model-secret",
      },
      loadBraintrust: async () => dependencies(events),
      loadPolicy: async () => ({
        config: {
          ai: { tracing: { enabled: true, includeSensitiveData: false } },
        },
      }),
      runAgent: async () => {
        throw new Error("coordinator failed");
      },
      report: () => {},
    }),
    /coordinator failed/,
  );
  assert.equal(events.flushes, 1);
});
