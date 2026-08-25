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

test("configured agent selects the issue provider and retries contract-invalid JSON", async () => {
  const calls = { attempts: 0, closed: false };
  class FakeProvider {
    constructor(options) { calls.provider = options; }
    async close() { calls.closed = true; }
  }
  class FakeAgent {
    constructor(options) { calls.agent = options; }
  }
  class FakeRunner {
    constructor(options) { calls.runner = options; }
    async run(_agent, input, options) {
      calls.attempts += 1;
      calls.input = input;
      calls.runOptions = options;
      return {
        finalOutput: calls.attempts === 1
          ? JSON.stringify(validIssue({ implementationRecommendation: "unsupported" }))
          : JSON.stringify(validIssue()),
        state: {
          usage: {
            requests: 1,
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            inputTokensDetails: [{ cached_tokens: calls.attempts, cache_write_tokens: calls.attempts }]
          }
        }
      };
    }
  }
  const result = await runConfiguredAgent({
    mode: "issue",
    config: withoutTracing(),
    prompt: "Classify this issue.",
    schema,
    apiKey: "provider-secret",
    validateOutput: (output) => validateIssueResult(output, config),
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });

  assert.deepEqual(result.output, validIssue());
  assert.equal(result.metadata.provider, "deepseek");
  assert.equal(result.metadata.model, "deepseek-v4-flash");
  assert.equal(result.metadata.attempt, 2);
  assert.deepEqual(result.metadata.usage, {
    requests: 2,
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 3
  });
  assert.equal(calls.provider.apiKey, "provider-secret");
  assert.equal(calls.provider.baseURL, "https://api.deepseek.com");
  assert.equal(calls.provider.useResponses, false);
  assert.equal(calls.agent.name, "Issue triager");
  assert.match(calls.agent.instructions, /# Issue triager profile/);
  assert.match(calls.agent.instructions, /no independent shell, filesystem, GitHub, credential, or arbitrary network tools/);
  assert.equal("outputType" in calls.agent, false);
  assert.equal(calls.runOptions.maxTurns, 1);
  assert.match(calls.input, /Repair the previous Codekeeper response attempt 1/i);
  assert.equal(calls.closed, true);
});

test("disabled orchestration leaves workspace specialists intact and keeps the manager on the no-tool path", async () => {
  const disabled = withoutTracing();
  assert.equal(disabled.ai.orchestration.enabled, false);
  assert.deepEqual(disabled.ai.orchestration.modes, {
    review: false,
    issues: false,
    fix: false,
    maintain: false,
  });
  assert.equal(disabled.ai.agents.issue.workspace.enabled, true);
  assert.equal(disabled.ai.agents.review.workspace.enabled, true);
  const calls = { runs: 0, specialists: 0 };
  class FakeProvider {
    async close() {}
  }
  class FakeAgent {
    constructor(options) {
      calls.agent = options;
      calls.specialists += (options.tools?.length ?? 0) + (options.handoffs?.length ?? 0);
    }
  }
  class FakeRunner {
    constructor(options) {
      calls.runner = options;
    }
    async run(agent, input, options) {
      calls.runs += 1;
      calls.invocation = { agent, input, options };
      return { finalOutput: JSON.stringify(validIssue()) };
    }
  }

  const result = await runConfiguredAgent({
    mode: "issue",
    config: disabled,
    prompt: "Classify this issue.",
    schema,
    apiKey: "provider-secret",
    validateOutput: (output) => validateIssueResult(output, disabled),
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider }),
  });

  assert.equal(calls.runs, 1);
  assert.equal(calls.specialists, 0);
  assert.equal(Object.hasOwn(calls.agent, "tools"), false);
  assert.equal(Object.hasOwn(calls.agent, "handoffs"), false);
  assert.equal(calls.invocation.options.maxTurns, 1);
  assert.equal(result.metadata.maxTurns, 1);
  assert.equal(result.metadata.workspaceSpecialistUsed, false);
});

test("security-facing review coordination uses Luna Max from frozen context", async () => {
  const specialistResult = {
    mode: "review",
    summary: "Security review complete.",
    risk: "high",
    labels: ["codekeeper:type-security"],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [],
    tests: { adequate: true, notes: "Covered.", missingTest: null },
    diagram: null,
    mergeRecommendation: "manual",
    noActionReason: "No defect found."
  };
  const calls = {};
  class FakeProvider { async close() {} }
  class FakeAgent { constructor(options) { calls.agent = options; } }
  class FakeRunner { async run() { return { finalOutput: specialistResult }; } }
  const result = await runConfiguredAgent({
    mode: "review",
    config: withoutTracing(),
    context: {
      mode: "review",
      pullRequest: {
        labels: ["security"],
        changedFiles: ["src/feature.mjs"],
        changeSummary: { changedLines: 20, largestFileChangedLines: 20 }
      }
    },
    prompt: "Review this pull request.",
    schema: { type: "object" },
    specialistResult,
    apiKey: "provider-secret",
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });
  assert.equal(calls.agent.model, "gpt-5.6-luna");
  assert.equal(calls.agent.modelSettings.reasoning.effort, "max");
  assert.equal(result.metadata.model, "gpt-5.6-luna");
  assert.deepEqual(result.metadata.reasoningEscalation, {
    escalated: true,
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "max",
    reason: "label:security"
  });
});

test("contract retries repair only the previous output without replaying the task prompt", async () => {
  const retryConfig = withoutTracing();
  retryConfig.ai.agents.issue.maximumAttempts = 3;
  const inputs = [];
  class FakeProvider { async close() {} }
  class FakeAgent {}
  class FakeRunner {
    async run(_agent, input) {
      inputs.push(input);
      return { finalOutput: inputs.length < 3 ? "invalid" : JSON.stringify(validIssue()) };
    }
  }
  await runConfiguredAgent({
    mode: "issue",
    config: retryConfig,
    prompt: "UNIQUE_TRUSTED_PROMPT",
    schema,
    apiKey: "provider-secret",
    validateOutput: (output) => validateIssueResult(output, config),
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });
  assert.equal(inputs.length, 3);
  assert.doesNotMatch(inputs[2], /UNIQUE_TRUSTED_PROMPT/);
  assert.match(inputs[2], /previous Codekeeper response attempt 2/i);
  assert.doesNotMatch(inputs[2], /attempt 1/i);
});

test("OpenRouter uses Chat Completions and locally validates unstructured output", async () => {
  const openRouterConfig = withoutTracing();
  openRouterConfig.ai.agents.issue.provider = "openrouter";
  openRouterConfig.ai.agents.issue.model = "anthropic/claude-sonnet-4.5";
  openRouterConfig.ai.agents.issue.modelSettings = {};
  const calls = { attempts: 0 };
  class FakeProvider {
    constructor(options) { calls.provider = options; }
    async close() {}
  }
  class FakeAgent {
    constructor(options) { calls.agent = options; }
  }
  class FakeRunner {
    async run() {
      calls.attempts += 1;
      return { finalOutput: calls.attempts === 1 ? "not json" : JSON.stringify(validIssue()) };
    }
  }

  const result = await runConfiguredAgent({
    mode: "issue",
    config: openRouterConfig,
    prompt: "Classify this issue.",
    schema,
    apiKey: "openrouter-secret",
    validateOutput: (output) => validateIssueResult(output, config),
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });

  assert.equal(calls.provider.baseURL, "https://openrouter.ai/api/v1");
  assert.equal(calls.provider.useResponses, false);
  assert.equal("outputType" in calls.agent, false);
  assert.equal(result.metadata.structuredOutputs, false);
  assert.equal(result.metadata.attempt, 2);
  assert.deepEqual(result.output, validIssue());
});

test("evidence-boundary retries include the authoritative specialist result", async () => {
  const retryConfig = withoutTracing();
  retryConfig.ai.agents.review.maximumAttempts = 2;
  const blocker = { title: "UNIQUE_SPECIALIST_BLOCKER" };
  const specialistResult = { blockingFindings: [blocker], nonBlockingFindings: [] };
  const inputs = [];
  class FakeProvider { async close() {} }
  class FakeAgent {}
  class FakeRunner {
    async run(_agent, input) {
      inputs.push(input);
      return {
        finalOutput: inputs.length === 1
          ? { blockingFindings: [], nonBlockingFindings: [] }
          : specialistResult
      };
    }
  }
  await runConfiguredAgent({
    mode: "review",
    config: retryConfig,
    prompt: "UNIQUE_REVIEW_TASK",
    schema,
    specialistResult,
    apiKey: "provider-secret",
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });
  assert.equal(inputs.length, 2);
  const retryInput = JSON.stringify(inputs[1]);
  assert.doesNotMatch(retryInput, /UNIQUE_REVIEW_TASK/);
  assert.match(retryInput, /UNIQUE_SPECIALIST_BLOCKER/);
});

test("Responses retries preserve the explicit cache breakpoint without replaying evidence", async () => {
  const retryConfig = withoutTracing();
  retryConfig.ai.agents.issue = {
    ...retryConfig.ai.agents.issue,
    provider: "openai",
    model: "gpt-5.6-terra",
    effort: "medium",
    modelSettings: { text: { verbosity: "low" } }
  };
  const inputs = [];
  const agents = [];
  class FakeProvider { async close() {} }
  class FakeAgent { constructor(options) { agents.push(options); } }
  class FakeRunner {
    async run(_agent, input) {
      inputs.push(input);
      return {
        finalOutput: inputs.length === 1
          ? validIssue({ implementationRecommendation: "unsupported" })
          : validIssue()
      };
    }
  }
  await runConfiguredAgent({
    mode: "issue",
    config: retryConfig,
    prompt: "UNIQUE_RESPONSES_PROMPT",
    schema,
    apiKey: "provider-secret",
    validateOutput: (output) => validateIssueResult(output, config),
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });
  assert.equal(inputs.length, 2);
  assert.match(agents[0].instructions, /first input text block contains trusted Codekeeper instructions/);
  assert.doesNotMatch(agents[0].instructions, /# Issue triager profile/);
  assert.equal(inputs[1][0].role, "user");
  assert.deepEqual(inputs[1][0].content[0].promptCacheBreakpoint, { mode: "explicit" });
  assert.match(inputs[1][0].content[0].text, /# Issue triager profile/);
  assert.doesNotMatch(inputs[1][0].content[1].text, /UNIQUE_RESPONSES_PROMPT/);
  assert.match(inputs[1][0].content[1].text, /previous Codekeeper response attempt 1/i);
  assert.match(inputs[1][0].content[1].text, /"implementationRecommendation":"unsupported"/);
  assert.doesNotMatch(inputs[1][0].content[1].text, /\[object Object\]/);
});

test("structured coordinators omit textual schemas and mark a stable cache breakpoint", () => {
  const input = buildCoordinatorInput({
    mode: "review",
    prompt: "Decide from evidence.",
    schema,
    specialistResult: { blockingFindings: [], nonBlockingFindings: [] },
    structuredOutputs: true,
    cache: true,
    instructions: "Stable review instructions."
  });
  assert.equal(input.length, 1);
  assert.equal(input[0].role, "user");
  assert.deepEqual(input[0].content[0].promptCacheBreakpoint, { mode: "explicit" });
  assert.match(input[0].content[0].text, /Stable review instructions/);
  assert.doesNotMatch(input[0].content[1].text, /FINAL OUTPUT CONTRACT/);
  assert.doesNotMatch(input[0].content[1].text, /additionalProperties/);
  assert.doesNotMatch(input[0].content[1].text, /\n  "/);
  assert.throws(
    () => buildCoordinatorInput({ mode: "review", prompt: "Task", schema, cache: true }),
    /requires stable developer instructions/
  );
});

test("coordinator evidence boundary rejects invented review findings and fix tests", () => {
  const finding = { title: "Observed failure" };
  assert.doesNotThrow(
    () => enforceCoordinatorEvidenceBoundary(
      "review",
      { blockingFindings: [{ explanation: "Exact evidence", title: "Observed failure" }], nonBlockingFindings: [] },
      { blockingFindings: [{ title: "Observed failure", explanation: "Exact evidence" }], nonBlockingFindings: [] }
    )
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("review", { blockingFindings: [{ title: "Invented" }], nonBlockingFindings: [] }, { blockingFindings: [finding], nonBlockingFindings: [] }),
    /not present in workspace evidence/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("fix", { readyForReview: true, testsRun: [{ command: "npm test", result: "passed" }], changedSummary: "changed" }, { readyForReview: false, testsRun: [], changedSummary: "" }),
    /cannot mark a fix ready/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "issue",
      { duplicateOf: 9, actionable: true, implementationRecommendation: "ai-ready", labels: ["codekeeper:ready"] },
      { duplicateOf: null, actionable: false, implementationRecommendation: "no", labels: [] }
    ),
    /duplicate not present in workspace evidence/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("review", { blockingFindings: [], nonBlockingFindings: [], mergeRecommendation: "auto", tests: { adequate: true } }, null),
    /without workspace evidence/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("audit", { findings: [{ title: "Invented" }], repair: { requested: false } }, null),
    /without workspace evidence/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("fix", { readyForReview: false, testsRun: [], changedSummary: "Invented" }, null),
    /without workspace evidence/
  );
});

test("coordinator evidence cannot become more permissive than specialist authority", () => {
  const blocker = { title: "Current authorization failure" };
  const reviewEvidence = (labels) => ({
    risk: "low",
    labels,
    blockingFindings: [],
    nonBlockingFindings: [],
    tests: { adequate: false },
    mergeRecommendation: "manual"
  });
  const issueEvidence = (priority, type = "bug") => ({
    type,
    priority,
    duplicateOf: null,
    actionable: false,
    implementationRecommendation: "manual",
    labels: []
  });
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "review",
      {
        risk: "low",
        blockingFindings: [],
        nonBlockingFindings: [],
        tests: { adequate: true },
        mergeRecommendation: "auto"
      },
      {
        risk: "high",
        blockingFindings: [blocker],
        nonBlockingFindings: [],
        tests: { adequate: false },
        mergeRecommendation: "block"
      }
    ),
    /specialist blocker/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "review",
      {
        risk: "low",
        blockingFindings: [],
        nonBlockingFindings: [],
        tests: { adequate: true },
        mergeRecommendation: "auto"
      },
      {
        risk: "medium",
        blockingFindings: [],
        nonBlockingFindings: [],
        tests: { adequate: false },
        mergeRecommendation: "manual"
      }
    ),
    /more permissive/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "review",
      reviewEvidence(["codekeeper:type-security"]),
      reviewEvidence([])
    ),
    /review label/
  );
  assert.doesNotThrow(
    () => enforceCoordinatorEvidenceBoundary(
      "review",
      reviewEvidence(["codekeeper:type-security"]),
      reviewEvidence(["codekeeper:type-security", "codekeeper:type-bug"])
    )
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "issue",
      {
        duplicateOf: 9,
        duplicateConfidence: "high",
        actionable: false,
        implementationRecommendation: "manual",
        labels: []
      },
      {
        duplicateOf: 9,
        duplicateConfidence: "medium",
        actionable: false,
        implementationRecommendation: "manual",
        labels: []
      }
    ),
    /duplicate confidence/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "issue",
      issueEvidence("p1"),
      issueEvidence("p3")
    ),
    /issue priority/
  );
  assert.doesNotThrow(
    () => enforceCoordinatorEvidenceBoundary("issue", issueEvidence("p3"), issueEvidence("p2"))
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("issue", issueEvidence("p3", "security"), issueEvidence("p3", "bug")),
    /issue type/
  );
  const auditFindingA = { title: "Finding A" };
  const auditFindingB = { title: "Finding B" };
  const specialistRepair = {
    requested: true,
    findingIndex: 1,
    title: "Fix B",
    body: "Repairs B.",
    risk: "high",
    validationSummary: "Validated B."
  };
  const specialistAudit = { findings: [auditFindingA, auditFindingB], repair: specialistRepair };
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "audit",
      { ...specialistAudit, repair: { ...specialistRepair, requested: false } },
      specialistAudit
    ),
    /cannot clear a specialist audit repair request/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "audit",
      {
        findings: [auditFindingB, auditFindingA],
        repair: {
          ...specialistRepair,
          findingIndex: 1,
          title: "Fix A",
          body: "Repairs A.",
          risk: "low",
          validationSummary: "Validated A."
        }
      },
      specialistAudit
    ),
    /audit repair/
  );
  assert.doesNotThrow(
    () => enforceCoordinatorEvidenceBoundary(
      "audit",
      {
        findings: [auditFindingB, auditFindingA],
        repair: { ...specialistRepair, findingIndex: 0 }
      },
      specialistAudit
    )
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "audit",
      {
        findings: [auditFindingB, auditFindingA],
        repair: { ...specialistRepair, findingIndex: 0, risk: "low" }
      },
      specialistAudit
    ),
    /audit repair risk/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "fix",
      { risk: "low", readyForReview: true, testsRun: [], changedSummary: "Applied the patch." },
      { risk: "high", readyForReview: true, testsRun: [], changedSummary: "Applied the patch." }
    ),
    /fix risk/
  );
  assert.doesNotThrow(
    () => enforceCoordinatorEvidenceBoundary(
      "fix",
      { risk: "high", readyForReview: false, testsRun: [], changedSummary: "Applied the patch." },
      { risk: "medium", readyForReview: false, testsRun: [], changedSummary: "Applied the patch." }
    )
  );
});

test("coordinator review feedback dispositions preserve repair authority while allowing safe conservative changes", () => {
  const dispositions = ["fix_now", "fix_if_cheap", "defer", "ignore"];
  const permitted = new Map([
    ["fix_now", new Set(["fix_now"])],
    ["fix_if_cheap", new Set(["fix_if_cheap"])],
    ["defer", new Set(["defer", "ignore"])],
    ["ignore", new Set(["ignore"])]
  ]);
  const feedback = {
    problemKey: "current-review-defect",
    disposition: "fix_now",
    type: "bug",
    explanation: "The current head still contains the defect.",
    validation: "A focused regression reproduces the failure.",
    sourceKeys: ["review_comment:42"],
    threadIds: ["PRRT_42"]
  };
  const review = (disposition) => ({
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [{ ...feedback, disposition }]
  });

  for (const specialistDisposition of dispositions) {
    for (const outputDisposition of dispositions) {
      if (permitted.get(specialistDisposition).has(outputDisposition)) {
        assert.doesNotThrow(
          () => enforceCoordinatorEvidenceBoundary("review", review(outputDisposition), review(specialistDisposition)),
          `${specialistDisposition} should allow ${outputDisposition}`
        );
      } else {
        assert.throws(
          () => enforceCoordinatorEvidenceBoundary("review", review(outputDisposition), review(specialistDisposition)),
          /auto-merge veto|repair request|upgraded review feedback disposition/,
          `${specialistDisposition} should reject ${outputDisposition}`
        );
      }
    }
  }

  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "review",
      review("defer"),
      { ...review("fix_now"), reviewFeedback: [{ ...feedback, disposition: "fix_now", validation: "Different evidence." }] }
    ),
    /not present in workspace evidence/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("review", { ...review("fix_now"), reviewFeedback: [] }, review("fix_now")),
    /omitted review feedback/
  );
});

test("coordinator cannot transform specialist fix-now feedback into auto-merge eligibility", () => {
  const feedback = {
    problemKey: "verified-must-fix",
    type: "bug",
    explanation: "The current head still contains the defect.",
    validation: "A focused regression reproduces the failure.",
    sourceKeys: ["review_comment:42"],
    threadIds: ["PRRT_42"]
  };
  const review = (disposition) => ({
    risk: "low",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [{ ...feedback, disposition }],
    tests: { adequate: true },
    mergeRecommendation: "auto"
  });
  const pullRequest = {
    state: "open",
    draft: false,
    labels: [],
    user: { login: "codekeeper[bot]", type: "Bot" },
    head: { ref: `${config.repository.automationBranchPrefix}repair`, repo: { full_name: "owner/repository" } },
    base: { ref: config.repository.defaultBranch, repo: { full_name: "owner/repository" } }
  };
  const autoMergeDecision = (reviewResult) => evaluateAutoMerge({
    config: { ...config, merge: { ...config.merge, enabled: true } },
    pullRequest,
    files: [{ filename: "README.md", additions: 1, deletions: 0 }],
    reviewResult,
    reviewContextComplete: true,
    automationBotLogin: "codekeeper[bot]"
  });

  assert.equal(autoMergeDecision(review("fix_now")).eligible, false);
  assert.equal(autoMergeDecision(review("ignore")).eligible, true);

  assert.throws(
    () => autoMergeDecision(
      enforceCoordinatorEvidenceBoundary("review", review("ignore"), review("fix_now"))
    ),
    /cannot clear a specialist fix-now auto-merge veto/
  );
});

test("coordinator binds every rendered claim to specialist evidence", () => {
  const reviewFinding = { title: "A non-blocking finding" };
  const review = {
    summary: "Specialist review summary.",
    risk: "medium",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [reviewFinding],
    tests: { adequate: false, notes: "Specialist test note.", missingTest: null },
    diagram: "flowchart TD\nA-->B",
    mergeRecommendation: "manual",
    noActionReason: "A maintainer must decide."
  };
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("review", { ...review, summary: "Invented review summary." }, review),
    /review summary/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "review",
      { ...review, blockingFindings: [reviewFinding], nonBlockingFindings: [] },
      review
    ),
    /blocking finding/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("review", { ...review, tests: { adequate: false, notes: "Invented test note.", missingTest: null } }, review),
    /test notes/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("review", { ...review, diagram: "flowchart TD\nA-->C" }, review),
    /review diagram/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("review", { ...review, noActionReason: "Invented reason." }, review),
    /no-action reason/
  );

  const issue = {
    summary: "Specialist issue summary.",
    type: "bug",
    priority: "p3",
    labels: [],
    actionable: false,
    missingInformation: ["Affected version."],
    duplicateOf: null,
    duplicateConfidence: "none",
    implementationRecommendation: "no",
    decision: { required: false, question: "", rationale: "", options: [] },
    comment: "Specialist issue comment."
  };
  const requiredDecision = {
    required: true,
    question: "Which behavior should apply?",
    rationale: "The outcome changes compatibility.",
    options: [{ label: "Keep behavior", description: "Preserve current behavior.", recommended: true }]
  };
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("issue", { ...issue, comment: "Invented issue comment." }, issue),
    /issue comment/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("issue", { ...issue, missingInformation: ["Invented missing fact."] }, issue),
    /missing issue information/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("issue", { ...issue, implementationRecommendation: "manual" }, issue),
    /implementation recommendation/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("issue", { ...issue, decision: requiredDecision }, issue),
    /maintainer decision/
  );
  const issueWithDecision = { ...issue, decision: requiredDecision };
  assert.doesNotThrow(
    () => enforceCoordinatorEvidenceBoundary("issue", issueWithDecision, issueWithDecision)
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "issue",
      { ...issueWithDecision, decision: { ...requiredDecision, rationale: "Invented rationale." } },
      issueWithDecision
    ),
    /maintainer decision/
  );
  const readyIssueWithDecision = {
    ...issueWithDecision,
    actionable: true,
    missingInformation: [],
    implementationRecommendation: "ai-ready"
  };
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "issue",
      { ...readyIssueWithDecision, decision: { required: false, question: "", rationale: "", options: [] } },
      readyIssueWithDecision
    ),
    /maintainer decision/
  );

  const audit = {
    summary: "Specialist audit summary.",
    findings: [],
    repair: { requested: false, findingIndex: null, title: "", body: "", risk: "high", validationSummary: "" },
    noActionReason: "No supported maintenance work."
  };
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("audit", { ...audit, summary: "Invented audit summary." }, audit),
    /audit summary/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary(
      "audit",
      { ...audit, repair: { ...audit.repair, title: "Invented repair." } },
      audit
    ),
    /repair title/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("audit", { ...audit, noActionReason: "Invented audit reason." }, audit),
    /audit no-action reason/
  );

  const fix = {
    summary: "Specialist fix summary.",
    risk: "medium",
    readyForReview: false,
    testsRun: [],
    changedSummary: "",
    noChangeReason: "No policy-compliant patch exists."
  };
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("fix", { ...fix, summary: "Invented fix summary." }, fix),
    /fix summary/
  );
  assert.throws(
    () => enforceCoordinatorEvidenceBoundary("fix", { ...fix, noChangeReason: "Invented fix reason." }, fix),
    /fix no-change reason/
  );
});
