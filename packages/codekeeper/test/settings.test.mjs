import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { loadVerifiedAssets } from "../src/assets.mjs";
import { AGENT_PROFILE_IDS, AGENT_PROFILES, MODES } from "../src/constants.mjs";
import { buildInstallPlan } from "../src/plan.mjs";
import { upgradePolicy } from "../src/policy.mjs";
import { editProfileWithEditor } from "../src/settings-tui.mjs";
import {
  createEditableSettings,
  setSetting,
  settingsAnswers,
  settingsRows,
  validateEditableSettings
} from "../src/settings.mjs";
import { HEAD_SHA } from "./helpers.mjs";

async function fixture(modes = ["review", "maintain"]) {
  const bundle = await loadVerifiedAssets();
  const policy = upgradePolicy(JSON.parse(bundle.contents["policies/openai.json"]));
  const profiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  return { bundle, policy, profiles, settings: createEditableSettings({ policy, modes, enabled: true, profiles }) };
}

function row(settings, id, advanced = false) {
  const match = settingsRows(settings, { advanced }).find((candidate) => candidate.id === id);
  assert.ok(match, `missing settings row ${id}`);
  return match;
}

test("standard and advanced settings expose behavior, arbitrary models, profiles, and read-only boundaries", async () => {
  const { settings } = await fixture();
  const standard = settingsRows(settings);
  const advanced = settingsRows(settings, { advanced: true });
  assert.ok(advanced.length > standard.length);
  assert.equal(row(settings, "workflow:assistant").readOnly, true);
  assert.equal(row(settings, "policy:automation.reviewFeedbackTriage").kind, "boolean");
  assert.deepEqual(row(settings, "policy:ai.agents.review.provider").choices, ["openai", "deepseek", "openrouter"]);
  assert.equal(row(settings, "policy:ai.agents.review.model").kind, "string");
  assert.equal(row(settings, "policy:ai.agents.review.modelSettings", true).kind, "json");
  assert.equal(row(settings, "policy:ai.agents.review.maxTurns", true).readOnly, true);
  assert.equal(row(settings, "policy:audit.repair.protectedPaths", true).readOnly, true);
  assert.equal(standard.filter((candidate) => candidate.kind === "profile").length, 4);
  assert.equal(advanced.filter((candidate) => candidate.id.startsWith("release:")).every((candidate) => candidate.readOnly), true);
});

test("one settings object keeps coordinator and workspace models independent", async () => {
  const { policy, settings } = await fixture(["review"]);
  const workspaceModel = settings.policy.ai.agents.review.workspace.model;
  let edited = setSetting(settings, row(settings, "policy:ai.agents.review.provider"), "openrouter");
  edited = setSetting(edited, row(edited, "policy:ai.agents.review.model"), "anthropic/claude-sonnet-4.5");
  assert.equal(edited.policy.ai.agents.review.effort, "none");
  assert.deepEqual(edited.policy.ai.agents.review.modelSettings, {});
  assert.equal(edited.policy.ai.agents.review.workspace.model, workspaceModel);
  validateEditableSettings(edited, policy);
  assert.deepEqual(settingsAnswers(edited).models.review, {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    effort: "none"
  });

  const unsafe = structuredClone(edited);
  unsafe.policy.audit.repair.protectedPaths = ["src/**"];
  assert.throws(() => validateEditableSettings(unsafe, policy), /read-only safety boundary/);
  const incompatible = structuredClone(edited);
  incompatible.policy.ai.agents.review.effort = "high";
  assert.throws(() => validateEditableSettings(incompatible, policy), /incompatible/);
  const unsafeSchedule = structuredClone(edited);
  unsafeSchedule.policy.automation.maintenanceSchedule = "17 7 * * *\"";
  assert.throws(() => validateEditableSettings(unsafeSchedule, policy), /five safe cron fields/);
  const outOfRangeSchedule = structuredClone(edited);
  outOfRangeSchedule.policy.automation.maintenanceSchedule = "99 99 99 99 99";
  assert.throws(() => validateEditableSettings(outOfRangeSchedule, policy), /cron fields with valid ranges/);
  const boundedSchedule = structuredClone(edited);
  boundedSchedule.policy.automation.maintenanceSchedule = "*/15 0-23/2 1,15 * 1-5";
  validateEditableSettings(boundedSchedule, policy);
});

test("changing a provider selects a compatible default model", async () => {
  const { settings } = await fixture(["review"]);
  const provider = row(settings, "policy:ai.agents.review.provider");

  const deepseek = setSetting(settings, provider, "deepseek");
  assert.equal(deepseek.policy.ai.agents.review.model, "deepseek-v4-flash");

  const openrouter = setSetting(settings, provider, "openrouter");
  assert.equal(openrouter.policy.ai.agents.review.model, "openai/gpt-5.6-sol");
});

test("settings reject runtime-incompatible model settings and managed-label removal", async () => {
  const { policy, settings } = await fixture(["review", "issues"]);
  const nestedEffort = structuredClone(settings);
  nestedEffort.policy.ai.agents.review.modelSettings.reasoning = { effort: "high" };
  assert.throws(
    () => validateEditableSettings(nestedEffort, policy),
    /modelSettings\.reasoning\.effort.*top-level agent effort/
  );

  const missingReviewLabel = structuredClone(settings);
  missingReviewLabel.policy.review.managedLabels = missingReviewLabel.policy.review.managedLabels
    .filter((label) => label !== "codekeeper:reviewed");
  assert.throws(
    () => validateEditableSettings(missingReviewLabel, policy),
    /review\.managedLabels.*codekeeper:reviewed/
  );

  const missingIssueLabel = structuredClone(settings);
  missingIssueLabel.policy.issues.managedLabels = missingIssueLabel.policy.issues.managedLabels
    .filter((label) => label !== "codekeeper:ready");
  assert.throws(
    () => validateEditableSettings(missingIssueLabel, policy),
    /issues\.managedLabels.*codekeeper:ready/
  );
});

test("settings cannot disable tracing while sensitive trace export is required", async () => {
  const { policy, profiles } = await fixture(["review"]);
  const baseline = structuredClone(policy);
  baseline.ai.tracing.enabled = true;
  baseline.ai.tracing.includeSensitiveData = true;
  const settings = createEditableSettings({
    policy: baseline,
    modes: ["review"],
    enabled: true,
    profiles
  });
  settings.policy.ai.tracing.enabled = false;

  assert.throws(
    () => validateEditableSettings(settings, baseline),
    /Sensitive trace export requires tracing to stay enabled/
  );
});

test("an enabled issue workspace receives the OpenAI workspace key", async () => {
  const { bundle, policy, settings } = await fixture(["issues"]);
  settings.policy.ai.agents.issue.workspace.enabled = true;
  validateEditableSettings(settings, policy);
  const plan = buildInstallPlan({
    bundle,
    snapshot: {
      root: "/tmp/widget",
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: HEAD_SHA,
      viewerLogin: "coryparrry"
    },
    answers: {
      ...settingsAnswers(settings),
      preset: "openai",
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]"
    }
  });
  const workflow = plan.files.find((file) => file.path === MODES.issues.target).contents;

  assert.ok(plan.secrets.some((secret) => secret.name === "OPENAI_API_KEY"));
  assert.match(workflow, /workspace_api_key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
});

test("settings require each enabled capability to have its executing workflow", async () => {
  const { policy, settings } = await fixture(["review", "maintain"]);
  const automaticRepairWithoutFixer = structuredClone(settings);
  automaticRepairWithoutFixer.policy.review.autoRepair = true;
  assert.throws(
    () => validateEditableSettings(automaticRepairWithoutFixer, policy),
    /Automatic PR repair requires.*Fixer workflow/
  );

  const issueImplementationWithoutFixer = structuredClone(settings);
  issueImplementationWithoutFixer.modes = ["issues"];
  issueImplementationWithoutFixer.policy.issues.allowAiImplementation = true;
  assert.throws(
    () => validateEditableSettings(issueImplementationWithoutFixer, policy),
    /Issue implementation requires the Fixer workflow/
  );
});

test("fresh settings can enable capabilities after bundled defaults are verified", async () => {
  const { bundle, settings } = await fixture(["review", "fix"]);
  const edited = structuredClone(settings);
  edited.policy.review.autoRepair = true;
  const plan = buildInstallPlan({
    bundle,
    snapshot: {
      root: "/tmp/widget",
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: HEAD_SHA,
      viewerLogin: "coryparrry"
    },
    answers: {
      ...settingsAnswers(edited),
      preset: "openai",
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]"
    }
  });
  assert.equal(plan.policy.review.autoRepair, true);
  assert.ok(plan.files.some((file) => file.path === MODES.fix.target));
});

test("profile editing uses a temporary copy and returns only validated Markdown", async () => {
  let editorPath;
  const edited = await editProfileWithEditor({
    profile: "pr-reviewer",
    source: "# Reviewer\n",
    environment: { EDITOR: "test-editor" },
    suspendTerminal: (callback) => callback(),
    runEditor: async (editor, file) => {
      assert.equal(editor, "test-editor");
      editorPath = file;
      await writeFile(file, "# Reviewer\n\nPrioritise API regressions.\n", "utf8");
      return 0;
    }
  });
  assert.match(edited, /Prioritise API regressions/);
  await assert.rejects(readFile(editorPath, "utf8"), /ENOENT/);
});

test("one validated settings object renders matching caller controls and schedule", async () => {
  const { bundle, settings } = await fixture(["review", "maintain", "issues", "fix"]);
  let edited = setSetting(settings, row(settings, "policy:automation.automaticPrReview"), false);
  edited = setSetting(edited, row(edited, "policy:automation.reviewFeedbackTriage"), false);
  edited = setSetting(edited, row(edited, "policy:automation.issueTriage"), false);
  edited = setSetting(edited, row(edited, "policy:automation.ownerRequests"), false);
  edited = setSetting(edited, row(edited, "policy:automation.maintenanceSchedule"), "23 4 * * 2");
  const plan = buildInstallPlan({
    bundle,
    snapshot: {
      root: "/tmp/widget",
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: HEAD_SHA,
      viewerLogin: "coryparrry"
    },
    answers: {
      ...settingsAnswers(edited),
      preset: "openai",
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]"
    }
  });
  const contents = Object.fromEntries(plan.files.map((file) => [file.path, file.contents]));
  assert.match(contents[MODES.review.target], /auto_review: false/);
  assert.match(contents[MODES.review.target], /feedback_triage: false/);
  assert.match(contents[MODES.issues.target], /auto_triage: false/);
  assert.match(contents[MODES.maintain.target], /cron: "23 4 \* \* 2"/);
  assert.match(contents[".github/workflows/codekeeper-assistant.yml"], /owner_requests: false/);
});

test("existing installations can remove a workflow and change a profile in one configuration PR", async () => {
  const { bundle, policy, profiles, settings } = await fixture();
  const baseSnapshot = {
    root: "/tmp/widget",
    repository: "acme/widget",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    viewerLogin: "coryparrry"
  };
  const initial = buildInstallPlan({
    bundle,
    snapshot: baseSnapshot,
    answers: {
      modes: ["review", "maintain"],
      preset: "openai",
      displayName: "Widget",
      ownerLogins: ["coryparrry"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]",
      enabled: true,
      capabilities: [],
      models: { review: "sol-high", maintain: "sol-high" }
    }
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const installedPolicy = JSON.parse(contents[".github/codekeeper.json"]);
  let edited = createEditableSettings({ policy: installedPolicy, modes: ["review", "maintain"], enabled: true, profiles });
  edited = setSetting(edited, row(edited, "workflow:maintain"), false);
  edited = setSetting(edited, row(edited, "profile:pr-reviewer"), `${profiles["pr-reviewer"]}\nPrioritise API regressions.\n`);
  edited = setSetting(edited, row(edited, "policy:automation.ownerRequests"), false);
  const updateAnswers = settingsAnswers(edited);
  const update = buildInstallPlan({
    bundle,
    snapshot: {
      ...baseSnapshot,
      installation: {
        policy: installedPolicy,
        policySource: contents[".github/codekeeper.json"],
        modes: ["review", "maintain"],
        contents
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-acme[bot]"
      },
      updateBranch: "codekeeper/update"
    },
    answers: {
      ...updateAnswers,
      preset: "openai",
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]"
    }
  });
  assert.deepEqual(update.modes, ["review"]);
  assert.equal(update.files.find((file) => file.path === MODES.maintain.target).delete, true);
  assert.match(update.files.find((file) => file.path === AGENT_PROFILES["pr-reviewer"].target).contents, /Prioritise API regressions/);
  assert.match(update.files.find((file) => file.path.endsWith("codekeeper-assistant.yml")).contents, /owner_requests: false/);
});
