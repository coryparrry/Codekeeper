import assert from "node:assert/strict";
import test from "node:test";
import { getAgentRuntimeSettings } from "../src/lib/config.mjs";
import { applyPolicyPreset, POLICY_PRESETS } from "../presets/catalogue.mjs";
import { DEFAULT_REPEAT, SCENARIOS, makeOfflineSdk, parseEvaluationArgs, providerKeyEnvironment, readStarterPolicy, resolveEvaluationPolicy, runDecisionEvaluation } from "../evals/decision-quality.mjs";

const starter = await readStarterPolicy();

test("mixed preset is a cloned view of the tracked starter and OpenAI preset only changes issue triage", () => {
  const mixed = resolveEvaluationPolicy(starter, { preset: "mixed" });
  assert.deepEqual(mixed, starter);
  assert.notEqual(mixed, starter);
  mixed.ai.agents.issue.model = "mutated-in-test";
  assert.equal(starter.ai.agents.issue.model, "deepseek-v4-flash");
  assert.equal(POLICY_PRESETS.mixed.version, 1);
  assert.equal(POLICY_PRESETS.openai.version, 1);

  const openai = applyPolicyPreset(starter, "openai");
  assert.deepEqual(openai.ai.providers, starter.ai.providers);
  assert.deepEqual(openai.ai.agents.review, starter.ai.agents.review);
  assert.deepEqual(openai.ai.agents.audit, starter.ai.agents.audit);
  assert.deepEqual(openai.ai.agents.fix, starter.ai.agents.fix);
  assert.equal(openai.ai.agents.issue.provider, "openai");
  assert.equal(openai.ai.agents.issue.model, "gpt-5.6-terra");
  assert.equal(openai.ai.agents.issue.effort, "medium");
  assert.equal(openai.ai.agents.issue.modelSettings.text.verbosity, "low");
  assert.equal(openai.ai.providers.openai.structuredOutputs, true);
  assert.equal(openai.audit.repair.enabled, false);
  assert.equal(openai.issues.allowAiImplementation, false);
  assert.equal(openai.merge.enabled, false);
  const issueRuntime = getAgentRuntimeSettings(openai, "issue");
  assert.equal(issueRuntime.workspaceEnabled, true);
  assert.equal(issueRuntime.workspaceSandbox, "read-only");
});

test("decision evaluation parses repeat defaults and only permits OpenAI fallback candidates for the OpenAI preset", () => {
  assert.deepEqual(parseEvaluationArgs([]), { preset: "mixed", repeat: DEFAULT_REPEAT, offline: false, openaiIssueCandidate: undefined, scenario: undefined });
  assert.deepEqual(
    parseEvaluationArgs(["--offline", "--preset=openai", "--repeat", "2", "--openai-issue=sol-high", "--scenario", "introduced-major-pr-failure"]),
    { preset: "openai", repeat: 2, offline: true, openaiIssueCandidate: "sol-high", scenario: "introduced-major-pr-failure" }
  );
  assert.throws(() => parseEvaluationArgs(["--repeat", "0"]), /1 through 10/);
  assert.throws(() => parseEvaluationArgs(["--openai-issue", "terra-high"]), /only with --preset openai/);
  assert.throws(() => parseEvaluationArgs(["--scenario", "unknown"]), /Unknown evaluation scenario/);
  assert.throws(() => resolveEvaluationPolicy(starter, { preset: "openai", openaiIssueCandidate: "unknown" }), /Unknown OpenAI issue candidate/);

  const high = resolveEvaluationPolicy(starter, { preset: "openai", openaiIssueCandidate: "terra-high" });
  const sol = resolveEvaluationPolicy(starter, { preset: "openai", openaiIssueCandidate: "sol-high" });
  assert.equal(high.ai.agents.issue.model, "gpt-5.6-terra");
  assert.equal(high.ai.agents.issue.effort, "high");
  assert.equal(sol.ai.agents.issue.model, "gpt-5.6-sol");
  assert.equal(sol.ai.agents.issue.effort, "high");
  assert.equal(providerKeyEnvironment("openai"), "OPENAI_API_KEY");
  assert.equal(providerKeyEnvironment("deepseek"), "DEEPSEEK_API_KEY");
  assert.throws(() => providerKeyEnvironment("other"), /No API key environment/);
});

test("offline decision matrix uses the coordinator provider path and reports deterministic semantic passes", async () => {
  const calls = { providers: [], agents: [], runs: [] };
  const reports = [];
  const summary = await runDecisionEvaluation({
    preset: "openai",
    repeat: 2,
    keyResolver: () => "offline-provider-key",
    disableTracing: true,
    sdkLoader: async () => makeOfflineSdk(undefined, {
      onProvider: (options) => calls.providers.push(options),
      onAgent: (options) => calls.agents.push(options),
      onRun: (scenario) => calls.runs.push(scenario)
    }),
    report: (line) => reports.push(line)
  });
  assert.equal(summary.failed, 0);
  assert.equal(summary.passed, SCENARIOS.length * 2);
  assert.equal(calls.providers.length, SCENARIOS.length * 2);
  assert.equal(calls.runs.length, SCENARIOS.length * 2);
  const issueAgent = calls.agents.find((agent) => agent.name === "Issue triager");
  assert.equal(issueAgent.model, "gpt-5.6-terra");
  assert.equal(issueAgent.modelSettings.reasoning.effort, "medium");
  assert.equal(issueAgent.outputType.type, "json_schema");
  assert.equal(issueAgent.outputType.strict, true);
  assert.match(reports[0], /^PASS scenario=prompt-injection preset=openai model=gpt-5\.6-terra attempt=1 stage=semantic-assertion repeat=1$/);
  assert.ok(reports.every((line) => /scenario=.+ preset=openai model=.+ attempt=\d+ stage=.+ repeat=\d+/.test(line)));
});

test("mixed evaluation resolves provider-specific credentials before constructing any provider", async () => {
  const calls = { providers: [] };
  const reports = [];
  const summary = await runDecisionEvaluation({
    preset: "mixed",
    repeat: 1,
    disableTracing: true,
    keyResolver: (provider) => ({ openai: "openai-key-secret", deepseek: "deepseek-key-secret" })[provider],
    sdkLoader: async () => makeOfflineSdk(undefined, { onProvider: (options) => calls.providers.push(options) }),
    report: (line) => reports.push(line)
  });
  assert.equal(summary.failed, 0);
  assert.ok(calls.providers.some((options) => options.apiKey === "openai-key-secret"));
  assert.ok(calls.providers.some((options) => options.apiKey === "deepseek-key-secret"));
  assert.doesNotMatch(reports.join("\n"), /openai-key-secret|deepseek-key-secret/);
});

test("missing or resolver-failed credentials stop the matrix before any provider call and stay redacted", async () => {
  const calls = { providers: 0 };
  await assert.rejects(
    runDecisionEvaluation({
      preset: "mixed",
      disableTracing: true,
      keyResolver: (provider) => provider === "openai" ? "openai-key-secret" : "",
      sdkLoader: async () => makeOfflineSdk(undefined, { onProvider: () => { calls.providers += 1; } })
    }),
    /DEEPSEEK_API_KEY is required/
  );
  assert.equal(calls.providers, 0);

  await assert.rejects(
    runDecisionEvaluation({
      preset: "openai",
      disableTracing: true,
      keyResolver: () => { throw new Error("resolver-key-secret"); },
      sdkLoader: async () => makeOfflineSdk()
    }),
    (error) => {
      assert.match(error.message, /Could not resolve the OPENAI_API_KEY credential/);
      assert.doesNotMatch(error.message, /resolver-key-secret/);
      return true;
    }
  );
});

test("priority and severity calibration assertions reject schema-valid but incorrect decisions", async () => {
  const fixtures = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.name, scenario.fixture]));
  fixtures["unsupported-reporter-urgency"] = {
    ...fixtures["unsupported-reporter-urgency"],
    priority: "p1"
  };
  fixtures["material-nonurgent-impact"] = {
    ...fixtures["material-nonurgent-impact"],
    priority: "p3"
  };
  fixtures["introduced-major-pr-failure"] = {
    ...fixtures["introduced-major-pr-failure"],
    blockingFindings: [{ ...fixtures["introduced-major-pr-failure"].blockingFindings[0], severity: "critical" }]
  };
  fixtures["insufficient-tests"] = {
    ...fixtures["insufficient-tests"],
    nonBlockingFindings: [{ ...fixtures["insufficient-tests"].nonBlockingFindings[0], severity: "low" }]
  };
  fixtures["introduced-low-severity-contract-failure"] = {
    ...fixtures["introduced-low-severity-contract-failure"],
    blockingFindings: [],
    nonBlockingFindings: fixtures["introduced-low-severity-contract-failure"].blockingFindings,
    mergeRecommendation: "manual"
  };
  const summary = await runDecisionEvaluation({
    repeat: 1,
    keyResolver: () => "offline-provider-key",
    disableTracing: true,
    sdkLoader: async () => makeOfflineSdk(fixtures),
    throwOnFailure: false
  });
  assert.equal(summary.failed, 5);
  assert.deepEqual(
    summary.results.filter((result) => !result.pass).map((result) => result.scenario).sort(),
    ["insufficient-tests", "introduced-low-severity-contract-failure", "introduced-major-pr-failure", "material-nonurgent-impact", "unsupported-reporter-urgency"]
  );
});

test("related reports reject a schema-valid duplicate classification", async () => {
  const fixtures = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.name, scenario.fixture]));
  fixtures["related-not-duplicate"] = {
    ...fixtures["related-not-duplicate"],
    duplicateOf: 9,
    duplicateConfidence: "high"
  };
  const summary = await runDecisionEvaluation({
    scenario: "related-not-duplicate",
    repeat: 1,
    keyResolver: () => "offline-provider-key",
    disableTracing: true,
    sdkLoader: async () => makeOfflineSdk(fixtures),
    throwOnFailure: false
  });
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.results, [{
    scenario: "related-not-duplicate",
    preset: "mixed",
    model: "deepseek-v4-flash",
    attempt: 2,
    stage: "evidence-boundary",
    pass: false,
    repeat: 1
  }]);
});

test("semantic assertions fail closed and evaluation never reports provider keys or result text", async () => {
  const fixtures = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.name, scenario.fixture]));
  fixtures["prompt-injection"] = {
    ...fixtures["prompt-injection"],
    summary: "provider-result-secret",
    actionable: true,
    missingInformation: [],
    implementationRecommendation: "manual"
  };
  const reports = [];
  const summary = await runDecisionEvaluation({
    repeat: 1,
    keyResolver: () => "provider-key-secret",
    disableTracing: true,
    sdkLoader: async () => makeOfflineSdk(fixtures),
    report: (line) => reports.push(line),
    throwOnFailure: false
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.results[0].scenario, "prompt-injection");
  assert.equal(summary.results[0].attempt, 2);
  assert.equal(summary.results[0].stage, "evidence-boundary");
  assert.equal(summary.results[0].pass, false);
  assert.doesNotMatch(reports.join("\n"), /provider-key-secret|provider-result-secret/);
  assert.deepEqual(Object.keys(summary.results[0]).sort(), ["attempt", "model", "pass", "preset", "repeat", "scenario", "stage"]);
});
