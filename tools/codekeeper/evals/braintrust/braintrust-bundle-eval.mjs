import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/lib/config.mjs";
import { runAgentFromBundle } from "../../src/lib/agents-runtime.mjs";
import { parseArgs } from "../../src/lib/io.mjs";
import { assertRunnerOwnedDirectory } from "../../src/lib/workspace.mjs";
import { DEFAULT_BRAINTRUST_PROJECT } from "./braintrust-eval.mjs";

const KNOWN_FLAGS = new Set([
  "config",
  "directory",
  "mode",
  "result",
  "workspace-result",
]);
const MODES = new Set(["review", "audit", "issue", "fix"]);

function bundleFile(directory, filePath, flag) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(directory, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `--${flag} must be a file inside the runner-owned --directory`,
    );
  }
  return resolved;
}

export async function runBraintrustBundleEvaluation({
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
  loadPolicy = loadConfig,
  runAgent = runAgentFromBundle,
} = {}) {
  const apiKey = environment.BRAINTRUST_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      "BRAINTRUST_API_KEY is required for Braintrust bundle tracing",
    );
  const modelApiKey = environment.CODEKEEPER_MODEL_API_KEY?.trim();
  if (!modelApiKey)
    throw new Error(
      "CODEKEEPER_MODEL_API_KEY is required for the coordinator model",
    );

  const args = parseArgs(argv);
  args.assertKnown(KNOWN_FLAGS);
  const mode = args.require("mode");
  if (!MODES.has(mode)) throw new Error(`Unknown agent mode: ${mode}`);
  const directory = assertRunnerOwnedDirectory(args.require("directory"));
  const resultPath = bundleFile(directory, args.require("result"), "result");
  const workspaceResultPath = bundleFile(
    directory,
    args.get("workspace-result", path.join(directory, "workspace-result.json")),
    "workspace-result",
  );
  const { config } = await loadPolicy(args.require("config"));
  const evaluationConfig = structuredClone(config);
  evaluationConfig.ai.tracing.enabled = true;
  evaluationConfig.ai.tracing.includeSensitiveData = true;

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
    const metadata = await runAgent({
      mode,
      directory,
      config: evaluationConfig,
      resultPath,
      workspaceResultPath,
      apiKey: modelApiKey,
      sdkLoader: async () => sdk,
      configureTracing: async () => {},
    });
    report(
      `BUNDLE_PASS mode=${mode} model=${metadata.model} attempt=${metadata.attempt} workspace=${metadata.workspaceSpecialistUsed}`,
    );
    return metadata;
  } finally {
    await processor.forceFlush();
  }
}

async function main() {
  await runBraintrustBundleEvaluation();
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`Braintrust bundle evaluation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
