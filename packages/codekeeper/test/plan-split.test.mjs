import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  applicableCapabilityIds,
  capabilitySummary,
  modelAssignments,
  normalizeCapabilities,
  normalizeModelChoices,
  normalizeModes,
  normalizeOwnerLogins,
  requiredSecretNames,
  requiresAutomationBotLogin,
} from "../src/plan.mjs";
import {
  applicableCapabilityIds as capabilityIdsFromCapabilities,
  capabilitySummary as capabilitySummaryFromCapabilities,
  normalizeCapabilities as normalizeCapabilitiesFromCapabilities,
  requiresAutomationBotLogin as requiresAutomationBotLoginFromCapabilities,
} from "../src/plan/capabilities.mjs";
import {
  existingSecretNames,
  modelAssignments as modelAssignmentsFromModels,
  modelSummary,
  normalizeModelChoices as normalizeModelChoicesFromModels,
  requiredSecretNames as requiredSecretNamesFromModels,
} from "../src/plan/models.mjs";
import {
  appSlugFromInput,
  BOT_LOGIN,
  normalizeModes as normalizeModesFromNormalization,
  normalizeOwnerLogins as normalizeOwnerLoginsFromNormalization,
  validClientId,
  validDisplayName,
  validPrivateKeyPath,
} from "../src/plan/normalization.mjs";
import {
  applyModelSettings,
  applyPolicyCapabilities,
  applyValidationCommand,
  assertCodeChangingRequirements,
  assertSupportedPreset,
  createValidationBaselinePolicy,
  loadBaselinePolicy,
  resolveValidationCommand,
} from "../src/plan/policy.mjs";
import {
  APP_SECRET,
  DEEPSEEK_SECRET,
  MODE_IDS,
  MODES,
  OPENAI_SECRET,
  OPENROUTER_SECRET,
  TRACE_SECRET,
} from "../src/constants.mjs";
import { upgradePolicy } from "../src/policy.mjs";
import {
  assertInstallerCode,
  loadVerifiedAssets,
  PACKAGE_ROOT,
} from "./helpers.mjs";

const PLAN_MODULES = Object.freeze([
  "normalization.mjs",
  "models.mjs",
  "capabilities.mjs",
  "policy.mjs",
]);

test("plan facade re-exports extracted normalisation, model, and capability helpers", () => {
  assert.equal(normalizeModes, normalizeModesFromNormalization);
  assert.equal(normalizeOwnerLogins, normalizeOwnerLoginsFromNormalization);
  assert.equal(modelAssignments, modelAssignmentsFromModels);
  assert.equal(normalizeModelChoices, normalizeModelChoicesFromModels);
  assert.equal(requiredSecretNames, requiredSecretNamesFromModels);
  assert.equal(applicableCapabilityIds, capabilityIdsFromCapabilities);
  assert.equal(normalizeCapabilities, normalizeCapabilitiesFromCapabilities);
  assert.equal(requiresAutomationBotLogin, requiresAutomationBotLoginFromCapabilities);
  assert.equal(capabilitySummary, capabilitySummaryFromCapabilities);
});

test("extracted planning modules stay pure and do not import installer I/O", async () => {
  for (const fileName of PLAN_MODULES) {
    const source = await readFile(path.join(PACKAGE_ROOT, "src", "plan", fileName), "utf8");
    assert.doesNotMatch(source, /node:fs|node:child_process|node:readline|\.\.\/prompts\.mjs|\.\.\/tui\.mjs|\.\.\/assets\.mjs/);
  }
});

test("extracted display name, client ID, and private-key path validators keep their exact rules", () => {
  assert.equal(validDisplayName("Widget"), true);
  assert.equal(validDisplayName("A".repeat(100)), true);
  assert.equal(validDisplayName(""), false);
  assert.equal(validDisplayName(" Widget"), false);
  assert.equal(validDisplayName("Widget "), false);
  assert.equal(validDisplayName("A".repeat(101)), false);
  assert.equal(validDisplayName("Wid\nget"), false);
  assert.equal(validClientId("Iv123456789012345678"), true);
  assert.equal(validClientId("Iv1.ab1112223334445c"), true);
  assert.equal(validClientId("Iv1.ab1112223334445c "), false);
  assert.equal(validClientId(" Iv1.ab1112223334445c"), false);
  assert.equal(validClientId("Iv1.ab1112223334445c\n"), false);
  assert.equal(validClientId("Iv1.ab1112223334445c\u0000"), false);
  assert.equal(validClientId("Iv1.ab1112223334445c-unsafe"), false);
  assert.equal(validPrivateKeyPath("/tmp/codekeeper.pem"), true);
  assert.equal(validPrivateKeyPath("relative/key.pem"), false);
  assert.equal(validPrivateKeyPath("/tmp/codekeeper.pem "), false);
  assert.equal(validPrivateKeyPath("/tmp/codekeeper.pem\n"), false);
  assert.equal(appSlugFromInput("my-codekeeper-app"), "my-codekeeper-app");
  assert.equal(appSlugFromInput("https://github.com/settings/apps/my-codekeeper-app"), "my-codekeeper-app");
  assert.equal(appSlugFromInput("https://github.com/organizations/acme/settings/apps/my-codekeeper-app/"), "my-codekeeper-app");
  assert.equal(appSlugFromInput("My App"), null);
  assert.equal(BOT_LOGIN.test("codekeeper-acme[bot]"), true);
  assert.equal(BOT_LOGIN.test("codekeeper-acme"), false);
});

test("extracted mode and owner normalisation is deterministic and rejects aliases, empties, and duplicates", () => {
  assert.deepEqual(normalizeModesFromNormalization(["fix", "review", "fix", "issues"]), ["review", "issues", "fix"]);
  assert.deepEqual(normalizeOwnerLoginsFromNormalization([" CoryParrry ", "Acme-Bot"]), ["coryparrry", "acme-bot"]);
  assert.throws(() => normalizeModesFromNormalization([]), assertInstallerCode(assert, "PLAN_INVALID"));
  assert.throws(() => normalizeModesFromNormalization(["all"]), assertInstallerCode(assert, "PLAN_INVALID"));
  assert.throws(() => normalizeModesFromNormalization("review"), (error) => {
    assert.equal(error.code, "PLAN_INVALID");
    assert.equal(error.message, "Select at least one Codekeeper mode.");
    return true;
  });
  assert.throws(() => normalizeOwnerLoginsFromNormalization(["Cory", "cory"]), assertInstallerCode(assert, "PLAN_INVALID"));
  assert.throws(() => normalizeOwnerLoginsFromNormalization(["bad_login"]), (error) => {
    assert.equal(error.code, "PLAN_INVALID");
    assert.equal(error.message, "Owner logins must be unique GitHub login names.");
    return true;
  });
});

test("extracted model assignments follow the selected workflow order", () => {
  assert.deepEqual(modelAssignmentsFromModels(["fix", "review"]), [
    {
      key: "review",
      agent: "review",
      label: "Pull request reviewer",
      workflow: "Pull request review"
    },
    {
      key: "fix",
      agent: "fix",
      label: "Fixer",
      workflow: "Issue implementation and pull request repair"
    }
  ]);
});

test("extracted model choices accept defaults and custom models, and reject unsupported reasoning", async () => {
  const bundle = await loadVerifiedAssets();
  const defaults = normalizeModelChoicesFromModels({
    modes: ["review"],
    preset: "openai",
    bundle
  });
  assert.deepEqual(defaults.review, {
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "medium",
    choice: "luna-medium",
    modelSettings: { text: { verbosity: "low" } }
  });
  assert.ok(Object.isFrozen(defaults));
  assert.ok(Object.isFrozen(defaults.review));

  const custom = normalizeModelChoicesFromModels({
    modes: ["review"],
    preset: "openai",
    bundle,
    choices: {
      review: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        effort: "none"
      }
    }
  });
  assert.deepEqual(custom.review, {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    effort: "none",
    choice: null
  });

  assert.throws(
    () => normalizeModelChoicesFromModels({
      modes: ["review"],
      preset: "openai",
      bundle,
      choices: {
        review: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
          effort: "medium"
        }
      }
    }),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.message, "Model choice is invalid for Pull request review.");
      return true;
    }
  );
  assert.throws(
    () => normalizeModelChoicesFromModels({
      modes: ["review"],
      preset: "openai",
      bundle,
      choices: { review: "luna-medium", issues: "terra-medium" }
    }),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.message, "Model choices do not match the selected workflows.");
      return true;
    }
  );
  assert.throws(
    () => normalizeModelChoicesFromModels({
      modes: ["review"],
      preset: "openai",
      bundle,
      choices: { review: { provider: "openai", model: "gpt-5.6-luna extra", effort: "none" } }
    }),
    assertInstallerCode(assert, "PLAN_INVALID")
  );
});

test("extracted secret derivation keeps the mixed and OpenAI matrix and workspace OpenAI requirement", () => {
  for (let mask = 1; mask < (1 << MODE_IDS.length); mask += 1) {
    const modes = MODE_IDS.filter((_, index) => mask & (1 << index));
    for (const preset of ["mixed", "openai"]) {
      const expected = [];
      if (modes.some((mode) => mode !== "issues") || (modes.includes("issues") && preset === "openai")) {
        expected.push(OPENAI_SECRET);
      }
      if (modes.includes("issues") && preset === "mixed") expected.push(DEEPSEEK_SECRET);
      expected.push(TRACE_SECRET, APP_SECRET);
      assert.deepEqual(requiredSecretNamesFromModels({ modes, preset }), expected, `${preset}: ${modes.join(",")}`);
    }
  }
  assert.deepEqual(requiredSecretNamesFromModels({
    modes: ["review"],
    models: {
      review: { provider: "openrouter", model: "anthropic/claude-sonnet", effort: "none" }
    },
    tracing: false
  }), [OPENAI_SECRET, OPENROUTER_SECRET, APP_SECRET]);
  assert.ok(Object.isFrozen(requiredSecretNamesFromModels({ modes: ["review"], tracing: false })));
});

test("extracted existing-secret names omit unused OpenAI keys when the workspace is disabled", async () => {
  const bundle = await loadVerifiedAssets();
  const policy = upgradePolicy(JSON.parse(bundle.contents["policies/openai.json"]));
  policy.ai.agents.review.provider = "openrouter";
  policy.ai.agents.review.model = "anthropic/claude-sonnet-4.5";
  policy.ai.agents.review.effort = "none";
  policy.ai.agents.review.workspace.enabled = false;
  policy.ai.tracing.enabled = false;
  const names = existingSecretNames({
    modes: ["review"],
    policy
  });
  assert.deepEqual([...names], [OPENROUTER_SECRET, APP_SECRET]);
});

test("extracted model summary freezes coordinator and workspace details", async () => {
  const bundle = await loadVerifiedAssets();
  const policy = upgradePolicy(JSON.parse(bundle.contents["policies/openai.json"]));
  const summary = modelSummary(["review"], policy);
  assert.deepEqual(summary.review, {
    coordinator: {
      provider: "openai",
      model: "gpt-5.6-luna",
      effort: "medium"
    },
    workspace: {
      provider: MODES.review.workspaceProvider,
      enabled: policy.ai.agents.review.workspace.enabled === true,
      model: policy.ai.agents.review.workspace.model ?? "",
      effort: policy.ai.agents.review.workspace.effort ?? "none",
      allowWrites: policy.ai.agents.review.workspace.allowWrites === true
    }
  });
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.review));
  assert.ok(Object.isFrozen(summary.review.coordinator));
  assert.ok(Object.isFrozen(summary.review.workspace));
});

test("extracted capability helpers match workflow applicability, bot requirements, and summaries", () => {
  assert.deepEqual(capabilityIdsFromCapabilities(["review"]), []);
  assert.deepEqual(capabilityIdsFromCapabilities(["review", "fix"]), ["reviewRepair", "issueImplementation", "autoMerge"]);
  assert.deepEqual(capabilityIdsFromCapabilities(MODE_IDS), [
    "reviewRepair",
    "repair",
    "issueImplementation",
    "duplicateClosure",
    "autoMerge"
  ]);
  assert.deepEqual(normalizeCapabilitiesFromCapabilities(["issues"], ["duplicateClosure"]), {
    reviewRepair: false,
    repair: false,
    issueImplementation: false,
    duplicateClosure: true,
    autoMerge: false
  });
  assert.ok(Object.isFrozen(normalizeCapabilitiesFromCapabilities(["review"], [])));
  assert.throws(
    () => normalizeCapabilitiesFromCapabilities(["review"], ["repair"]),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.message, "Capability choices do not match the selected workflows.");
      return true;
    }
  );
  assert.throws(
    () => normalizeCapabilitiesFromCapabilities(["review"], "repair"),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.message, "Capability choices are invalid.");
      return true;
    }
  );
  assert.equal(requiresAutomationBotLoginFromCapabilities(["issues"], [], true), true);
  assert.equal(requiresAutomationBotLoginFromCapabilities(["issues"], [], false), false);
  assert.equal(requiresAutomationBotLoginFromCapabilities(["review"], [], false), true);
  assert.equal(requiresAutomationBotLoginFromCapabilities(["fix"], [], false), false);
  assert.equal(requiresAutomationBotLoginFromCapabilities(["fix"], ["issueImplementation"], false), true);
  assert.equal(requiresAutomationBotLoginFromCapabilities(["fix"], { issueImplementation: true }, false), true);
  assert.deepEqual(
    capabilitySummaryFromCapabilities(normalizeCapabilitiesFromCapabilities(["maintain"], ["repair"]), ["maintain"]),
    ["Repository repair: on.", "Automatic merge: off."]
  );
});

test("extracted policy helpers keep validation, capability, and model-setting behaviour", async () => {
  const bundle = await loadVerifiedAssets();
  assert.throws(
    () => assertSupportedPreset("unknown"),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.message, "Unsupported preset: unknown");
      return true;
    }
  );
  const baseline = loadBaselinePolicy(bundle.contents["policies/openai.json"]);
  assert.equal(baseline.ai.agents.review.model, "gpt-5.6-luna");
  const sameObject = createValidationBaselinePolicy({
    releaseUpdate: false,
    baselinePolicy: baseline,
    bundle,
    preset: "openai",
    defaultBranch: "trunk"
  });
  assert.equal(sameObject, baseline);
  assert.equal(baseline.repository.defaultBranch, "trunk");
  const answers = { validationCommand: "npm test" };
  const snapshot = { validationCommandCandidate: "npm test" };
  assert.equal(resolveValidationCommand(answers, snapshot), "npm test");
  assert.equal(resolveValidationCommand({ validationCommand: "npm run other" }, snapshot), null);
  assert.doesNotThrow(() => assertCodeChangingRequirements({
    reviewRepair: false,
    repair: false,
    issueImplementation: false
  }, null, snapshot));
  assert.throws(
    () => assertCodeChangingRequirements({
      reviewRepair: true,
      repair: false,
      issueImplementation: false
    }, null, snapshot),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.message, "Confirm npm test before enabling code-changing capabilities.");
      return true;
    }
  );
  assert.throws(
    () => assertCodeChangingRequirements({
      reviewRepair: false,
      repair: true,
      issueImplementation: false
    }, null, { validationCommandCandidate: null }),
    (error) => {
      assert.equal(error.code, "PLAN_INVALID");
      assert.equal(error.message, "Code-changing capabilities require a trusted repository validation command. Add a supported root package lockfile and check or test script, then rerun setup.");
      return true;
    }
  );
  const policy = structuredClone(baseline);
  applyValidationCommand(policy, "npm test");
  assert.equal(policy.audit.repair.validationCommands.at(-1), "npm test");
  applyPolicyCapabilities(policy, {
    reviewRepair: true,
    repair: true,
    issueImplementation: true,
    duplicateClosure: true,
    autoMerge: true
  }, false);
  assert.equal(policy.review.autoRepair, true);
  assert.equal(policy.audit.repair.enabled, true);
  assert.equal(policy.issues.allowAiImplementation, true);
  assert.equal(policy.issues.closeExactDuplicates, true);
  assert.equal(policy.merge.enabled, true);
  assert.equal(policy.ai.tracing.enabled, false);
  applyModelSettings(policy, {
    review: { provider: "openai", model: "gpt-5.6-terra", effort: "medium" },
    issues: { provider: "deepseek", model: "deepseek-v4-flash", effort: "none" },
    fix: {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      effort: "none"
    }
  });
  assert.deepEqual(policy.ai.agents.review.modelSettings, { text: { verbosity: "low" } });
  assert.deepEqual(policy.ai.agents.issue.modelSettings, {
    temperature: 0.2,
    providerData: { thinking: { type: "disabled" }, response_format: { type: "json_object" } }
  });
  assert.deepEqual(policy.ai.agents.fix.modelSettings, {});
  const preserved = structuredClone(baseline);
  applyModelSettings(preserved, {
    review: {
      provider: "openai",
      model: "gpt-5.6-luna",
      effort: "medium",
      modelSettings: { text: { verbosity: "high" } }
    }
  });
  assert.deepEqual(preserved.ai.agents.review.modelSettings, { text: { verbosity: "high" } });
});
