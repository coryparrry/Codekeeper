import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentRuntimeSettings, loadConfig, reviewReasoningEscalation, validatePolicy } from "../src/lib/config.mjs";

const source = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
);

async function writeConfig(value) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-config-test-"));
  const file = path.join(directory, "policy.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

test("policy validation is a shared boundary independent of file loading", () => {
  const config = structuredClone(source);
  config.repository.ownerLogins = ["Repository-Owner"];
  assert.equal(validatePolicy(config), config);
  assert.deepEqual(config.repository.ownerLogins, ["repository-owner"]);

  const invalid = structuredClone(source);
  invalid.review.unexpected = true;
  assert.throws(() => validatePolicy(invalid), /review contains an unknown key unexpected/);
});

test("configuration validator rejects unsafe or incomplete policy values", async () => {
  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      audit: {
        ...source.audit,
        repair: { ...source.audit.repair, maximumPatchBytes: 0 }
      }
    })),
    /audit\.repair\.maximumPatchBytes must be a positive integer/
  );

  const unknownEscalationLabel = structuredClone(source);
  unknownEscalationLabel.review.reasoningEscalation.labels.push("undefined-label");
  await assert.rejects(
    loadConfig(await writeConfig(unknownEscalationLabel)),
    /review\.reasoningEscalation references undefined label undefined-label/
  );

  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      review: { ...source.review, allowedLabels: [...source.review.allowedLabels, "undefined-label"] }
    })),
    /review references undefined label undefined-label/
  );

  const missingRuntimeLabel = structuredClone(source);
  delete missingRuntimeLabel.labels["ready"];
  await assert.rejects(
    loadConfig(await writeConfig(missingRuntimeLabel)),
    /runtime requires undefined label ready/
  );

  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      issues: { ...source.issues, managedLabels: ["undefined-label"] }
    })),
    /issues references undefined label undefined-label/
  );

  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      repository: { ...source.repository, automationBranchPrefix: "automation/codekeeper" }
    })),
    /automationBranchPrefix must end with/
  );
});

test("review reasoning escalates only security, high-risk, and exceptional diffs", () => {
  const context = (overrides = {}) => ({
    mode: "review",
    pullRequest: {
      labels: [],
      changedFiles: ["src/feature.mjs"],
      changeSummary: { changedLines: 120, largestFileChangedLines: 80 },
      ...overrides
    }
  });
  assert.deepEqual(reviewReasoningEscalation(source, context()), {
    escalated: false,
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "medium",
    reason: "standard review"
  });
  for (const [overrides, reason] of [
    [{ labels: ["security"] }, "label:security"],
    [{ labels: ["risk high"] }, "label:risk high"],
    [{ changedFiles: ["src/auth/session.mjs"] }, "path:src/auth/session.mjs"],
    [{ changeSummary: { changedLines: 5000, largestFileChangedLines: 400 } }, "changed-lines:5000"],
    [{ changeSummary: { changedLines: 1200, largestFileChangedLines: 1000 } }, "single-file-changed-lines:1000"]
  ]) {
    assert.deepEqual(reviewReasoningEscalation(source, context(overrides)), {
      escalated: true,
      provider: "openai",
      model: "gpt-5.6-luna",
      effort: "max",
      reason
    });
  }
  const settings = getAgentRuntimeSettings(source, "review", {
    context: context({ labels: ["security"] })
  });
  assert.equal(settings.model, "gpt-5.6-luna");
  assert.equal(settings.effort, "max");
  assert.equal(settings.workspaceModel, "gpt-5.6-luna");
  assert.equal(settings.workspaceEffort, "max");

  const customCoordinator = structuredClone(source);
  customCoordinator.ai.agents.review.provider = "openrouter";
  customCoordinator.ai.agents.review.model = "anthropic/claude-sonnet";
  customCoordinator.ai.agents.review.effort = "none";
  assert.equal(getAgentRuntimeSettings(customCoordinator, "review", { context: context() }).provider, "openrouter");
  const escalatedCustom = getAgentRuntimeSettings(customCoordinator, "review", {
    context: context({ labels: ["security"] })
  });
  assert.equal(escalatedCustom.provider, "openai");
  assert.equal(escalatedCustom.model, "gpt-5.6-luna");
  assert.equal(escalatedCustom.effort, "max");
});

test("configuration rejects unsupported user auto-merge, unknown keys, and unsafe ref prefixes", async () => {
  const userAutoMerge = structuredClone(source);
  userAutoMerge.merge.allowUserPullRequests = true;
  await assert.rejects(
    loadConfig(await writeConfig(userAutoMerge)),
    /merge\.allowUserPullRequests must remain false in version 3/
  );

  const unknownRoot = structuredClone(source);
  unknownRoot.unexpected = true;
  await assert.rejects(loadConfig(await writeConfig(unknownRoot)), /policy contains an unknown key unexpected/);

  const unknownNested = structuredClone(source);
  unknownNested.ai.agents.review.workspace.unexpected = true;
  await assert.rejects(
    loadConfig(await writeConfig(unknownNested)),
    /ai\.agents\.review\.workspace contains an unknown key unexpected/
  );

  for (const prefix of ["automation//codekeeper/", "automation/../codekeeper/", "automation/codekeeper.lock/"]) {
    const invalidPrefix = structuredClone(source);
    invalidPrefix.repository.automationBranchPrefix = prefix;
    await assert.rejects(
      loadConfig(await writeConfig(invalidPrefix)),
      /automationBranchPrefix must be a safe Git ref prefix/
    );
  }
});

test("configuration normalizes owners and rejects duplicate owners after normalization", async () => {
  const normalized = structuredClone(source);
  normalized.repository.ownerLogins = ["Repository-Owner"];
  const { config } = await loadConfig(await writeConfig(normalized));
  assert.deepEqual(config.repository.ownerLogins, ["repository-owner"]);

  const duplicate = structuredClone(source);
  duplicate.repository.ownerLogins = ["Repository-Owner", "repository-owner"];
  await assert.rejects(
    loadConfig(await writeConfig(duplicate)),
    /repository\.ownerLogins must not contain duplicates after normalization/
  );
});

test("configuration rejects resource limits above global ceilings and accepts the starter policy", async () => {
  const excessiveLimits = [
    (config) => { config.review.maximumBlockingFindings = Number.MAX_SAFE_INTEGER; },
    (config) => { config.review.maximumNonBlockingFindings = Number.MAX_SAFE_INTEGER; },
    (config) => { config.review.maximumDiffBytes = Number.MAX_SAFE_INTEGER; },
    (config) => { config.review.maximumChangedFiles = Number.MAX_SAFE_INTEGER; },
    (config) => { config.audit.maximumIssuesPerRun = Number.MAX_SAFE_INTEGER; },
    (config) => { config.audit.repair.maximumFiles = Number.MAX_SAFE_INTEGER; },
    (config) => { config.audit.repair.maximumChangedLines = Number.MAX_SAFE_INTEGER; },
    (config) => { config.audit.repair.maximumPatchBytes = Number.MAX_SAFE_INTEGER; },
    (config) => { config.audit.repair.maximumFileBytes = Number.MAX_SAFE_INTEGER; },
    (config) => { config.issues.maximumOpenIssueContext = Number.MAX_SAFE_INTEGER; },
    (config) => { config.merge.maximumFiles = Number.MAX_SAFE_INTEGER; },
    (config) => { config.merge.maximumChangedLines = Number.MAX_SAFE_INTEGER; }
  ];
  for (const setExcessiveLimit of excessiveLimits) {
    const invalid = structuredClone(source);
    setExcessiveLimit(invalid);
    await assert.rejects(loadConfig(await writeConfig(invalid)), /must be at most/);
  }
  await assert.doesNotReject(loadConfig(await writeConfig(structuredClone(source))));
});

test("policy v3 exposes autonomous defaults and OpenRouter without changing workspace ownership", async () => {
  const { config } = await loadConfig(await writeConfig(structuredClone(source)));
  assert.equal(config.version, 3);
  assert.equal(config.automation.automaticPrReview, true);
  assert.equal(config.automation.reviewFeedbackTriage, true);
  assert.equal(config.automation.issueTriage, true);
  assert.equal(config.automation.ownerRequests, true);
  assert.equal(config.automation.maintenanceSchedule, "17 7 * * *");
  assert.equal(config.review.createDeferredIssues, true);
  assert.deepEqual(config.ai.providers.openrouter, {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "chat_completions",
    structuredOutputs: false,
    supportsReasoningEffort: false
  });
  assert.equal(config.ai.agents.review.model, "gpt-5.6-luna");
  assert.equal(config.ai.agents.review.effort, "medium");
  assert.equal(config.ai.agents.review.workspace.model, "gpt-5.6-luna");
  assert.equal(config.ai.agents.review.workspace.effort, "medium");
});

test("maintenance schedules use supported GitHub Actions cron fields and ranges", async () => {
  for (const schedule of ["20/15 * * * *", "*/15 0-23/2 1,15 JAN-DEC MON-FRI"]) {
    const valid = structuredClone(source);
    valid.automation.maintenanceSchedule = schedule;
    await assert.doesNotReject(loadConfig(await writeConfig(valid)), schedule);
  }

  for (const schedule of [
    "foo bar baz qux quux",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 7",
    "10-5 * * * *",
    "*/0 * * * *"
  ]) {
    const invalid = structuredClone(source);
    invalid.automation.maintenanceSchedule = schedule;
    await assert.rejects(
      loadConfig(await writeConfig(invalid)),
      /automation\.maintenanceSchedule must use supported GitHub Actions cron syntax/,
      schedule
    );
  }
});

test("configuration bounds policy list cardinality", async () => {
  const excessiveCommands = structuredClone(source);
  excessiveCommands.audit.repair.validationCommands = Array.from({ length: 17 }, (_, index) => `echo ${index}`);
  await assert.rejects(
    loadConfig(await writeConfig(excessiveCommands)),
    /audit\.repair\.validationCommands must contain at most 16 entries/
  );
});

test("configuration bounds nested model settings numeric magnitudes", async () => {
  const boundaryValues = structuredClone(source);
  boundaryValues.ai.agents.issue.modelSettings.providerData.numericSettings = {
    fractional: 0.25,
    negative: -1_000_000,
    positive: 1_000_000
  };
  await assert.doesNotReject(loadConfig(await writeConfig(boundaryValues)));

  for (const value of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
    const excessiveValue = structuredClone(source);
    excessiveValue.ai.agents.issue.modelSettings.providerData.numericSettings = { value };
    await assert.rejects(
      loadConfig(await writeConfig(excessiveValue)),
      /modelSettings\.providerData\.numericSettings\.value must have an absolute value at most 1000000/
    );
  }
});

test("configuration requires HTTPS providers except explicit loopback development endpoints", async () => {
  const publicHttp = structuredClone(source);
  publicHttp.ai.providers.openai.baseUrl = "http://api.example.test/v1";
  await assert.rejects(loadConfig(await writeConfig(publicHttp)), /must use HTTPS/);

  for (const endpoint of ["http://localhost:8080/v1", "http://agent.localhost/v1", "http://127.0.0.7:8080/v1", "http://[::1]:8080/v1"]) {
    const loopback = structuredClone(source);
    loopback.ai.providers.openai.baseUrl = endpoint;
    await assert.doesNotReject(loadConfig(await writeConfig(loopback)));
  }
});

test("agent effort has one authoritative configuration field", async () => {
  const overridden = structuredClone(source);
  overridden.ai.agents.review.modelSettings.reasoning = { effort: "low" };
  await assert.rejects(
    loadConfig(await writeConfig(overridden)),
    /ai\.agents\.review\.modelSettings\.reasoning\.effort must not be set; use ai\.agents\.review\.effort/
  );
});

test("providers without reasoning-effort support require effort none", async () => {
  const unsupported = structuredClone(source);
  unsupported.ai.agents.issue.effort = "low";
  await assert.rejects(
    loadConfig(await writeConfig(unsupported)),
    /ai\.agents\.issue\.effort requires ai\.providers\.deepseek\.supportsReasoningEffort=true/
  );
});

test("workspace writes remain gated by mode-specific mutation policy", () => {
  assert.equal(source.ai.tracing.enabled, true);
  assert.equal(source.ai.tracing.includeSensitiveData, false);
  assert.equal(getAgentRuntimeSettings(source, "review").workspaceSandbox, "read-only");
  assert.equal(getAgentRuntimeSettings(source, "audit").workspaceSandbox, "read-only");
  assert.equal(getAgentRuntimeSettings(source, "fix").workspaceSandbox, "read-only");

  const enabled = structuredClone(source);
  enabled.audit.repair.enabled = true;
  enabled.issues.allowAiImplementation = true;
  assert.equal(getAgentRuntimeSettings(enabled, "audit", { mutationAuthorized: true }).workspaceSandbox, "workspace-write");
  assert.equal(getAgentRuntimeSettings(enabled, "audit", { mutationAuthorized: false }).workspaceSandbox, "read-only");
  assert.equal(getAgentRuntimeSettings(enabled, "fix", { mutationAuthorized: true }).workspaceSandbox, "workspace-write");

  enabled.issues.allowAiImplementation = false;
  assert.equal(getAgentRuntimeSettings(enabled, "fix", { mutationAuthorized: true }).workspaceSandbox, "workspace-write");
  assert.equal(getAgentRuntimeSettings(enabled, "fix", { mutationAuthorized: false }).workspaceSandbox, "read-only");
});
