import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_PROFILE_BUNDLE_FILE,
  agentProfilePathForMode
} from "../src/lib/agent-profiles.mjs";
import { runAgentFromBundle } from "../src/lib/agents-runtime.mjs";
import { sha256 } from "../src/lib/markers.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
);

function withoutTracing() {
  const value = structuredClone(config);
  value.ai.tracing.enabled = false;
  return value;
}

function validIssue() {
  return {
    mode: "issue",
    summary: "A zero-percent discount should return the original price.",
    type: "bug",
    priority: "p3",
    labels: [],
    actionable: true,
    missingInformation: [],
    duplicateOf: null,
    duplicateConfidence: "none",
    implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] },
    comment: "The report is clear, bounded, and testable."
  };
}

test("skipped issue workspace restores direct triage from the frozen issue record", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-direct-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const profile = "# Trusted issue behavior\n";
  const profileMetadata = {
    path: agentProfilePathForMode("issue"),
    sha256: sha256(Buffer.from(profile)),
    sourceSha: "a".repeat(40)
  };
  const context = {
    mode: "issue",
    repository: "coryparrry/codekeeper-test-environment",
    runUrl: "https://github.com/coryparrry/codekeeper-test-environment/actions/runs/1",
    toolingSha: "b".repeat(40),
    configSha256: "c".repeat(64),
    baseSha: "d".repeat(40),
    triageMode: "automatic",
    issue: {
      number: 59,
      title: "Zero-percent discounts should leave the original price unchanged",
      body: "The fixture discount helper should treat 0 as a no-op so a valid price is returned unchanged.",
      author: "coryparrry",
      updatedAt: "2026-08-22T19:00:00Z",
      previousTriage: null
    },
    duplicateCandidates: [],
    openPullRequests: [],
    resolvedByPullRequest: null,
    agentProfile: profileMetadata
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { const: "issue" },
      summary: { type: "string" }
    },
    required: ["mode", "summary"]
  };
  await Promise.all([
    writeFile(
      path.join(directory, "prompt.md"),
      "Decide whether the workspace triage evidence supports the issue classification.\n"
    ),
    writeFile(path.join(directory, "schema.json"), JSON.stringify(schema)),
    writeFile(path.join(directory, "context.json"), JSON.stringify(context)),
    writeFile(path.join(directory, AGENT_PROFILE_BUNDLE_FILE), profile),
    writeFile(path.join(directory, "workspace-result.json"), "{\"skipped\":true}\n")
  ]);

  let capturedInput = "";
  let providers = 0;
  class FakeProvider {
    constructor() { providers += 1; }
    async close() {}
  }
  class FakeAgent {}
  class FakeRunner {
    async run(_agent, input) {
      capturedInput = JSON.stringify(input);
      return { finalOutput: validIssue() };
    }
  }

  const result = await runAgentFromBundle({
    mode: "issue",
    directory,
    config: withoutTracing(),
    resultPath: path.join(directory, "result.json"),
    apiKey: "provider-secret",
    configureTracing: async () => {},
    sdkLoader: async () => ({
      Agent: FakeAgent,
      Runner: FakeRunner,
      OpenAIProvider: FakeProvider
    })
  });

  assert.equal(providers, 1);
  assert.equal(result.workspaceSpecialistUsed, false);
  assert.match(capturedInput, /ISSUE-ONLY EXECUTION MODE/);
  assert.match(capturedInput, /complete bounded triage evidence/);
  assert.match(capturedInput, /Classify issue #59/);
  assert.match(capturedInput, /Zero-percent discounts should leave the original price unchanged/);
  assert.match(capturedInput, /treat 0 as a no-op/);
  assert.doesNotMatch(
    capturedInput,
    /Decide whether the workspace triage evidence supports the issue classification/
  );
  assert.equal(
    JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")).summary,
    validIssue().summary
  );
});
