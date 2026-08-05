import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentRuntimeSettings, loadConfig } from "../src/lib/config.mjs";

const source = JSON.parse(
  await readFile(new URL("../../../.github/ai-maintainer.json", import.meta.url), "utf8")
);

async function writeConfig(value) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-maintainer-config-test-"));
  const file = path.join(directory, "policy.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

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

  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      review: { ...source.review, allowedLabels: [...source.review.allowedLabels, "undefined-label"] }
    })),
    /review references undefined label undefined-label/
  );

  const missingRuntimeLabel = structuredClone(source);
  delete missingRuntimeLabel.labels["ai-maintainer:ready"];
  await assert.rejects(
    loadConfig(await writeConfig(missingRuntimeLabel)),
    /runtime requires undefined label ai-maintainer:ready/
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
      repository: { ...source.repository, automationBranchPrefix: "automation/ai-maintainer" }
    })),
    /automationBranchPrefix must end with/
  );
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
  assert.equal(getAgentRuntimeSettings(enabled, "audit").workspaceSandbox, "workspace-write");
  assert.equal(getAgentRuntimeSettings(enabled, "fix").workspaceSandbox, "workspace-write");
});
