import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseEvaluationArgs,
  runDecisionEvaluation,
} from "../decision-quality.mjs";

export const DEFAULT_BRAINTRUST_PROJECT = "CodeKeeper";

export async function runBraintrustEvaluation({
  argv = process.argv.slice(2),
  environment = process.env,
  report = (line) => console.log(line),
  loadBraintrust = async () => {
    const [{ initLogger }, { OpenAIAgentsTraceProcessor }, sdk] =
      await Promise.all([
        import("braintrust"),
        import("@braintrust/openai-agents"),
        import("@openai/agents"),
      ]);
    return { initLogger, OpenAIAgentsTraceProcessor, sdk };
  },
  evaluate = runDecisionEvaluation,
} = {}) {
  const apiKey = environment.BRAINTRUST_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      "BRAINTRUST_API_KEY is required for Braintrust evaluation tracing",
    );
  const options = parseEvaluationArgs(argv);
  if (options.offline)
    throw new Error(
      "Braintrust evaluation tracing requires live provider runs",
    );

  const projectName =
    environment.BRAINTRUST_PROJECT?.trim() || DEFAULT_BRAINTRUST_PROJECT;
  const projectId = environment.BRAINTRUST_PROJECT_ID?.trim();
  const { initLogger, OpenAIAgentsTraceProcessor, sdk } =
    await loadBraintrust();
  if (typeof sdk.setTraceProcessors !== "function") {
    throw new Error(
      "Installed @openai/agents package does not export setTraceProcessors",
    );
  }
  const logger = initLogger({
    apiKey,
    ...(projectId ? { projectId } : { projectName }),
  });
  const processor = new OpenAIAgentsTraceProcessor({ logger });
  sdk.setTraceProcessors([processor]);

  try {
    const summary = await evaluate({
      ...options,
      sdkLoader: async () => sdk,
      configureTracing: async () => {},
      includeSensitiveTraceData: true,
      report,
    });
    report(
      `SUMMARY preset=${summary.preset} passed=${summary.passed} failed=${summary.failed} total=${summary.total}`,
    );
    return summary;
  } finally {
    await processor.forceFlush();
  }
}

async function main() {
  await runBraintrustEvaluation();
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`Braintrust evaluation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
