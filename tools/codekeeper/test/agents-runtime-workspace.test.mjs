import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  AGENT_PROFILE_BUNDLE_FILE,
  MAX_AGENT_PROFILE_BYTES,
  agentProfilePathForMode,
  loadTrustedAgentProfile,
  resolveAgentProfileInputs
} from "../src/lib/agent-profiles.mjs";
import {
  authenticateCodexCli,
  buildFocusedMaxReviewPrompt,
  buildCoordinatorInput,
  coordinatorPromptCacheKey,
  coordinatorInstructions,
  enforceCoordinatorEvidenceBoundary,
  loadCoordinatorProfile,
  loadTrustedRepositoryContext,
  modelSettingsFor,
  parseAgentOutput,
  reviewResultEscalation,
  runAgentFromBundle,
  runConfiguredAgent,
  runWorkspaceAgentFromBundle,
  structuredOutputType,
  workspaceCodexDeveloperInstructions
} from "../src/lib/agents-runtime.mjs";
import { issueSchema, providerCompatibleJsonSchema, validateIssueResult } from "../src/lib/schemas.mjs";
import { sha256 } from "../src/lib/markers.mjs";
import { evaluateAutoMerge } from "../src/lib/policy.mjs";
import { CODEX_BIN } from "../src/lib/runtime-paths.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
);

const schema = {
  type: "object",
  additionalProperties: false,
  properties: { mode: { const: "issue" }, summary: { type: "string" } },
  required: ["mode", "summary"]
};

function withoutTracing() {
  const value = structuredClone(config);
  value.ai.tracing.enabled = false;
  return value;
}

function validIssue(overrides = {}) {
  return {
    mode: "issue",
    summary: "The report is reproducible.",
    type: "bug",
    priority: "p3",
    labels: [],
    actionable: true,
    missingInformation: [],
    duplicateOf: null,
    duplicateConfidence: "none",
    implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] },
    comment: "Thank you for the clear report.",
    ...overrides
  };
}

function validReview(overrides = {}) {
  return {
    mode: "review",
    summary: "No blocking defect was found.",
    risk: "medium",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    tests: { adequate: true, notes: "Covered.", missingTest: null },
    diagram: null,
    mergeRecommendation: "manual",
    noActionReason: "No validated defect was found.",
    ...overrides
  };
}

const trustedSourceSha = "a".repeat(40);
const trustedHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

async function profileFixture(mode, contents = `# ${mode} behavior\n`) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-profile-"));
  const profilePath = path.join(root, agentProfilePathForMode(mode));
  await mkdir(path.dirname(profilePath), { recursive: true });
  await writeFile(profilePath, contents);
  return { root, profilePath };
}

test("workspace execution runs one Codex MCP session through the Agents SDK", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-workspace-bundle-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputSchema = providerCompatibleJsonSchema(issueSchema(config));
  const resultPath = path.join(directory, "workspace-result.json");
  await Promise.all([
    writeFile(path.join(directory, "workspace-prompt.md"), "Inspect the issue against the checkout.\n"),
    writeFile(path.join(directory, "schema.json"), JSON.stringify(outputSchema)),
    writeFile(path.join(directory, "context.json"), JSON.stringify({ mode: "issue" }))
  ]);

  const calls = { connected: 0, closed: 0, order: [] };
  class FakeMCPServerStdio {
    constructor(options) { calls.options = options; }
    async connect() { calls.connected += 1; calls.order.push("connect"); }
    async close() { calls.closed += 1; }
    async listTools() { return [{ name: "codex" }]; }
    async callToolResult(name, args) {
      calls.tool = { name, args };
      return {
        structuredContent: {
          threadId: "thread-1",
          content: JSON.stringify(validIssue())
        },
        content: []
      };
    }
  }
  const workspaceConfig = withoutTracing();
  workspaceConfig.ai.agents.issue.workspace.enabled = true;
  workspaceConfig.ai.agents.issue.workspace.model = "gpt-5.6-luna";
  workspaceConfig.ai.agents.issue.workspace.effort = "max";
  const metadata = await runWorkspaceAgentFromBundle({
    mode: "issue",
    directory,
    config: workspaceConfig,
    resultPath,
    apiKey: "workspace-secret",
    environment: {
      CODEX_HOME: path.join(directory, "codex-home"),
      HOME: directory,
      PATH: "/usr/bin",
      GITHUB_TOKEN: "must-not-cross-boundary"
    },
    sdkLoader: async () => ({ MCPServerStdio: FakeMCPServerStdio }),
    codexCommand: "/usr/bin/node",
    codexArgs: ["/runtime/codex.js", "mcp-server"],
    codexLoginArgs: ["/runtime/codex.js", "login", "--with-api-key"],
    codexAuthenticator: async (options) => {
      calls.auth = options;
      calls.order.push("authenticate");
    }
  });

  assert.deepEqual(calls.order, ["authenticate", "connect"]);
  assert.equal(calls.auth.apiKey, "workspace-secret");
  assert.deepEqual(calls.auth.args, ["/runtime/codex.js", "login", "--with-api-key"]);
  assert.equal(calls.auth.environment.OPENAI_API_KEY, undefined);
  assert.equal(calls.auth.environment.GITHUB_TOKEN, undefined);
  assert.equal(calls.connected, 1);
  assert.equal(calls.closed, 1);
  assert.deepEqual(calls.options.args, ["/runtime/codex.js", "mcp-server"]);
  assert.equal(calls.options.cwd, process.cwd());
  assert.equal(calls.options.timeout, 20 * 60 * 1000);
  assert.equal(calls.options.env.OPENAI_API_KEY, undefined);
  assert.equal(calls.options.env.GITHUB_TOKEN, undefined);
  assert.equal(calls.tool.name, "codex");
  assert.equal(calls.tool.args.model, "gpt-5.6-luna");
  assert.equal(calls.tool.args.sandbox, "read-only");
  assert.deepEqual(calls.tool.args.config, { model_reasoning_effort: "max" });
  assert.match(calls.tool.args.prompt, /REPOSITORY CONTEXT GATE/);
  assert.match(calls.tool.args.prompt, /Inspect the issue against the checkout\./);
  assert.match(calls.tool.args["developer-instructions"], /The trusted runtime requires the final response/);
  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), validIssue());
  assert.deepEqual(metadata, { completed: true, passes: 1, postReviewEscalated: false });
  const workspaceMetadata = JSON.parse(
    await readFile(path.join(directory, "workspace-runtime-metadata.json"), "utf8")
  );
  assert.equal(workspaceMetadata.mode, "issue");
  assert.equal(workspaceMetadata.passes.length, 1);
  assert.equal(workspaceMetadata.passes[0].tier, "configured");
  assert.equal(workspaceMetadata.postReviewEscalation, null);
  assert.equal(workspaceMetadata.totalDurationMs, workspaceMetadata.passes[0].durationMs);
});
test("workspace execution injects trusted context without writing the frozen prompt", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-readonly-workspace-prompt-"));
  context.after(async () => {
    await chmod(path.join(directory, "workspace-prompt.md"), 0o600).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const resultPath = path.join(directory, "workspace-result.json");
  const originalPrompt = "Inspect the issue against the checkout.\n";
  await Promise.all([
    writeFile(path.join(directory, "workspace-prompt.md"), originalPrompt),
    writeFile(path.join(directory, "schema.json"), JSON.stringify(providerCompatibleJsonSchema(issueSchema(config)))),
    writeFile(path.join(directory, "context.json"), JSON.stringify({ mode: "issue", baseSha: trustedHeadSha }))
  ]);
  await chmod(path.join(directory, "workspace-prompt.md"), 0o400);

  let prompt;
  class FakeMCPServerStdio {
    async connect() {}
    async close() {}
    async listTools() { return [{ name: "codex" }]; }
    async callToolResult(_name, args) {
      prompt = args.prompt;
      return { structuredContent: { content: JSON.stringify(validIssue()) }, content: [] };
    }
  }
  const workspaceConfig = withoutTracing();
  workspaceConfig.ai.agents.issue.workspace.enabled = true;
  await runWorkspaceAgentFromBundle({
    mode: "issue",
    directory,
    config: workspaceConfig,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: async () => ({ MCPServerStdio: FakeMCPServerStdio }),
    codexAuthenticator: async () => {}
  });

  assert.match(prompt, /REPOSITORY CONTEXT GATE/);
  assert.match(prompt, /Inspect the issue against the checkout/);
  assert.equal(await readFile(path.join(directory, "workspace-prompt.md"), "utf8"), originalPrompt);
});

test("workspace review keeps only normalized left-to-right diagrams without losing validated findings", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-workspace-review-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = path.join(directory, "workspace-result.json");
  await Promise.all([
    writeFile(path.join(directory, "workspace-prompt.md"), "Review the pull request.\n"),
    writeFile(path.join(directory, "schema.json"), JSON.stringify({ type: "object" })),
    writeFile(path.join(directory, "context.json"), JSON.stringify({
      mode: "review",
      pullRequest: {
        baseSha: trustedHeadSha,
        labels: ["security"],
        changedFiles: ["src/total.mjs"],
        changeSummary: { changedLines: 20, largestFileChangedLines: 20 }
      }
    }))
  ]);

  const review = {
    mode: "review",
    summary: "The changed calculation has a validated defect.",
    risk: "high",
    labels: [],
    blockingFindings: [{
      title: "Incorrect total",
      explanation: "The changed calculation returns the wrong total.",
      severity: "high",
      confidence: "high",
      classification: "current",
      validation: "The focused regression test fails on the current head.",
      preventionTest: "Run the focused total regression test.",
      rootCauseTags: ["incorrect-total"],
      reproductionTest: "test/total.test.mjs",
      file: "src/total.mjs",
      line: 12
    }],
    nonBlockingFindings: [],
    reviewFeedback: [],
    tests: { adequate: false, notes: "The regression is not covered.", missingTest: "Add a total regression test for the failing input and expect the correct total." },
    diagram: "graph LR\nCatalog --> Pricing --> Checkout",
    mergeRecommendation: "block",
    noActionReason: null
  };
  let workspaceArgs;
  class FakeMCPServerStdio {
    async connect() {}
    async close() {}
    async listTools() { return [{ name: "codex" }]; }
    async callToolResult(_name, args) {
      workspaceArgs = args;
      return { structuredContent: { content: JSON.stringify(review) }, content: [] };
    }
  }
  const workspaceConfig = withoutTracing();
  workspaceConfig.ai.agents.review.workspace.enabled = true;
  await runWorkspaceAgentFromBundle({
    mode: "review",
    directory,
    config: workspaceConfig,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: async () => ({ MCPServerStdio: FakeMCPServerStdio }),
    codexAuthenticator: async () => {}
  });

  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(workspaceArgs.model, "gpt-5.6-luna");
  assert.deepEqual(workspaceArgs.config, { model_reasoning_effort: "max" });
  assert.equal(result.diagram, "flowchart LR\nCatalog --> Pricing --> Checkout");
  assert.deepEqual(result.blockingFindings, review.blockingFindings);

  review.diagram = "flowchart TD\nCatalog --> Pricing --> Checkout";
  await runWorkspaceAgentFromBundle({
    mode: "review",
    directory,
    config: workspaceConfig,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: async () => ({ MCPServerStdio: FakeMCPServerStdio }),
    codexAuthenticator: async () => {}
  });
  assert.equal(JSON.parse(await readFile(resultPath, "utf8")).diagram, null);
});

test("a located Medium high-impact blocker triggers one focused Max pass in the same workspace", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-workspace-focused-max-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = path.join(directory, "workspace-result.json");
  await Promise.all([
    writeFile(path.join(directory, "workspace-prompt.md"), "Review the pull request.\n"),
    writeFile(path.join(directory, "schema.json"), JSON.stringify({ type: "object" })),
    writeFile(path.join(directory, "context.json"), JSON.stringify({
      mode: "review",
      pullRequest: {
        baseSha: trustedHeadSha,
        labels: [],
        changedFiles: ["src/feature.mjs"],
        changeSummary: { changedLines: 20, largestFileChangedLines: 20 }
      }
    }))
  ]);
  const blocker = {
    title: "Authorization is bypassed",
    explanation: "The changed branch skips the authorization guard.",
    severity: "high",
    confidence: "high",
    classification: "current",
    validation: "The focused unauthorized request reaches the protected operation.",
    preventionTest: "Assert that the unauthorized request is rejected.",
    rootCauseTags: ["authorization-bypass"],
    reproductionTest: "test/authorization.test.mjs",
    file: "src/feature.mjs",
    line: 10
  };
  const mediumReview = validReview({
    summary: "Medium found a high-impact blocker.",
    risk: "high",
    blockingFindings: [blocker],
    mergeRecommendation: "block",
    noActionReason: null
  });
  const maxReview = validReview({
    summary: "Max independently validated the blocker.",
    risk: "high",
    blockingFindings: [{ ...blocker, validation: "Max traced the bypass through the protected caller." }],
    mergeRecommendation: "block",
    noActionReason: null
  });
  const calls = [];
  class FakeMCPServerStdio {
    async connect() {}
    async close() {}
    async listTools() { return [{ name: "codex" }]; }
    async callToolResult(_name, args) {
      calls.push(args);
      return {
        structuredContent: { content: JSON.stringify(calls.length === 1 ? mediumReview : maxReview) },
        content: []
      };
    }
  }
  const workspaceConfig = withoutTracing();
  let timestamp = 1_000;
  const metadata = await runWorkspaceAgentFromBundle({
    mode: "review",
    directory,
    config: workspaceConfig,
    resultPath,
    apiKey: "workspace-secret",
    environment: { CODEX_HOME: path.join(directory, "codex-home"), PATH: "/usr/bin" },
    sdkLoader: async () => ({ MCPServerStdio: FakeMCPServerStdio }),
    codexAuthenticator: async () => {},
    now: () => {
      const value = timestamp;
      timestamp += 25;
      return value;
    }
  });

  assert.deepEqual(metadata, { completed: true, passes: 2, postReviewEscalated: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "gpt-5.6-luna");
  assert.deepEqual(calls[0].config, { model_reasoning_effort: "medium" });
  assert.equal(calls[1].model, "gpt-5.6-luna");
  assert.deepEqual(calls[1].config, { model_reasoning_effort: "max" });
  assert.match(calls[1].prompt, /src\/feature\.mjs/);
  assert.match(calls[1].prompt, /PRIOR MEDIUM RESULT/);
  assert.equal(JSON.parse(await readFile(resultPath, "utf8")).summary, maxReview.summary);
  const workspaceMetadata = JSON.parse(
    await readFile(path.join(directory, "workspace-runtime-metadata.json"), "utf8"),
  );
  assert.equal(workspaceMetadata.version, 1);
  assert.equal(workspaceMetadata.mode, "review");
  assert.deepEqual(workspaceMetadata.passes, [
    { tier: "configured", model: "gpt-5.6-luna", effort: "medium", durationMs: 25 },
    { tier: "focused-max", model: "gpt-5.6-luna", effort: "max", durationMs: 25 }
  ]);
  assert.deepEqual(workspaceMetadata.postReviewEscalation, {
    reasons: ["blocking-finding:high"],
    files: ["src/feature.mjs"],
    findingCount: 1
  });
  assert.equal(workspaceMetadata.totalDurationMs, 50);
  assert.equal(workspaceMetadata.repositoryContext.ref, trustedHeadSha);
});
