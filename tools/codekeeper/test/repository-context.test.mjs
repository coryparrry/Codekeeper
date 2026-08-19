import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadTrustedRepositoryContext,
  repositoryContextGate,
  runAgentFromBundle,
  workspaceCodexDeveloperInstructions
} from "../src/lib/agents-runtime.mjs";
import { AGENT_PROFILE_BUNDLE_FILE, agentProfilePathForMode } from "../src/lib/agent-profiles.mjs";
import { sha256 } from "../src/lib/markers.mjs";

const issueResult = Object.freeze({
  mode: "issue",
  summary: "Repository evidence supports manual implementation.",
  type: "bug",
  priority: "p2",
  labels: [],
  actionable: true,
  missingInformation: [],
  duplicateOf: null,
  duplicateConfidence: "none",
  implementationRecommendation: "manual",
  decision: { required: false, question: "", rationale: "", options: [] },
  comment: "The issue is bounded after inspecting the repository."
});

function issueConfig() {
  return {
    ai: {
      tracing: { enabled: true, includeSensitiveData: false },
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "responses",
          structuredOutputs: true,
          supportsReasoningEffort: true
        }
      },
      agents: {
        issue: {
          provider: "openai",
          model: "coordinator-model",
          effort: "low",
          maxTurns: 1,
          maximumAttempts: 2,
          modelSettings: {},
          workspace: {
            enabled: true,
            allowWrites: false,
            model: "workspace-model",
            effort: "low"
          }
        }
      }
    },
    review: { allowedLabels: ["bug", "enhancement"], reasoningEscalation: { enabled: false } }
  };
}

test("workspace developer instructions require repository context from the trusted comparison", () => {
  const baseSha = "1".repeat(40);
  const rootInstructions = "# Repository rules\n\n- Run the repository checks before proposing work.";
  const gate = repositoryContextGate(
    "review",
    { pullRequest: { baseSha } },
    {
      version: 1,
      ref: baseSha,
      instructionFiles: ["AGENTS.md", "src/AGENTS.md"],
      rootPath: "AGENTS.md",
      rootInstructions,
      rootInstructionsSha256: "a".repeat(64),
      rootInstructionsBytes: Buffer.byteLength(rootInstructions)
    }
  );
  assert.match(gate, /REPOSITORY CONTEXT GATE/);
  assert.match(gate, new RegExp(baseSha));
  assert.match(gate, /TRUSTED ROOT AGENTS\.md/);
  assert.match(gate, /Nested AGENTS\.md/);
  assert.match(gate, /src\/AGENTS\.md/);
  assert.match(gate, /Run the repository checks before proposing work/);
  assert.match(gate, /never accept pull-request-head instructions/);
  assert.match(
    workspaceCodexDeveloperInstructions({ type: "object" }),
    /final response to be one JSON object/,
  );
});

test("trusted repository context freezes root instructions from the review base", () => {
  const baseSha = "4".repeat(40);
  const calls = [];
  const context = loadTrustedRepositoryContext(
    "review",
    { pullRequest: { baseSha } },
    {
      cwd: "/repository",
      gitRunner: (args, options) => {
        calls.push({ args, options });
        if (args[0] === "rev-parse") {
          return Buffer.from(`${baseSha}\n`);
        }
        if (args[0] === "ls-tree") {
          return Buffer.from(
            `100644 blob ${"a".repeat(40)}\tAGENTS.md\0` +
              `100644 blob ${"b".repeat(40)}\tsrc/AGENTS.md\0`,
          );
        }
        if (args[0] === "show") {
          return Buffer.from("# Trusted rules\n\nRun npm test.\n");
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      }
    }
  );
  assert.equal(context.ref, baseSha);
  assert.deepEqual(context.instructionFiles, ["AGENTS.md", "src/AGENTS.md"]);
  assert.equal(context.rootPath, "AGENTS.md");
  assert.match(context.rootInstructions, /Run npm test/);
  assert.match(context.rootInstructionsSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls[0].args, ["rev-parse", "--verify", `${baseSha}^{commit}`]);
  assert.deepEqual(calls[1].args, ["ls-tree", "-r", "-z", "--full-tree", baseSha]);
  assert.deepEqual(calls[2].args, ["show", `${baseSha}:AGENTS.md`]);
});

test("fixer repository context uses the pull request base rather than editable head guidance", () => {
  const baseSha = "2".repeat(40);
  const headSha = "3".repeat(40);
  const gate = repositoryContextGate("fix", {
    baseSha: headSha,
    target: { kind: "pull_request", baseSha, headSha }
  }, {
    version: 1,
    ref: baseSha,
    instructionFiles: ["AGENTS.md"],
    rootPath: "AGENTS.md",
    rootInstructions: "# Trusted fixer rules",
    rootInstructionsSha256: "c".repeat(64),
    rootInstructionsBytes: 20
  });
  assert.match(gate, new RegExp(baseSha));
  assert.doesNotMatch(gate, new RegExp(headSha));
});

async function issueBundle(directory, { workspaceEnabled = false, specialist = null, repositoryContext = null } = {}) {
  const profile = "# Trusted issue behavior\n";
  const metadata = {
    path: agentProfilePathForMode("issue"),
    sha256: sha256(Buffer.from(profile)),
    sourceSha: "a".repeat(40)
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { mode: { const: "issue" } },
    required: ["mode"]
  };
  await Promise.all([
    writeFile(path.join(directory, "prompt.md"), "Classify the issue.\n"),
    writeFile(path.join(directory, "schema.json"), JSON.stringify(schema)),
    writeFile(path.join(directory, "context.json"), JSON.stringify({ mode: "issue", agentProfile: metadata })),
    writeFile(path.join(directory, AGENT_PROFILE_BUNDLE_FILE), profile)
  ]);
  if (specialist) {
    await writeFile(path.join(directory, "workspace-result.json"), JSON.stringify(specialist));
    await writeFile(path.join(directory, "workspace-runtime-metadata.json"), JSON.stringify({
      version: 1,
      mode: "issue",
      passes: [{ tier: "configured", model: "workspace-model", effort: "low", durationMs: 12 }],
      postReviewEscalation: null,
      totalDurationMs: 12,
      ...(repositoryContext ? { repositoryContext } : {})
    }));
  }
  const config = issueConfig();
  config.ai.agents.issue.workspace.enabled = workspaceEnabled;
  return config;
}

test("issue workspace evidence becomes authoritative without a second model turn", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-authoritative-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await issueBundle(directory, {
    workspaceEnabled: true,
    specialist: issueResult,
    repositoryContext: { version: 1, ref: "d".repeat(40), instructionFiles: ["AGENTS.md"] }
  });
  let providers = 0;
  const result = await runAgentFromBundle({
    mode: "issue",
    directory,
    config,
    resultPath: path.join(directory, "result.json"),
    apiKey: "provider-secret",
    sdkLoader: async () => ({
      Agent: class {},
      Runner: class {},
      OpenAIProvider: class { constructor() { providers += 1; } }
    })
  });
  assert.equal(JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")).summary, issueResult.summary);
  assert.equal(result.coordinatorSkipped, "workspace-authoritative");
  assert.equal(result.workspaceSpecialistUsed, true);
  assert.equal(result.maxTurns, 0);
  assert.equal(providers, 0);
});

test("issue triage fails safely instead of suggesting work without repository context", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-no-workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await issueBundle(directory, { workspaceEnabled: false });
  let runners = 0;
  const result = await runAgentFromBundle({
    mode: "issue",
    directory,
    config,
    resultPath: path.join(directory, "result.json"),
    apiKey: "provider-secret",
    sdkLoader: async () => ({
      Agent: class {},
      Runner: class { constructor() { runners += 1; } },
      OpenAIProvider: class {}
    })
  });
  const output = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
  assert.equal(output.actionable, false);
  assert.equal(output.implementationRecommendation, "no");
  assert.equal(output.duplicateOf, null);
  assert.equal(result.workspaceSpecialistUsed, false);
  assert.equal(result.coordinatorSkipped, "no-workspace");
  assert.equal(runners, 0);
});
