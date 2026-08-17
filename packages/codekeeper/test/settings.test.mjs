import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_PROFILE_IDS, AGENT_PROFILES, MODES } from "../src/constants.mjs";
import { buildInstallPlan } from "../src/plan.mjs";
import { upgradePolicy } from "../src/policy.mjs";
import { editProfileWithEditor } from "../src/settings-tui.mjs";
import {
  createEditableSettings,
  parseSettingValue,
  resetProfileOverride,
  setSetting,
  settingsAnswers,
  settingsRows,
  validateEditableSettings
} from "../src/settings.mjs";
import { HEAD_SHA, loadVerifiedAssets } from "./helpers.mjs";

async function fixture(modes = ["review", "maintain"]) {
  const bundle = await loadVerifiedAssets();
  const policy = upgradePolicy(JSON.parse(bundle.contents["policies/openai.json"]));
  const profiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  return {
    bundle,
    policy,
    profiles,
    settings: createEditableSettings({
      policy,
      modes,
      enabled: true,
      profiles
    })
  };
}

function row(settings, id, advanced = false) {
  const match = settingsRows(settings, { advanced }).find((candidate) => candidate.id === id);
  assert.ok(match, `missing settings row ${id}`);
  return match;
}

test("standard and advanced settings expose only editable choices with clear controls", async () => {
  const { settings } = await fixture();
  const standard = settingsRows(settings);
  const advanced = settingsRows(settings, { advanced: true });
  assert.ok(advanced.length > standard.length);
  assert.equal(standard.some((candidate) => candidate.id === "workflow:assistant"), false);
  assert.equal(row(settings, "policy:automation.reviewFeedbackTriage").kind, "boolean");
  assert.deepEqual(row(settings, "policy:ai.agents.review.provider").choices, ["openai", "deepseek", "openrouter"]);
  assert.deepEqual(row(settings, "policy:ai.agents.review.effort").choices, ["none", "minimal", "low", "medium", "high", "max", "xhigh"]);
  const openaiModel = row(settings, "policy:ai.agents.review.model");
  assert.equal(openaiModel.kind, "model");
  assert.deepEqual(openaiModel.choices, [
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.5-pro",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.3-codex"
  ]);
  assert.equal(standard.some((candidate) => Object.hasOwn(candidate, "warning")), false);
  const responseDetail = row(settings, "policy:ai.agents.review.modelSettings.text.verbosity", true);
  assert.equal(responseDetail.kind, "enum");
  assert.deepEqual(responseDetail.choices, ["low", "medium", "high"]);
  assert.equal(advanced.some((candidate) => candidate.id === "policy:ai.providers"), false);
  assert.ok(advanced.filter((candidate) => candidate.inactive).every((candidate) => candidate.readOnly));
  assert.equal(advanced.some((candidate) => candidate.id === "policy:ai.agents.review.maxTurns"), false);
  assert.equal(advanced.some((candidate) => candidate.id === "policy:audit.repair.protectedPaths"), false);
  assert.ok(advanced.every((candidate) => typeof candidate.description === "string" && candidate.description.length > 10));
  assert.equal(standard.filter((candidate) => candidate.kind === "profile").length, 2);
  assert.equal(row(settings, "profile:pr-reviewer").label, "Pull-request review judgment rules");
  assert.match(row(settings, "profile:pr-reviewer").description, /Codekeeper's default instructions/);
  const withOverride = createEditableSettings({
    policy: settings.policy,
    modes: settings.modes,
    enabled: settings.enabled,
    profiles: settings.profiles,
    profileOverrides: ["pr-reviewer"]
  });
  assert.match(row(withOverride, "profile:pr-reviewer").description, /custom repository instructions/);
  assert.equal(advanced.some((candidate) => candidate.id.startsWith("release:")), false);
});

test("scheduled report-only maintenance is an explicit editable setting with a conservative default", async () => {
  const { policy, settings } = await fixture(["review", "maintain"]);
  assert.equal(settings.maintenanceScheduled, true);
  const switchRow = row(settings, "maintenance-scheduled");
  assert.equal(switchRow.label, "Scheduled report-only maintenance");
  assert.match(switchRow.description, /report-only/i);
  assert.match(switchRow.description, /manual maintenance.*dry or live/i);

  const disabled = setSetting(settings, switchRow, false);
  assert.equal(disabled.maintenanceScheduled, false);
  validateEditableSettings(disabled, policy);
  assert.equal(settingsAnswers(disabled).maintenanceScheduled, false);

  const omitted = structuredClone(disabled);
  delete omitted.maintenanceScheduled;
  const beforeValidation = JSON.stringify(omitted);
  validateEditableSettings(omitted, policy);
  assert.equal(JSON.stringify(omitted), beforeValidation);
  assert.equal(settingsAnswers(omitted).maintenanceScheduled, true);

  const removed = setSetting(disabled, row(disabled, "workflow:maintain"), false);
  assert.equal(removed.maintenanceScheduled, false);
  assert.equal(removed.modes.includes("maintain"), false);
  const restored = setSetting(removed, row(removed, "workflow:maintain"), true);
  assert.equal(restored.maintenanceScheduled, false);
});

test("simple settings hide inactive agents while advanced settings preserve them as read-only", async () => {
  const { policy, profiles, settings } = await fixture(["review"]);
  const issueModel = settings.policy.ai.agents.issue.model;
  const issueProfile = `${profiles["issue-triager"]}\nRepository-specific issue rules.\n`;
  settings.profiles["issue-triager"] = issueProfile;
  settings.profileSources["issue-triager"] = "repository";

  const standard = settingsRows(settings);
  assert.equal(standard.some((candidate) => candidate.id.startsWith("policy:ai.agents.issue.")), false);
  assert.equal(standard.some((candidate) => candidate.id === "profile:issue-triager"), false);

  const advanced = settingsRows(settings, { advanced: true });
  const inactiveModel = row(settings, "policy:ai.agents.issue.model", true);
  const inactiveProfile = row(settings, "profile:issue-triager", true);
  for (const candidate of [inactiveModel, inactiveProfile]) {
    assert.equal(candidate.inactive, true);
    assert.equal(candidate.disabled, true);
    assert.equal(candidate.readOnly, true);
    assert.equal(candidate.kind, "readonly");
    assert.match(candidate.description, /Not used — enable the Issue triage workflow/);
  }
  assert.throws(() => setSetting(settings, inactiveModel, "gpt-5.6-sol"), /read-only/);
  assert.ok(advanced.some((candidate) => candidate.id === "profile:issue-triager"));

  const enabled = setSetting(settings, row(settings, "workflow:issues"), true);
  assert.equal(row(enabled, "policy:ai.agents.issue.model").kind, "model");
  assert.equal(row(enabled, "profile:issue-triager").kind, "profile");
  assert.equal(enabled.policy.ai.agents.issue.model, issueModel);
  assert.equal(enabled.profiles["issue-triager"], issueProfile);
  const disabled = setSetting(enabled, row(enabled, "workflow:issues"), false);
  assert.equal(disabled.policy.ai.agents.issue.model, issueModel);
  assert.equal(disabled.profiles["issue-triager"], issueProfile);
});

test("settings answers retain coordinator compatibility and full selected workspace model details", async () => {
  const { settings } = await fixture(["review", "issues"]);
  const answers = settingsAnswers(settings);
  assert.deepEqual(answers.models.review, {
    provider: settings.policy.ai.agents.review.provider,
    model: settings.policy.ai.agents.review.model,
    effort: settings.policy.ai.agents.review.effort
  });
  assert.deepEqual(answers.modelSummary.review, {
    coordinator: answers.models.review,
    workspace: {
      provider: "openai",
      enabled: settings.policy.ai.agents.review.workspace.enabled,
      model: settings.policy.ai.agents.review.workspace.model,
      effort: settings.policy.ai.agents.review.workspace.effort
    }
  });
  assert.deepEqual(answers.modelSummary.issues, {
    coordinator: answers.models.issues,
    workspace: {
      provider: null,
      enabled: settings.policy.ai.agents.issue.workspace.enabled,
      model: settings.policy.ai.agents.issue.workspace.model,
      effort: settings.policy.ai.agents.issue.workspace.effort
    }
  });
});

test("profile source state survives answers and can reset an override to the packaged default", async () => {
  const { policy, profiles, settings } = await fixture();
  const profileRow = row(settings, "profile:pr-reviewer");
  const overridden = setSetting(settings, profileRow, profiles["pr-reviewer"]);
  assert.equal(overridden.profileSources["pr-reviewer"], "repository");
  assert.equal(settingsAnswers(overridden).profileSources["pr-reviewer"], "repository");
  assert.match(row(overridden, "profile:pr-reviewer").description, /custom repository instructions/);

  const reset = resetProfileOverride(overridden, "pr-reviewer");
  assert.equal(reset.profileSources["pr-reviewer"], "package");
  assert.equal(reset.profiles["pr-reviewer"], profiles["pr-reviewer"]);
  assert.equal(settingsAnswers(reset).profileSources["pr-reviewer"], "package");
  validateEditableSettings(reset, policy);

  const inconsistent = structuredClone(reset);
  inconsistent.profiles["pr-reviewer"] += "\nNot the packaged default.\n";
  assert.throws(() => validateEditableSettings(inconsistent, policy), /must match the release default/);
});

test("advanced settings preserve dots inside dynamic label keys", async () => {
  const { settings } = await fixture();
  settings.policy.labels["area:api.v2"] = {
    name: "area:api.v2",
    color: "123456",
    description: "Versioned API area"
  };
  const color = row(settings, "policy:labels.area:api.v2.color", true);
  assert.equal(color.value, "123456");
  const edited = setSetting(settings, color, "abcdef");
  assert.equal(edited.policy.labels["area:api.v2"].color, "abcdef");
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
  const unsafeTurns = structuredClone(edited);
  unsafeTurns.policy.ai.agents.review.maxTurns = 2;
  assert.throws(() => validateEditableSettings(unsafeTurns, policy), /maxTurns is a read-only safety boundary/);
  const incompatible = structuredClone(edited);
  incompatible.policy.ai.agents.review.effort = "high";
  assert.throws(() => validateEditableSettings(incompatible, policy), /supportsReasoningEffort/);
  const unsafeSchedule = structuredClone(edited);
  unsafeSchedule.policy.automation.maintenanceSchedule = "17 7 * * *\"";
  assert.throws(() => validateEditableSettings(unsafeSchedule, policy), /supported GitHub Actions cron syntax/);
  const outOfRangeSchedule = structuredClone(edited);
  outOfRangeSchedule.policy.automation.maintenanceSchedule = "99 99 99 99 99";
  assert.throws(() => validateEditableSettings(outOfRangeSchedule, policy), /supported GitHub Actions cron syntax/);
  const boundedSchedule = structuredClone(edited);
  boundedSchedule.policy.automation.maintenanceSchedule = "*/15 0-23/2 1,15 * 1-5";
  validateEditableSettings(boundedSchedule, policy);
  const namedSchedule = structuredClone(edited);
  namedSchedule.policy.automation.maintenanceSchedule = "*/15 0-23/2 1,15 JAN-DEC MON-FRI";
  validateEditableSettings(namedSchedule, policy);
});

test("changing a provider selects a compatible default model", async () => {
  const { policy, settings } = await fixture(["review"]);
  const provider = row(settings, "policy:ai.agents.review.provider");

  const deepseek = setSetting(settings, provider, "deepseek");
  assert.equal(deepseek.policy.ai.agents.review.model, "deepseek-v4-flash");
  assert.deepEqual(row(deepseek, "policy:ai.agents.review.model").choices, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.deepEqual(row(deepseek, "policy:ai.agents.review.effort").choices, ["none"]);
  assert.deepEqual(row(deepseek, "policy:ai.agents.review.workspace.effort").choices, ["none", "minimal", "low", "medium", "high", "max", "xhigh"]);

  const openrouter = setSetting(settings, provider, "openrouter");
  assert.equal(openrouter.policy.ai.agents.review.model, "openai/gpt-5.6-sol");
  assert.deepEqual(row(openrouter, "policy:ai.agents.review.effort").choices, ["none"]);

  const customProviderDefinition = {
    baseUrl: "https://models.example/v1",
    api: "responses",
    structuredOutputs: true,
    supportsReasoningEffort: false
  };
  policy.ai.providers.custom = structuredClone(customProviderDefinition);
  const customSettings = structuredClone(settings);
  customSettings.policy.ai.providers.custom = structuredClone(customProviderDefinition);
  const customProvider = row(customSettings, "policy:ai.agents.review.provider");
  assert.deepEqual(customProvider.choices, ["openai", "deepseek", "openrouter"]);
  const currentModel = customSettings.policy.ai.agents.review.model;
  const custom = setSetting(customSettings, customProvider, "custom");
  assert.equal(custom.policy.ai.agents.review.model, currentModel);
  assert.equal(custom.policy.ai.agents.review.effort, "none");
  assert.throws(() => validateEditableSettings(custom, policy), /installable provider/);
});

test("settings preserve runtime-valid empty model-setting strings", async () => {
  const { policy, settings } = await fixture(["review"]);
  settings.policy.ai.agents.review.modelSettings = {
    providerData: { optional: "" }
  };

  validateEditableSettings(settings, policy);
  assert.equal(settings.policy.ai.agents.review.modelSettings.providerData.optional, "");
});

test("settings reject runtime-incompatible model settings and managed-label removal", async () => {
  const { policy, settings } = await fixture(["review", "issues"]);
  const nestedEffort = structuredClone(settings);
  nestedEffort.policy.ai.agents.review.modelSettings.reasoning = {
    effort: "high"
  };
  assert.throws(() => validateEditableSettings(nestedEffort, policy), /modelSettings\.reasoning\.effort.*ai\.agents\.review\.effort/);

  const overlongKey = structuredClone(settings);
  overlongKey.policy.ai.agents.review.modelSettings = {
    ["x".repeat(16_385)]: true
  };
  assert.throws(() => validateEditableSettings(overlongKey, policy), /modelSettings.*overlong key/);

  const missingReviewLabel = structuredClone(settings);
  missingReviewLabel.policy.review.managedLabels = missingReviewLabel.policy.review.managedLabels
    .filter((label) => label !== "codekeeper:reviewed");
  assert.throws(
    () => validateEditableSettings(missingReviewLabel, policy),
    /review must explicitly manage emitted label codekeeper:reviewed/
  );

  const missingIssueLabel = structuredClone(settings);
  missingIssueLabel.policy.issues.managedLabels = missingIssueLabel.policy.issues.managedLabels
    .filter((label) => label !== "codekeeper:ready");
  assert.throws(
    () => validateEditableSettings(missingIssueLabel, policy),
    /issues must explicitly manage emitted label codekeeper:ready/
  );
});

test("settings reject every policy shape the runtime validator rejects", async () => {
  const { policy, settings } = await fixture();
  settings.policy.review.unexpected = true;
  assert.throws(
    () => validateEditableSettings(settings, policy),
    /review contains an unknown key unexpected/
  );
});

test("settings keep unusable owner lists inside the editor", async () => {
  const { policy, settings } = await fixture(["review"]);
  for (const ownerLogins of [[], ["Repository-Owner", "repository-owner"]]) {
    const invalid = structuredClone(settings);
    invalid.policy.repository.ownerLogins = ownerLogins;
    invalid.policy.merge.allowedUserAuthors = [...ownerLogins];
    assert.throws(
      () => validateEditableSettings(invalid, policy),
      /repository\.ownerLogins must not be empty|must not contain duplicates/,
    );
  }
});

test("settings validation accepts compatible owner logins without mutating the editor state", async () => {
  const { policy, settings } = await fixture(["review"]);
  settings.policy.repository.ownerLogins = [" Repository-Owner "];
  settings.policy.merge.allowedUserAuthors = ["repository-owner"];
  const beforeValidation = JSON.stringify(settings);

  validateEditableSettings(settings, policy);

  assert.equal(JSON.stringify(settings), beforeValidation);
});

test("Advanced owner edits synchronize canonical merge authors", async () => {
  const { settings } = await fixture(["review"]);
  const edited = setSetting(
    settings,
    row(settings, "policy:repository.ownerLogins", true),
    [" NewOwner "]
  );

  assert.deepEqual(edited.policy.repository.ownerLogins, ["newowner"]);
  assert.deepEqual(edited.policy.merge.allowedUserAuthors, ["newowner"]);
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
    /ai\.tracing\.includeSensitiveData requires ai\.tracing\.enabled=true/
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
    /Issue implementation requires both.*Issue triage.*Fixer workflows/
  );

  const issueImplementationWithoutTriage = structuredClone(settings);
  issueImplementationWithoutTriage.modes = ["fix"];
  issueImplementationWithoutTriage.policy.issues.allowAiImplementation = true;
  assert.throws(
    () => validateEditableSettings(issueImplementationWithoutTriage, policy),
    /Issue implementation requires both.*Issue triage.*Fixer workflows/
  );

  const automaticMergeWithoutReview = structuredClone(settings);
  automaticMergeWithoutReview.modes = ["fix"];
  automaticMergeWithoutReview.policy.merge.enabled = true;
  assert.throws(
    () => validateEditableSettings(automaticMergeWithoutReview, policy),
    /Automatic merge requires the Review workflow.*repair workflow/
  );

  const omittedModelSettings = structuredClone(settings);
  delete omittedModelSettings.policy.ai.agents.review.modelSettings;
  const beforeValidation = JSON.stringify(omittedModelSettings);
  validateEditableSettings(omittedModelSettings, policy);
  assert.equal(JSON.stringify(omittedModelSettings), beforeValidation);
});

test("settings preserve runtime-valid optional fields and display-name limits", async () => {
  const { policy, settings } = await fixture(["review"]);

  for (const displayName of [" Widget", "Widget ", "x".repeat(101)]) {
    const invalid = structuredClone(settings);
    invalid.policy.repository.displayName = displayName;
    assert.throws(
      () => validateEditableSettings(invalid, policy),
      /repository\.displayName is invalid/
    );
  }
  const bounded = structuredClone(settings);
  bounded.policy.repository.displayName = "x".repeat(100);
  validateEditableSettings(bounded, policy);

  const optional = structuredClone(settings);
  delete optional.policy.projectInvariants;
  for (const agent of Object.values(optional.policy.ai.agents)) {
    agent.workspace.enabled = false;
    delete agent.workspace.model;
    delete agent.workspace.effort;
  }
  const beforeValidation = JSON.stringify(optional);
  validateEditableSettings(optional, policy);
  assert.equal(JSON.stringify(optional), beforeValidation);
  const workspaceModel = row(optional, "policy:ai.agents.review.workspace.model");
  assert.equal(workspaceModel.kind, "model");
  assert.equal(parseSettingValue(workspaceModel, "gpt-5.6-sol"), "gpt-5.6-sol");
});

test("fresh settings can enable capabilities after bundled defaults are verified", async () => {
  const { bundle, settings } = await fixture(["review", "fix"]);
  const edited = structuredClone(settings);
  edited.policy.review.autoRepair = true;
  edited.validationCommandCandidate = "npm test";
  edited.validationCommand = "npm test";
  const plan = buildInstallPlan({
    bundle,
    snapshot: {
      root: "/tmp/widget",
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: HEAD_SHA,
      viewerLogin: "coryparrry",
      validationCommandCandidate: "npm test"
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

test("profile editing rejects private-key PEM envelopes", async () => {
  await assert.rejects(
    editProfileWithEditor({
      profile: "pr-reviewer",
      source: "# Reviewer\n",
      environment: { EDITOR: "test-editor" },
      suspendTerminal: (callback) => callback(),
      runEditor: async (_editor, file) => {
        await writeFile(file, "# Reviewer\n\n-----BEGIN PRIVATE KEY-----\ncanary\n-----END PRIVATE KEY-----\n", "utf8");
        return 0;
      }
    }),
    (error) => error.code === "PROFILE_INVALID"
  );
});

test("profile editor receives the generated path without a command shell", async () => {
  let invocation;
  const edited = await editProfileWithEditor({
    profile: "pr-reviewer",
    source: "# Reviewer\n",
    environment: { EDITOR: "test-editor --wait --reuse-window" },
    suspendTerminal: (callback) => callback(),
    spawnEditor(editor, args, options) {
      invocation = { editor, args, options };
      const child = {
        once(event, callback) {
          if (event === "exit") queueMicrotask(() => callback(0, null));
          return child;
        }
      };
      return child;
    }
  });

  assert.equal(edited, "# Reviewer\n");
  assert.equal(invocation.editor, "test-editor");
  assert.deepEqual(invocation.args.slice(0, -1), ["--wait", "--reuse-window"]);
  assert.equal(invocation.args.length, 3);
  assert.equal(invocation.options.shell, false);
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
  assert.match(contents[MODES.maintain.target], /dry_run: \$\{\{ github\.event_name == 'schedule' \|\| inputs\.dry_run \}\}/);
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
  let edited = createEditableSettings({
    policy: installedPolicy,
    modes: ["review", "maintain"],
    enabled: true,
    profiles
  });
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
