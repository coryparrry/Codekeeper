import assert from "node:assert/strict";
import test from "node:test";
import { runBraintrustAgent } from "../integrations/braintrust/run-agent.mjs";

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

function argv() {
  return [
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
  ];
}

function policy(includeSensitiveData = false) {
  return {
    config: {
      ai: { tracing: { enabled: false, includeSensitiveData } },
    },
  };
}

test("Braintrust integration requires separate observability and model credentials", async () => {
  let loaded = false;
  await assert.rejects(
    runBraintrustAgent({
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
    runBraintrustAgent({
      environment: { BRAINTRUST_API_KEY: "braintrust-secret" },
    }),
    /CODEKEEPER_MODEL_API_KEY is required/,
  );

  await assert.rejects(
    runBraintrustAgent({
      environment: {
        BRAINTRUST_API_KEY: "shared-secret",
        CODEKEEPER_MODEL_API_KEY: "shared-secret",
      },
    }),
    /must differ/,
  );
});

test("Braintrust integration traces the real agent bundle and flushes", async () => {
  const events = { flushes: 0 };
  const reports = [];
  let agentOptions;
  const metadata = await runBraintrustAgent({
    argv: argv(),
    environment: {
      BRAINTRUST_API_KEY: "braintrust-secret",
      CODEKEEPER_MODEL_API_KEY: "model-secret",
      BRAINTRUST_PROJECT: "Evaluation project",
      BRAINTRUST_INCLUDE_SENSITIVE_DATA: "true",
    },
    loadBraintrust: async () => dependencies(events),
    loadPolicy: async () => policy(false),
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
    projectName: "Evaluation project",
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
    "BRAINTRUST_PASS mode=review model=gpt-5.6-luna attempt=1 workspace=true",
  ]);
  assert.doesNotMatch(reports.join("\n"), /braintrust-secret|model-secret/);
});

test("Braintrust integration preserves policy sensitivity by default and flushes failures", async () => {
  const events = { flushes: 0 };
  let agentOptions;
  await assert.rejects(
    runBraintrustAgent({
      argv: argv(),
      environment: {
        BRAINTRUST_API_KEY: "braintrust-secret",
        CODEKEEPER_MODEL_API_KEY: "model-secret",
      },
      loadBraintrust: async () => dependencies(events),
      loadPolicy: async () => policy(false),
      runAgent: async (options) => {
        agentOptions = options;
        throw new Error("coordinator failed");
      },
      report: () => {},
    }),
    /coordinator failed/,
  );
  assert.equal(agentOptions.config.ai.tracing.includeSensitiveData, false);
  assert.equal(events.flushes, 1);
});

test("Braintrust integration rejects invalid observability configuration before loading dependencies", async () => {
  let loaded = false;
  await assert.rejects(
    runBraintrustAgent({
      argv: argv(),
      environment: {
        BRAINTRUST_API_KEY: "braintrust-secret",
        CODEKEEPER_MODEL_API_KEY: "model-secret",
        BRAINTRUST_API_URL: "http://braintrust.invalid",
      },
      loadBraintrust: async () => {
        loaded = true;
        return dependencies({});
      },
    }),
    /BRAINTRUST_API_URL must use https/,
  );
  assert.equal(loaded, false);
});
