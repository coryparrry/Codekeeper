import assert from "node:assert/strict";
import test from "node:test";
import {
  explainControlSurface,
  parseControlArgs,
  parseNonInteractiveConfig
} from "../src/control-surface-core.mjs";

test("control-surface CLI options stay command-specific", () => {
  assert.deepEqual(parseControlArgs("status", ["--json"]), {
    json: true,
    apply: false,
    capability: null,
    configPath: null,
    packageIntegrity: null
  });
  assert.deepEqual(parseControlArgs("explain", ["--capability", "repair"]), {
    json: false,
    apply: false,
    capability: "repair",
    configPath: null,
    packageIntegrity: null
  });
  assert.deepEqual(parseControlArgs("plan", ["--config", "setup.json", "--apply"]), {
    json: false,
    apply: true,
    capability: null,
    configPath: "setup.json",
    packageIntegrity: null
  });
  assert.throws(() => parseControlArgs("status", ["--apply"]), /Unsupported status option/);
  assert.throws(() => parseControlArgs("plan", []), /requires --config/);
});

test("noninteractive configuration is strict and credential-free", () => {
  const config = parseNonInteractiveConfig({
    version: 1,
    modes: ["review", "maintain"],
    preset: "openai",
    capabilities: [],
    tracing: false,
    maintenanceScheduled: false,
    enabled: true,
    models: {
      review: {
        provider: "openai",
        model: "gpt-5.6-luna",
        effort: "medium",
        modelSettings: { text: { verbosity: "low" } }
      }
    }
  });
  assert.equal(config.version, 1);
  assert.throws(() => parseNonInteractiveConfig({ version: 1, apiKey: "secret" }), /credential field/);
  assert.throws(() => parseNonInteractiveConfig({ version: 1, models: { review: { provider: "openai", model: "bad model", effort: "medium" } } }), /safe model ID/);
  assert.throws(() => parseNonInteractiveConfig({ version: 1, extra: true }), /unsupported fields/);
});

test("credential detection descends into nested model settings", () => {
  assert.throws(
    () => parseNonInteractiveConfig({
      version: 1,
      models: {
        review: {
          provider: "openai",
          model: "gpt-5.6-luna",
          effort: "medium",
          modelSettings: { providerData: { accessToken: "not-allowed" } }
        }
      }
    }),
    /credential field accessToken/
  );
});

test("authority explanation reports actual triggers and one selected capability", () => {
  const explanation = explainControlSurface({
    installed: true,
    repository: "example/repo",
    enabled: true,
    owners: ["owner"],
    appPermissions: { contents: "read", issues: "write", pullRequests: "write" },
    capabilities: { reviewRepair: false, repair: true, issueImplementation: false, duplicateClosure: false, autoMerge: false },
    modes: ["review", "maintain"],
    scheduledMaintenance: false,
    ownerRequests: false,
    agents: {
      review: { provider: "openai" },
      maintain: { provider: "openai" }
    },
    tracing: false,
    requiredSecrets: ["OPENAI_API_KEY"],
    validationCommands: ["git diff --check"],
    budgets: { reviewFiles: 100 }
  }, "repair");
  assert.deepEqual(Object.keys(explanation.authority.capabilities), ["repair"]);
  assert.equal(explanation.authority.capabilities.repair.enabled, true);
  assert.equal(explanation.authority.automaticTriggers.ownerRequests, false);
  assert.deepEqual(explanation.data.providers, ["openai"]);
});
