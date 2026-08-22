import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  renderInstallFiles,
  renderPolicy,
  renderUnifiedWorkflow,
  sha256
} from "../src/assets.mjs";
import { applyPolicyPreset } from "../../../tools/codekeeper/presets/catalogue.mjs";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  APP_SECRET,
  DEEPSEEK_SECRET,
  MODE_IDS,
  MODEL_OPTIONS,
  MODES,
  OPENAI_SECRET,
  OPENROUTER_SECRET,
  RECOMMENDED_MODES,
  RECOMMENDED_PRESET,
  RELEASE_MANIFEST_TARGET,
  SOURCE_COMMIT,
  SOURCE_REPOSITORY,
  TRACE_SECRET,
  UNIFIED_CALLER_WORKFLOW
} from "../src/constants.mjs";
import { ASSET_KEYS } from "../src/repository-artifacts.mjs";
import {
  appPermissions,
  appRegistrationUrl,
  buildInstallPlan,
  buildUpdateAnswers,
  completionGuidance,
  documentMap,
  normalizeModelChoices,
  normalizeModes,
  normalizeOwnerLogins,
  requiredSecretNames,
  setupPullRequestBody,
  workflowMap
} from "../src/plan.mjs";
import { upgradePolicy } from "../src/policy.mjs";
import {
  assertInstallerCode,
  HEAD_SHA,
  loadVerifiedAssets,
  PACKAGE_ROOT,
  PINNED_COMMIT,
  REPOSITORY_ROOT,
  TEST_PACKAGE_RELEASE
} from "./helpers.mjs";

const CHECKPOINT_PATHS = Object.freeze({
  "policies/mixed.json": ".github/codekeeper.json",
  "policies/openai.json": ".github/codekeeper.json#preset=openai",
  "workflows/codekeeper.yml": "examples/workflows/codekeeper.yml.example"
});

const CHECKPOINT_PROVENANCE_PATHS = Object.freeze({
  presetCatalogue: "tools/codekeeper/presets/catalogue.mjs",
  toolingManifest: "tools/codekeeper/tooling-manifest.json"
});

function snapshot() {
  return Object.freeze({
    root: "/tmp/widget",
    repository: "acme/widget",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    viewerLogin: "coryparrry",
    validationCommandCandidate: "npm test"
  });
}

function answers(overrides = {}) {
  const value = {
    modes: ["review", "maintain", "issues", "fix"],
    preset: "mixed",
    displayName: "Widget",
    ownerLogins: ["CoryParrry", "Acme-Bot"],
    appClientId: "Iv123456789012345678",
    automationBotLogin: "Codekeeper-Acme[bot]",
    enabled: true,
    validationCommand: "npm test",
    ...overrides
  };
  if (!Object.hasOwn(overrides, "capabilities")) {
    value.capabilities = [
      ...(value.modes.includes("review") && value.modes.includes("fix") ? ["reviewRepair"] : []),
      ...(value.modes.includes("maintain") ? ["repair"] : []),
      ...(value.modes.includes("fix") ? ["issueImplementation"] : []),
      ...(value.modes.includes("issues") ? ["duplicateClosure"] : []),
      ...(value.modes.some((mode) => mode === "maintain" || mode === "fix") ? ["autoMerge"] : [])
    ];
  }
  return value;
}

test("the bundled asset inventory and metadata match their canonical source bytes", async () => {
  const bundle = await loadVerifiedAssets();
  assert.equal(bundle.metadata.source.repository, SOURCE_REPOSITORY);
  assert.equal(bundle.metadata.source.commit, SOURCE_COMMIT);
  assert.equal(SOURCE_COMMIT, PINNED_COMMIT);
  assert.deepEqual(Object.keys(bundle.metadata.assets).sort(), ASSET_KEYS);
  assert.deepEqual(Object.keys(bundle.contents).sort(), ASSET_KEYS);
  for (const key of ASSET_KEYS) {
    const record = bundle.metadata.assets[key];
    const contents = bundle.contents[key];
    const checkpointPath = key.startsWith("agents/") ? `tools/codekeeper/${key}` : CHECKPOINT_PATHS[key];
    if (checkpointPath) assert.equal(record.sourcePath, checkpointPath, `${key} source path`);
    const [sourcePath, preset] = (checkpointPath ?? record.sourcePath).split("#preset=");
    const baseSource = checkpointPath
      ? execFileSync("git", ["show", `${PINNED_COMMIT}:${sourcePath}`], {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8"
        })
      : await readFile(path.join(REPOSITORY_ROOT, ...sourcePath.split("/")), "utf8");
    const source = preset
      ? `${JSON.stringify(applyPolicyPreset(JSON.parse(baseSource), preset), null, 2)}\n`
      : baseSource;
    assert.equal(contents, source, `${key} canonical source`);
    assert.equal(record.bytes, Buffer.byteLength(source), `${key} bytes`);
    assert.equal(record.sha256, sha256(source), `${key} SHA-256`);
  }
  assert.ok(Object.isFrozen(bundle));
  assert.ok(Object.isFrozen(bundle.metadata.assets));
});

test("the pinned runtime accepts the policy version emitted by this installer", async () => {
  const bundle = await loadVerifiedAssets();
  const emittedVersion = JSON.parse(renderPolicy(bundle.contents["policies/openai.json"], {
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"]
  })).version;
  const pinnedValidator = execFileSync("git", ["show", `${SOURCE_COMMIT}:tools/codekeeper/src/lib/policy-validator.mjs`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8"
  });
  assert.equal(emittedVersion, 3);
  assert.match(pinnedValidator, /config\.version === 3/);
});

test("bundled provenance is byte-for-byte metadata from the pinned source release", async () => {
  const bundle = await loadVerifiedAssets();
  assert.deepEqual(Object.keys(bundle.metadata.provenance).sort(), Object.keys(CHECKPOINT_PROVENANCE_PATHS).sort());
  for (const [name, sourcePath] of Object.entries(CHECKPOINT_PROVENANCE_PATHS)) {
    const source = execFileSync("git", ["show", `${PINNED_COMMIT}:${sourcePath}`], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8"
    });
    assert.equal(bundle.metadata.provenance[name].sha256, sha256(source), `${name} SHA-256`);
    assert.equal(bundle.metadata.provenance[name].bytes, Buffer.byteLength(source), `${name} bytes`);
  }
});

test("bundled starter profiles remain byte-for-byte pinned until the runtime checkpoint is released", async () => {
  const bundle = await loadVerifiedAssets();
  for (const profile of AGENT_PROFILE_IDS) {
    const definition = AGENT_PROFILES[profile];
    const canonical = execFileSync(
      "git",
      ["show", `${PINNED_COMMIT}:tools/codekeeper/agents/${profile}.md`],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    assert.equal(bundle.contents[definition.asset], canonical, definition.target);
  }
});

test("bundled starter profiles define evidence-first role boundaries", async () => {
  const { contents } = await loadVerifiedAssets();
  assert.match(contents["agents/repository-auditor.md"], /Evidence standard/);
  assert.match(contents["agents/issue-triager.md"], /Duplicate rule/);
  assert.match(contents["agents/fixer.md"], /Preflight/);
  assert.match(contents["agents/fixer.md"], /smallest complete change/i);
  assert.match(contents["agents/pr-reviewer.md"], /Finding gate/);
});

test("asset verification rejects an altered inventory or a single changed byte", async () => {
  const metadataPath = path.join(PACKAGE_ROOT, "assets", "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const extra = structuredClone(metadata);
  extra.assets["workflows/codekeeper-extra.yml"] = extra.assets["workflows/codekeeper.yml"];
  await assert.rejects(
    loadVerifiedAssets({
      packageRoot: PACKAGE_ROOT,
      fsImpl: {
        lstat,
        readFile: async (target) => target === metadataPath ? Buffer.from(JSON.stringify(extra)) : readFile(target)
      }
    }),
    assertInstallerCode(assert, "ASSET_INVENTORY_INVALID")
  );

  const reviewPath = path.join(PACKAGE_ROOT, "assets", "workflows", "codekeeper.yml");
  await assert.rejects(
    loadVerifiedAssets({
      packageRoot: PACKAGE_ROOT,
      fsImpl: {
        lstat,
        readFile: async (target) => target === reviewPath ? Buffer.concat([await readFile(target), Buffer.from("x")]) : readFile(target)
      }
    }),
    assertInstallerCode(assert, "ASSET_DIGEST_MISMATCH")
  );
});

test("rendered policies personalize only repository identity while retaining conservative controls", async () => {
  const bundle = await loadVerifiedAssets();
  for (const preset of ["mixed", "openai"]) {
    const original = JSON.parse(bundle.contents[`policies/${preset}.json`]);
    const rendered = JSON.parse(renderPolicy(bundle.contents[`policies/${preset}.json`], {
      displayName: "Acme Widget",
      defaultBranch: "trunk",
      ownerLogins: ["coryparrry", "acme-bot"]
    }));
    assert.equal(rendered.repository.displayName, "Acme Widget");
    assert.equal(rendered.repository.defaultBranch, "trunk");
    assert.deepEqual(rendered.repository.ownerLogins, ["coryparrry", "acme-bot"]);
    assert.deepEqual(rendered.merge.allowedUserAuthors, ["coryparrry", "acme-bot"]);
    assert.equal(rendered.audit.repair.enabled, false);
    assert.equal(rendered.issues.allowAiImplementation, false);
    assert.equal(rendered.issues.closeExactDuplicates, false);
    assert.equal(rendered.issues.closeResolvedIssues, true);
    assert.equal(rendered.merge.enabled, false);
    assert.ok(Object.keys(rendered.labels).every((name) => /^[a-z0-9 :-]+$/.test(name)));
    assert.ok(Object.keys(rendered.labels).some((name) => name.startsWith("codekeeper:")));
    assert.ok(Object.entries(rendered.labels)
      .filter(([name]) => !name.startsWith("codekeeper:"))
      .every(([, definition]) => !/codekeeper/i.test(definition.description)));
    assert.ok(rendered.audit.repair.protectedPaths.length > 0);
    assert.ok(rendered.audit.repair.validationCommands.includes("git diff --check"));
    assert.deepEqual(rendered.ai, upgradePolicy(original).ai);
  }
});

test("a same-provider model change stays in policy and does not rewrite a workflow", async () => {
  const bundle = await loadVerifiedAssets();
  const custom = JSON.parse(bundle.contents["policies/openai.json"]);
  custom.ai.agents.review.provider = "openrouter";
  custom.ai.agents.review.model = "anthropic/claude-sonnet-4.5";
  custom.ai.agents.review.effort = "none";
  custom.ai.agents.review.modelSettings = {
    temperature: 0.7,
    providerData: { route: "latency" }
  };
  custom.ai.agents.review.workspace.model = "gpt-5.6-luna";
  const models = normalizeModelChoices({
    modes: ["review"],
    preset: "openai",
    bundle,
    policySource: JSON.stringify(custom),
    choices: {
      review: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        effort: "none"
      }
    }
  });
  const renderedPolicy = JSON.parse(renderPolicy(JSON.stringify(custom), {
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    models
  }));
  assert.equal(renderedPolicy.ai.agents.review.model, "anthropic/claude-sonnet-4.5");
  assert.deepEqual(renderedPolicy.ai.agents.review.modelSettings, custom.ai.agents.review.modelSettings);
  assert.equal(renderedPolicy.ai.agents.review.workspace.model, "gpt-5.6-luna");
  const rendered = renderUnifiedWorkflow(bundle.contents[UNIFIED_CALLER_WORKFLOW.asset], {
    packageRelease: TEST_PACKAGE_RELEASE,
    ownerRequests: true,
    modes: MODE_IDS
  });
  assert.doesNotMatch(rendered, /gpt-5\.6-(?:sol|terra|luna)/);
});

test("retaining a curated model preserves adopter-edited model settings", async () => {
  const bundle = await loadVerifiedAssets();
  const custom = JSON.parse(bundle.contents["policies/openai.json"]);
  custom.ai.agents.review.modelSettings = {
    text: { verbosity: "high" },
    providerData: { serviceTier: "flex" }
  };
  const currentOption = MODEL_OPTIONS.openai.find((option) =>
    option.provider === custom.ai.agents.review.provider
      && option.model === custom.ai.agents.review.model
      && option.effort === custom.ai.agents.review.effort
  );
  assert.ok(currentOption);

  const models = normalizeModelChoices({
    modes: ["review"],
    preset: "openai",
    bundle,
    policySource: JSON.stringify(custom),
    choices: { review: currentOption.id }
  });
  const renderedPolicy = JSON.parse(renderPolicy(JSON.stringify(custom), {
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    models
  }));

  assert.deepEqual(models.review.modelSettings, custom.ai.agents.review.modelSettings);
  assert.deepEqual(renderedPolicy.ai.agents.review.modelSettings, custom.ai.agents.review.modelSettings);
});

test("policy reruns add newly required labels without replacing adopter customizations", async () => {
  const bundle = await loadVerifiedAssets();
  const bundledPolicy = upgradePolicy(JSON.parse(bundle.contents["policies/openai.json"]));
  const previous = structuredClone(bundledPolicy);
  delete previous.labels["codekeeper:paused"];
  delete previous.labels["codekeeper:auto-repaired"];
  previous.labels["codekeeper:ready"].description =
    "Repository-specific ready label";
  const rendered = JSON.parse(renderPolicy(JSON.stringify(previous), {
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    enforceBundledDefaults: false,
    requiredPolicySource: bundle.contents["policies/openai.json"]
  }));
  assert.equal(
    rendered.labels["codekeeper:ready"].description,
    "Repository-specific ready label",
  );
  assert.deepEqual(
    rendered.labels["codekeeper:paused"],
    bundledPolicy.labels["codekeeper:paused"],
  );
  assert.deepEqual(
    rendered.labels["codekeeper:auto-repaired"],
    bundledPolicy.labels["codekeeper:auto-repaired"],
  );
});

test("openai preset changes only issue-triage model policy from the mixed preset", async () => {
  const bundle = await loadVerifiedAssets();
  const mixed = JSON.parse(bundle.contents["policies/mixed.json"]);
  const openai = JSON.parse(bundle.contents["policies/openai.json"]);
  const mixedIssue = mixed.ai.agents.issue;
  const openaiIssue = openai.ai.agents.issue;
  delete mixed.ai.agents.issue;
  delete openai.ai.agents.issue;
  assert.deepEqual(openai, mixed);
  assert.equal(mixedIssue.provider, "deepseek");
  assert.equal(mixedIssue.model, "deepseek-v4-flash");
  assert.equal(mixedIssue.effort, "none");
  assert.equal(openaiIssue.provider, "openai");
  assert.equal(openaiIssue.model, "gpt-5.6-terra");
  assert.equal(openaiIssue.effort, "medium");
  assert.equal(openaiIssue.workspace.enabled, true);
  assert.equal(openaiIssue.workspace.allowWrites, false);
  assert.deepEqual(openaiIssue.workspace, {
    enabled: true,
    allowWrites: false,
    model: "gpt-5.6-terra",
    effort: "medium"
  });
});

test("the unified caller contains one pinned generic runtime per installed stage", async () => {
  const bundle = await loadVerifiedAssets();
  for (const preset of ["mixed", "openai"]) {
    const policy = JSON.parse(bundle.contents[`policies/${preset}.json`]);
    const rendered = renderUnifiedWorkflow(bundle.contents[UNIFIED_CALLER_WORKFLOW.asset], {
      packageRelease: TEST_PACKAGE_RELEASE,
      ownerRequests: true,
      automationBotLogin: "Codekeeper-Acme[bot]",
      modes: MODE_IDS,
      policy
    });
    const uses = rendered.split("\n").map((line) => line.trim()).filter((line) => /^(?:- )?uses:/.test(line));
    assert.equal(uses.length, 5, preset);
    assert.equal(uses.filter((line) => line === "uses: ./.github/workflows/codekeeper-runtime.yml").length, 5);
    assert.match(rendered, new RegExp(TEST_PACKAGE_RELEASE.integrity.replaceAll("+", "\\+")));
    assert.match(rendered, new RegExp(`installed_modes: "${MODE_IDS.join(",")}"`));
    assert.match(rendered, /contains\(github\.event\.comment\.body, '@codekeeper-acme'\)/);
    assert.doesNotMatch(rendered, /AUTOMATION_BOT_MENTION/);
    assert.doesNotMatch(rendered, /OWNER\/REPOSITORY|FULL_COMMIT_SHA|PACKAGE_(?:VERSION|INTEGRITY)/);
    assert.match(rendered, /codekeeper:ready/);
    for (const secret of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "OPENAI_TRACE_API_KEY", "CODEKEEPER_APP_PRIVATE_KEY"]) {
      assert.match(rendered, new RegExp(`secrets\\.${secret}`));
    }
  }
});

test("the unified caller wires named provider secrets and leaves App permissions to the runtime", async () => {
  const bundle = await loadVerifiedAssets();
  const policy = upgradePolicy(JSON.parse(bundle.contents["policies/openai.json"]));
  policy.review.autoRepair = false;
  policy.audit.repair.enabled = false;
  policy.issues.allowAiImplementation = false;
  policy.merge.enabled = false;
  const files = renderInstallFiles(bundle, {
    modes: ["review", "maintain", "issues", "fix"],
    preset: "openai",
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    policySource: JSON.stringify(policy),
    enforceBundledDefaults: false
  });
  const contents = Object.fromEntries(files.map((file) => [file.path, file.contents]));
  const caller = contents[UNIFIED_CALLER_WORKFLOW.target];
  assert.match(caller, /installed_modes: "review,maintain,issues,fix"/);
  assert.doesNotMatch(caller, /APP_(?:CONTENTS|ISSUES|PULL_REQUESTS)_PERMISSION/);
  for (const secret of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "OPENAI_TRACE_API_KEY", "CODEKEEPER_APP_PRIVATE_KEY"]) {
    assert.match(caller, new RegExp(`secrets\\.${secret}`));
  }

  const automaticRepairFiles = renderInstallFiles(bundle, {
    modes: ["review", "fix"],
    preset: "openai",
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    capabilities: { reviewRepair: true },
    policySource: JSON.stringify(policy),
    enforceBundledDefaults: false
  });
  assert.match(automaticRepairFiles.find((file) => file.path === UNIFIED_CALLER_WORKFLOW.target).contents, /installed_modes: "review,fix"/);

  for (const [modes, contentsPermission] of [["issues"], ["maintain"]].map((selected) => [selected, selected[0] === "issues" ? "write" : "read"])) {
    const subset = renderInstallFiles(bundle, {
      modes,
      preset: "openai",
      displayName: "Widget",
      defaultBranch: "main",
      ownerLogins: ["coryparrry"],
      policySource: JSON.stringify(policy),
      enforceBundledDefaults: false
    });
    const caller = subset.find((file) => file.path === UNIFIED_CALLER_WORKFLOW.target).contents;
    assert.match(caller, new RegExp(`installed_modes: "${modes.join(",")}"`));
    assert.doesNotMatch(caller, new RegExp(`app_contents_permission: "${contentsPermission}"`));
  }
});

test("owner-request dispatch authority is reflected in App registration permissions", () => {
  assert.equal(appPermissions({ modes: ["review"], capabilities: [], ownerRequests: true }).contents, "write");
  assert.equal(appPermissions({ modes: ["review"], capabilities: [], ownerRequests: false }).contents, "read");
  assert.equal(appPermissions({ modes: ["maintain"], capabilities: [], ownerRequests: true }).contents, "read");
  assert.equal(appPermissions({ modes: ["issues"], capabilities: [], ownerRequests: true }).pullRequests, "write");
  assert.equal(appPermissions({ modes: ["maintain"], capabilities: [], ownerRequests: true }).pullRequests, "write");
  assert.equal(appPermissions({ modes: ["issues"], capabilities: [], ownerRequests: false }).pullRequests, "read");
});

test("unified workflow rendering rejects unresolved release placeholders", async () => {
  const bundle = await loadVerifiedAssets();
  const template = bundle.contents[UNIFIED_CALLER_WORKFLOW.asset].replace("PACKAGE_VERSION", "UNRESOLVED");
  assert.throws(
    () => renderUnifiedWorkflow(template, {
      packageRelease: TEST_PACKAGE_RELEASE,
      ownerRequests: true,
      modes: ["review"]
    }),
    assertInstallerCode(assert, "WORKFLOW_RENDER_INVALID")
  );
});

test("unified caller rendering honors an explicit disabled owner-request setting", async () => {
  const bundle = await loadVerifiedAssets();
  const rendered = renderUnifiedWorkflow(bundle.contents[UNIFIED_CALLER_WORKFLOW.asset], {
    packageRelease: TEST_PACKAGE_RELEASE,
    ownerRequests: false,
    modes: ["review"]
  });
  assert.match(rendered, /owner_requests: false/);
  assert.match(rendered, /installed_modes: "review"/);
  assert.doesNotMatch(rendered, /APP_(?:CONTENTS|ISSUES|PULL_REQUESTS)_PERMISSION/);
  assert.match(rendered, /^  workflow_dispatch:/m);
  assert.match(rendered, /verification_id:/);
  assert.doesNotMatch(rendered, /AUTOMATION_BOT_MENTION/);
  assert.doesNotMatch(rendered, /VERIFY_APP_[A-Z_]+/);
});

test("generated callers honor the rendered policy automation controls", async () => {
  const bundle = await loadVerifiedAssets();
  const policy = upgradePolicy(JSON.parse(bundle.contents["policies/openai.json"]));
  policy.automation.automaticPrReview = false;
  policy.automation.reviewFeedbackTriage = false;
  policy.automation.issueTriage = false;
  policy.automation.ownerRequests = false;
  policy.automation.maintenanceSchedule = "5 4 * * 1";
  const files = renderInstallFiles(bundle, {
    modes: ["review", "maintain", "issues", "fix"],
    preset: "openai",
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    policySource: JSON.stringify(policy),
    enforceBundledDefaults: false
  });
  const contents = Object.fromEntries(files.map((file) => [file.path, file.contents]));
  const caller = contents[UNIFIED_CALLER_WORKFLOW.target];
  assert.match(caller, /auto_review: false/);
  assert.match(caller, /feedback_triage: false/);
  assert.match(caller, /auto_triage: false/);
  assert.match(caller, /owner_requests: false/);
  assert.match(caller, /cron: "5 4 \* \* 1"/);
});

test("maintenance scheduling can be disabled without removing manual dispatch or the policy cron", async () => {
  const bundle = await loadVerifiedAssets();
  const policy = JSON.parse(bundle.contents["policies/openai.json"]);
  const implicit = renderUnifiedWorkflow(bundle.contents[UNIFIED_CALLER_WORKFLOW.asset], {
    packageRelease: TEST_PACKAGE_RELEASE,
    ownerRequests: policy.automation.ownerRequests,
    modes: ["maintain"],
    policy
  });
  const explicitlyScheduled = renderUnifiedWorkflow(bundle.contents[UNIFIED_CALLER_WORKFLOW.asset], {
    packageRelease: TEST_PACKAGE_RELEASE,
    ownerRequests: policy.automation.ownerRequests,
    modes: ["maintain"],
    policy,
    maintenanceScheduled: true
  });
  assert.equal(explicitlyScheduled, implicit);

  const files = renderInstallFiles(bundle, {
    modes: ["maintain"],
    preset: "openai",
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    maintenanceScheduled: false
  });
  const contents = Object.fromEntries(files.map((file) => [file.path, file.contents]));
  const renderedPolicy = JSON.parse(contents[".github/codekeeper.json"]);
  const caller = contents[UNIFIED_CALLER_WORKFLOW.target];
  assert.equal(renderedPolicy.version, 3);
  assert.equal(renderedPolicy.automation.maintenanceSchedule, "17 7 * * *");
  assert.doesNotMatch(caller, /^  schedule:/m);
  assert.match(caller, /^  workflow_dispatch:/m);
  assert.match(implicit, /dry_run: \$\{\{ github\.event_name == 'schedule' \|\| inputs\.dry_run \}\}/);
});

test("renderInstallFiles omits packaged profiles unless an explicit repository override is provided", async () => {
  const bundle = await loadVerifiedAssets();
  const files = renderInstallFiles(bundle, {
    modes: ["review", "issues"],
    preset: "openai",
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"]
  });
  assert.deepEqual(files.map((file) => file.path), [
    ".github/codekeeper.json",
    ".github/workflows/codekeeper.yml",
    ".github/codekeeper/actions/acquire-package/action.yml",
    ".github/workflows/codekeeper-runtime.yml",
    ".github/codekeeper/README.md",
    ".github/codekeeper-release.json"
  ]);
  for (const file of files) {
    assert.equal(file.bytes, Buffer.byteLength(file.contents));
    assert.equal(file.sha256, sha256(file.contents));
    assert.ok(Object.isFrozen(file));
  }
  assert.equal(files.some((file) => file.path.startsWith(".github/codekeeper/agents/")), false);

  const override = `${bundle.contents[AGENT_PROFILES["pr-reviewer"].asset]}\nRepository override.\n`;
  const overridden = renderInstallFiles(bundle, {
    modes: ["review"],
    preset: "openai",
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    profileSources: { [AGENT_PROFILES["pr-reviewer"].target]: override }
  });
  assert.deepEqual(
    overridden.filter((file) => file.path.startsWith(".github/codekeeper/agents/")).map((file) => file.path),
    [AGENT_PROFILES["pr-reviewer"].target]
  );
  assert.equal(overridden.find((file) => file.path === AGENT_PROFILES["pr-reviewer"].target).contents, override);
});

test("mode and owner normalization is deterministic and rejects aliases, empties, and duplicates", () => {
  assert.deepEqual(normalizeModes(["fix", "review", "fix", "issues"]), ["review", "issues", "fix"]);
  assert.deepEqual(normalizeOwnerLogins([" CoryParrry ", "Acme-Bot"]), ["coryparrry", "acme-bot"]);
  assert.throws(() => normalizeModes([]), assertInstallerCode(assert, "PLAN_INVALID"));
  assert.throws(() => normalizeModes(["all"]), assertInstallerCode(assert, "PLAN_INVALID"));
  assert.throws(() => normalizeOwnerLogins(["Cory", "cory"]), assertInstallerCode(assert, "PLAN_INVALID"));
  assert.throws(() => normalizeOwnerLogins(["bad_login"]), assertInstallerCode(assert, "PLAN_INVALID"));
});

test("every non-empty mode subset has the exact mixed and OpenAI secret matrix", () => {
  for (let mask = 1; mask < (1 << MODE_IDS.length); mask += 1) {
    const modes = MODE_IDS.filter((_, index) => mask & (1 << index));
    for (const preset of ["mixed", "openai"]) {
      const expected = [];
      if (modes.some((mode) => mode !== "issues") || (modes.includes("issues") && preset === "openai")) {
        expected.push(OPENAI_SECRET);
      }
      if (modes.includes("issues") && preset === "mixed") expected.push(DEEPSEEK_SECRET);
      expected.push(TRACE_SECRET, APP_SECRET);
      assert.deepEqual(requiredSecretNames({ modes, preset }), expected, `${preset}: ${modes.join(",")}`);
    }
  }
});

test("alternative coordinators still request OpenAI for enabled workspaces", () => {
  assert.deepEqual(requiredSecretNames({
    modes: ["review"],
    models: {
      review: { provider: "openrouter", model: "anthropic/claude-sonnet", effort: "none" }
    },
    tracing: false
  }), [OPENAI_SECRET, OPENROUTER_SECRET, APP_SECRET]);
});

test("legacy policies keep deferred issue publication off until the publisher is installed", async () => {
  const bundle = await loadVerifiedAssets();
  const legacy = JSON.parse(bundle.contents["policies/openai.json"]);
  legacy.version = 2;
  delete legacy.automation;
  delete legacy.review.createDeferredIssues;
  delete legacy.ai.providers.openrouter;
  delete legacy.labels.deferred;
  delete legacy.labels["codekeeper:deferred"];
  legacy.issues.managedLabels = legacy.issues.managedLabels.filter((label) => !["deferred", "codekeeper:deferred"].includes(label));
  assert.equal(upgradePolicy(legacy).review.createDeferredIssues, false);
});

test("policy upgrades namespace Codekeeper-owned labels without erasing repository taxonomy", async () => {
  const bundle = await loadVerifiedAssets();
  const legacy = JSON.parse(bundle.contents["policies/openai.json"]);
  const upgraded = upgradePolicy(legacy);

  assert.ok(upgraded.review.managedLabels.every((label) => label.startsWith("codekeeper:")));
  assert.ok(upgraded.issues.managedLabels.every((label) => label.startsWith("codekeeper:")));
  assert.ok(upgraded.issues.managedLabels.includes("codekeeper:maintenance"));
  assert.ok(upgraded.issues.managedLabels.includes("codekeeper:type-maintenance"));
  assert.deepEqual(upgraded.labels.security, legacy.labels.security);
  assert.deepEqual(upgradePolicy(upgraded), upgraded);
});

test("existing policies gain the default high-risk review escalation", async () => {
  const bundle = await loadVerifiedAssets();
  const existing = JSON.parse(bundle.contents["policies/openai.json"]);
  delete existing.review.reasoningEscalation;
  assert.deepEqual(upgradePolicy(existing).review.reasoningEscalation, {
    enabled: true,
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "max",
    labels: ["security", "risk high"],
    pathPatterns: [
      ".github/actions/**",
      ".github/codekeeper.json",
      ".github/workflows/**",
      "SECURITY.md",
      "**/auth/**",
      "**/authentication/**",
      "**/authorization/**",
      "**/billing/**",
      "**/crypto/**",
      "**/migration/**",
      "**/migrations/**",
      "**/payments/**",
      "**/permissions/**",
      "**/release/**",
      "**/schema/**",
      "**/schemas/**",
      "**/secrets/**",
      "**/security/**",
      "**/*auth*.*",
      "**/*migration*.*",
      "**/*permission*.*"
    ],
    minimumChangedLines: 5000,
    minimumSingleFileChangedLines: 1000
  });
});

test("install plan is frozen, applies startup last, and documents selected workflows without credential values", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({ bundle, snapshot: snapshot(), answers: answers() });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.files));
  assert.ok(plan.files.every(Object.isFrozen));
  assert.deepEqual(plan.variables.slice(0, -1), [
    { name: "CODEKEEPER_APP_CLIENT_ID", value: "Iv123456789012345678" },
    { name: "CODEKEEPER_AUTOMATION_BOT_LOGIN", value: "codekeeper-acme[bot]" }
  ]);
  assert.deepEqual(plan.variables.at(-1), { name: "CODEKEEPER_ENABLED", value: "true" });
  assert.deepEqual(plan.ownerLogins, ["coryparrry", "acme-bot"]);
  assert.deepEqual(plan.capabilities, {
    reviewRepair: true,
    repair: true,
    issueImplementation: true,
    duplicateClosure: true,
    autoMerge: true
  });
  const renderedPolicy = JSON.parse(plan.files[0].contents);
  assert.equal(renderedPolicy.audit.repair.enabled, true);
  assert.equal(renderedPolicy.issues.allowAiImplementation, true);
  assert.equal(renderedPolicy.issues.closeExactDuplicates, true);
  assert.equal(renderedPolicy.merge.enabled, true);
  assert.equal(plan.originalHead, HEAD_SHA);
  assert.equal(plan.branch, "codekeeper/setup");
  assert.match(plan.pullRequest.body, /\| Document \| Purpose \|/);
  assert.match(plan.pullRequest.body, /\| Workflow \| Role \| What it does \| Trigger \| Provider and model \|/);
  assert.match(plan.pullRequest.body, /\| Pull request review \| Pull request reviewer \|/);
  assert.match(plan.pullRequest.body, /OpenAI traces are \*\*enabled\*\*/);
  assert.match(plan.pullRequest.body, /enabled after this setup pull request merges/i);
  assert.match(plan.pullRequest.body, /Packaged agent profiles are used by default/);
  assert.match(plan.pullRequest.body, /Edit a profile in Settings to create an optional `.github\/codekeeper\/agents\/\*\.md` repository override/);
  assert.match(plan.pullRequest.body, /capability switches above control which GitHub actions Codekeeper can take/);
  assert.match(plan.pullRequest.body, /live maintenance run can repair when repository repair is on/);
  assert.match(plan.pullRequest.body, /run `codekeeper verify`/i);
  assert.doesNotMatch(plan.pullRequest.body, /Run maintenance manually|controlled same-repository pull request|controlled issue event|triage marks ready|test each updated workflow/i);
  assert.doesNotMatch(plan.pullRequest.body, /CODEKEEPER_ENABLED=false/);
  assert.match(plan.pullRequest.body, /did not merge this pull request or prove a workflow/);
  assert.doesNotMatch(plan.pullRequest.body, /PRIVATE KEY|sk-[A-Za-z0-9]/i);
  assert.deepEqual(documentMap(plan.files).map((item) => item.path), plan.files.map((file) => file.path));
  assert.deepEqual(documentMap(plan.files).filter((item) => item.path.startsWith(".github/codekeeper/agents/")), []);
  assert.deepEqual(workflowMap(plan.modes).map((item) => item.mode), MODE_IDS);
  assert.equal(setupPullRequestBody(plan), plan.pullRequest.body);
});

test("recommended starter plan selects review and manual maintenance without tracing", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: RECOMMENDED_MODES,
      preset: RECOMMENDED_PRESET,
      capabilities: [],
      maintenanceScheduled: false,
      tracing: false
    })
  });
  assert.deepEqual(plan.modes, ["review", "maintain"]);
  assert.equal(plan.preset, "openai");
  assert.deepEqual(plan.files.map((file) => file.path), [
    ".github/codekeeper.json",
    ".github/workflows/codekeeper.yml",
    ".github/codekeeper/actions/acquire-package/action.yml",
    ".github/workflows/codekeeper-runtime.yml",
    ".github/codekeeper/README.md",
    ".github/codekeeper-release.json"
  ]);
  assert.deepEqual(plan.secrets.map((secret) => secret.name), ["OPENAI_API_KEY", "CODEKEEPER_APP_PRIVATE_KEY"]);
  assert.equal(plan.secrets.some((secret) => secret.name === "DEEPSEEK_API_KEY"), false);
  const policy = JSON.parse(plan.files[0].contents);
  assert.deepEqual(
    [policy.ai.agents.review.provider, policy.ai.agents.review.model, policy.ai.agents.review.effort],
    ["openai", "gpt-5.6-luna", "medium"]
  );
  assert.deepEqual(
    [policy.ai.agents.audit.provider, policy.ai.agents.audit.model, policy.ai.agents.audit.effort],
    ["openai", "gpt-5.6-sol", "high"]
  );
  assert.equal(policy.ai.tracing.enabled, false);
  assert.equal(plan.maintenanceScheduled, false);
  assert.match(plan.pullRequest.body, /Scheduled report-only maintenance is \*\*disabled;/);
});

test("editing one packaged profile materializes only that repository override", async () => {
  const bundle = await loadVerifiedAssets();
  const profiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  profiles["pr-reviewer"] += "\nRepository override: report API regressions first.\n";
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET, profiles })
  });
  const profileFiles = plan.files.filter((file) => file.path.startsWith(".github/codekeeper/agents/"));
  assert.deepEqual(profileFiles.map((file) => file.path), [AGENT_PROFILES["pr-reviewer"].target]);
  assert.equal(profileFiles[0].contents, profiles["pr-reviewer"]);
  assert.deepEqual(documentMap(profileFiles).map((item) => item.purpose), [AGENT_PROFILES["pr-reviewer"].purpose]);
});

test("a release update refreshes packaged defaults without materializing missing repository profiles", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const nextBundle = {
    ...bundle,
    metadata: {
      ...bundle.metadata,
      source: { ...bundle.metadata.source, commit: "b".repeat(40) }
    },
    contents: {
      ...bundle.contents,
      "agents/pr-reviewer.md": `${bundle.contents["agents/pr-reviewer.md"]}\nNew packaged default.\n`
    }
  };
  const existingSnapshot = {
    ...snapshot(),
    installation: {
      policy: JSON.parse(contents[".github/codekeeper.json"]),
      policySource: contents[".github/codekeeper.json"],
      modes: initial.modes,
      contents
    },
    existingSettings: {
      enabled: true,
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]"
    },
    updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
  };
  const output = { write() {} };
  const update = buildInstallPlan({
    bundle: nextBundle,
    snapshot: existingSnapshot,
    answers: buildUpdateAnswers({ snapshot: existingSnapshot, bundle: nextBundle, output })
  });
  assert.equal(update.operation, "release-update");
  assert.equal(update.source.commit, "b".repeat(40));
  assert.equal(update.files.some((file) => file.path.startsWith(".github/codekeeper/agents/")), false);
  assert.ok(update.files.some((file) => file.path === RELEASE_MANIFEST_TARGET));
  assert.equal(update.files.some((file) => file.path === UNIFIED_CALLER_WORKFLOW.target), false);
});

test("resetting an existing profile override deletes it and resumes packaged updates", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const profileId = "pr-reviewer";
  const target = AGENT_PROFILES[profileId].target;
  contents[target] = `${bundle.contents[AGENT_PROFILES[profileId].asset]}\nRepository preference.\n`;
  const existingSnapshot = {
    ...snapshot(),
    installation: {
      policy: JSON.parse(contents[".github/codekeeper.json"]),
      policySource: contents[".github/codekeeper.json"],
      modes: initial.modes,
      contents
    },
    existingSettings: {
      enabled: true,
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]"
    },
    updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
  };
  const profiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  const profileSources = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, "package"]));
  const reset = buildInstallPlan({
    bundle,
    snapshot: existingSnapshot,
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET, profiles, profileSources })
  });
  assert.deepEqual(reset.files.map((file) => file.path), [target]);
  assert.deepEqual(reset.files[0], {
    path: target,
    contents: null,
    bytes: 0,
    sha256: null,
    previousSha256: sha256(contents[target]),
    delete: true
  });

  const nextBundle = {
    ...bundle,
    metadata: {
      ...bundle.metadata,
      source: { ...bundle.metadata.source, commit: "c".repeat(40) }
    },
    contents: {
      ...bundle.contents,
      [AGENT_PROFILES[profileId].asset]: `${bundle.contents[AGENT_PROFILES[profileId].asset]}\nNext packaged default.\n`
    }
  };
  const resetContents = { ...contents };
  delete resetContents[target];
  const resetSnapshot = {
    ...existingSnapshot,
    installation: { ...existingSnapshot.installation, contents: resetContents }
  };
  const updateAnswers = buildUpdateAnswers({ snapshot: resetSnapshot, bundle: nextBundle, output: { write() {} } });
  assert.equal(updateAnswers.profileSources[profileId], "package");
  assert.match(updateAnswers.profiles[profileId], /Next packaged default/);
  const releaseUpdate = buildInstallPlan({ bundle: nextBundle, snapshot: resetSnapshot, answers: updateAnswers });
  assert.equal(releaseUpdate.files.some((file) => file.path === target), false);
});

test("normal installation enables selected workflows after the setup pull request merges", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET, enabled: true })
  });
  assert.deepEqual(plan.variables.at(-1), { name: "CODEKEEPER_ENABLED", value: "true" });
  assert.match(plan.pullRequest.body, /enabled after this setup pull request merges/i);
});

test("model choices update the selected agent and optional tracing needs no trace key", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["review"],
      preset: "openai",
      models: { review: "terra-medium" },
      tracing: false
    })
  });
  const policy = JSON.parse(plan.files.find((file) => file.path === ".github/codekeeper.json").contents);
  assert.equal(policy.ai.agents.review.model, "gpt-5.6-terra");
  assert.equal(policy.ai.agents.review.effort, "medium");
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-luna");
  assert.equal(policy.ai.agents.review.workspace.effort, "medium");
  assert.equal(policy.ai.tracing.enabled, false);
  assert.deepEqual(plan.secrets.map((secret) => secret.name), [OPENAI_SECRET, APP_SECRET]);
  assert.match(plan.pullRequest.body, /OpenAI traces are \*\*disabled\*\*/);
  assert.doesNotMatch(plan.pullRequest.body, /OPENAI_TRACE_API_KEY/);
});

test("each role can use any supported provider and model", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["review", "issues"],
      preset: "openai",
      models: { review: "deepseek-v4-flash", issues: "luna-max" },
      tracing: false
    })
  });
  const policy = JSON.parse(plan.files.find((file) => file.path === ".github/codekeeper.json").contents);
  const caller = plan.files.find((file) => file.path === UNIFIED_CALLER_WORKFLOW.target).contents;

  assert.equal(policy.ai.agents.review.provider, "deepseek");
  assert.equal(policy.ai.agents.review.model, "deepseek-v4-flash");
  assert.equal(policy.ai.agents.review.workspace.enabled, true);
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-luna");
  assert.equal(policy.ai.agents.issue.provider, "openai");
  assert.equal(policy.ai.agents.issue.model, "gpt-5.6-luna");
  assert.match(caller, /secrets\.DEEPSEEK_API_KEY/);
  assert.match(caller, /secrets\.OPENAI_API_KEY/);
  assert.deepEqual(plan.secrets.map((secret) => secret.name), [OPENAI_SECRET, DEEPSEEK_SECRET, APP_SECRET]);
});

test("arbitrary OpenRouter coordinator models preserve the OpenAI workspace specialist", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["review"],
      preset: "openai",
      models: {
        review: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
          effort: "none"
        }
      },
      tracing: false
    })
  });
  const policy = JSON.parse(plan.files.find((file) => file.path === ".github/codekeeper.json").contents);
  const workflow = plan.files.find((file) => file.path === UNIFIED_CALLER_WORKFLOW.target).contents;

  assert.deepEqual(plan.models.review, {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
    effort: "none",
    choice: null
  });
  assert.equal(policy.version, 3);
  assert.equal(policy.ai.agents.review.provider, "openrouter");
  assert.equal(policy.ai.agents.review.model, "anthropic/claude-sonnet-4.5");
  assert.equal(policy.ai.agents.review.workspace.enabled, true);
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-luna");
  assert.equal(policy.ai.providers.openrouter.api, "chat_completions");
  assert.equal(policy.ai.providers.openrouter.structuredOutputs, false);
  assert.match(workflow, /secrets\.OPENROUTER_API_KEY/);
  assert.deepEqual(plan.secrets.map((secret) => secret.name), [OPENAI_SECRET, OPENROUTER_SECRET, APP_SECRET]);
});

test("rerunning an OpenRouter coordinator with an enabled workspace does not request its existing OpenAI key", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["review"],
      preset: "openai",
      models: {
        review: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
          effort: "none"
        }
      },
      tracing: false
    })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const update = buildInstallPlan({
    bundle,
    snapshot: {
      ...snapshot(),
      installation: {
        policy: JSON.parse(contents[".github/codekeeper.json"]),
        policySource: contents[".github/codekeeper.json"],
        modes: initial.modes,
        contents
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-acme[bot]"
      },
      updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
    },
    answers: answers({
      modes: ["review"],
      preset: "openai",
      displayName: "Renamed Widget",
      models: {
        review: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
          effort: "none"
        }
      },
      tracing: false
    })
  });

  assert.deepEqual(update.secrets, []);
});

test("rerunning an OpenRouter coordinator with a disabled workspace does not request an unused OpenAI key", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["review"],
      preset: "openai",
      models: {
        review: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
          effort: "none"
        }
      },
      tracing: false
    })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const policy = JSON.parse(contents[".github/codekeeper.json"]);
  policy.ai.agents.review.workspace.enabled = false;
  contents[".github/codekeeper.json"] = `${JSON.stringify(policy, null, 2)}\n`;
  const update = buildInstallPlan({
    bundle,
    snapshot: {
      ...snapshot(),
      installation: {
        policy,
        policySource: contents[".github/codekeeper.json"],
        modes: initial.modes,
        contents
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-acme[bot]"
      },
      updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
    },
    answers: answers({
      modes: ["review"],
      preset: "openai",
      displayName: "Renamed Widget",
      models: {
        review: {
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.5",
          effort: "none"
        }
      },
      tracing: false
    })
  });

  assert.deepEqual(update.secrets, []);
});

test("fixer can use any supported model without a separate planner credential", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: ["fix"], preset: "openai", models: { fix: "sol-high" }, tracing: false, capabilities: [] })
  });
  const policy = JSON.parse(plan.files.find((file) => file.path === ".github/codekeeper.json").contents);
  const workflow = plan.files.find((file) => file.path === UNIFIED_CALLER_WORKFLOW.target).contents;
  assert.equal(policy.ai.agents.fix.model, "gpt-5.6-sol");
  assert.doesNotMatch(workflow, /planner_model_api_key/);
  assert.match(workflow, /secrets\.OPENAI_API_KEY/);
});

test("OpenAI model choices include current general and coding models and map Luna to one agent", async () => {
  assert.deepEqual(
    [...new Set(MODEL_OPTIONS.openai.map((choice) => choice.model))],
    [
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.3-codex"
    ]
  );
  assert.deepEqual(MODEL_OPTIONS.deepseek.map((choice) => choice.model), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: ["review"], preset: "openai", models: { review: "luna-max" } })
  });
  const policy = JSON.parse(plan.files[0].contents);
  assert.deepEqual(plan.models.review, {
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "max",
    choice: "luna-max"
  });
  assert.equal(policy.ai.agents.review.model, "gpt-5.6-luna");
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-luna");
});

test("a rerun creates a configuration-only update and preserves edited profiles", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  contents[".github/codekeeper/agents/pr-reviewer.md"] = `${bundle.contents["agents/pr-reviewer.md"]}\nRepository preference: report API regressions first.\n`;
  const existingSnapshot = {
    ...snapshot(),
    installation: {
      policy: JSON.parse(contents[".github/codekeeper.json"]),
      policySource: contents[".github/codekeeper.json"],
      modes: initial.modes,
      contents
    },
    existingSettings: {
      enabled: true,
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]"
    },
    updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
  };
  const update = buildInstallPlan({
    bundle,
    snapshot: existingSnapshot,
    answers: answers({
      modes: RECOMMENDED_MODES,
      preset: RECOMMENDED_PRESET,
      models: { review: "luna-max", maintain: "sol-high" }
    })
  });
  assert.equal(update.update, true);
  assert.equal(update.branch, `codekeeper/update-${HEAD_SHA.slice(0, 12)}`);
  assert.deepEqual(update.variables, []);
  assert.deepEqual(update.secrets, []);
  assert.deepEqual(update.files.map((file) => file.path), [".github/codekeeper.json"]);
  assert.match(contents[".github/codekeeper/agents/pr-reviewer.md"], /Repository preference/);
  assert.equal(update.pullRequest.title, "chore(codekeeper): update configuration");
  assert.match(update.pullRequest.body, /enabled now with the current default-branch configuration/i);
  assert.match(update.pullRequest.body, /keeps running the current default-branch configuration/i);
  assert.match(update.pullRequest.body, /run `codekeeper verify`/i);
  assert.doesNotMatch(update.pullRequest.body, /Required (?:variables|secrets):/);
  assert.match(completionGuidance(update.modes, update.enabled, update.update).heading, /keeps running the current default-branch configuration/i);

  const providerUpdate = buildInstallPlan({
    bundle,
    snapshot: existingSnapshot,
    answers: answers({
      modes: RECOMMENDED_MODES,
      preset: RECOMMENDED_PRESET,
      models: { review: "deepseek-v4-flash", maintain: "sol-high" }
    })
  });
  assert.deepEqual(providerUpdate.secrets, [{
    name: DEEPSEEK_SECRET,
    purpose: "DeepSeek API key for each role assigned to DeepSeek. Used by: Pull request reviewer."
  }]);
  assert.deepEqual(providerUpdate.files.map((file) => file.path), [".github/codekeeper.json"]);
  assert.match(contents[UNIFIED_CALLER_WORKFLOW.target], /secrets\.DEEPSEEK_API_KEY/);

  const disabled = buildInstallPlan({
    bundle,
    snapshot: existingSnapshot,
    answers: answers({
      modes: RECOMMENDED_MODES,
      preset: RECOMMENDED_PRESET,
      enabled: false
    })
  });
  assert.equal(disabled.settingsOnly, true);
  assert.deepEqual(disabled.files, []);
  assert.deepEqual(disabled.variables, [{ name: "CODEKEEPER_ENABLED", value: "false" }]);
});

test("a release update removes retired generated workflows recorded by the installed release", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: ["review"], preset: "openai" })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  const retiredTarget = ".github/workflows/codekeeper-fix.yml";
  contents[retiredTarget] = "legacy retired workflow\n";
  const installedRelease = JSON.parse(contents[RELEASE_MANIFEST_TARGET]);
  installedRelease.managedFiles[retiredTarget] = sha256(contents[retiredTarget]);
  contents[RELEASE_MANIFEST_TARGET] = `${JSON.stringify(installedRelease, null, 2)}\n`;
  const releaseUpdate = buildInstallPlan({
    bundle,
    snapshot: {
      ...snapshot(),
      installation: {
        policy: JSON.parse(contents[".github/codekeeper.json"]),
        policySource: contents[".github/codekeeper.json"],
        modes: ["review"],
        contents,
        releaseManifest: installedRelease
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-acme[bot]"
      },
      updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
    },
    answers: { ...answers({ modes: ["review"], preset: "openai" }), releaseUpdate: true }
  });
  assert.equal(releaseUpdate.operation, "release-update");
  assert.deepEqual(releaseUpdate.files.map((file) => file.path), [RELEASE_MANIFEST_TARGET, retiredTarget]);
  assert.equal(releaseUpdate.files[1].delete, true);
  assert.equal(releaseUpdate.files[1].previousSha256, sha256(contents[retiredTarget]));
});

test("optional disabled installation keeps Codekeeper off after merge", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({ bundle, snapshot: snapshot(), answers: answers({ enabled: false }) });
  assert.deepEqual(plan.variables.at(-1), { name: "CODEKEEPER_ENABLED", value: "false" });
  assert.match(plan.pullRequest.body, /Codekeeper stays off/);
  assert.match(plan.pullRequest.body, /CODEKEEPER_ENABLED=false/);
});

test("cleared capability choices remain off in the generated policy", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({ bundle, snapshot: snapshot(), answers: answers({ capabilities: [] }) });
  const policy = JSON.parse(plan.files[0].contents);
  assert.deepEqual(plan.capabilities, {
    reviewRepair: false,
    repair: false,
    issueImplementation: false,
    duplicateClosure: false,
    autoMerge: false
  });
  assert.equal(policy.audit.repair.enabled, false);
  assert.equal(policy.issues.allowAiImplementation, false);
  assert.equal(policy.issues.closeExactDuplicates, false);
  assert.equal(policy.merge.enabled, false);
});

test("fix-only issue implementation configures the trusted App bot identity", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["issues", "fix"],
      capabilities: ["issueImplementation"]
    })
  });
  assert.deepEqual(
    plan.variables.find((variable) => variable.name === "CODEKEEPER_AUTOMATION_BOT_LOGIN"),
    { name: "CODEKEEPER_AUTOMATION_BOT_LOGIN", value: "codekeeper-acme[bot]" }
  );
  const caller = plan.files.find((file) => file.path === UNIFIED_CALLER_WORKFLOW.target).contents;
  assert.match(caller, /contains\(github\.event\.comment\.body, '@codekeeper-acme'\)/);
  assert.doesNotMatch(caller, /AUTOMATION_BOT_MENTION/);
  assert.throws(
    () => buildInstallPlan({
      bundle,
      snapshot: snapshot(),
      answers: answers({
        modes: ["issues", "fix"],
        capabilities: ["issueImplementation"],
        automationBotLogin: null
      })
    }),
    assertInstallerCode(assert, "PLAN_INVALID")
  );
});

test("owner requests require the trusted App bot identity for every workflow selection", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["issues"],
      capabilities: [],
      models: { issues: "terra-medium" }
    })
  });
  assert.deepEqual(
    plan.variables.find((variable) => variable.name === "CODEKEEPER_AUTOMATION_BOT_LOGIN"),
    { name: "CODEKEEPER_AUTOMATION_BOT_LOGIN", value: "codekeeper-acme[bot]" }
  );
  assert.throws(
    () => buildInstallPlan({
      bundle,
      snapshot: snapshot(),
      answers: answers({
        modes: ["issues"],
        capabilities: [],
        models: { issues: "terra-medium" },
        automationBotLogin: null
      })
    }),
    assertInstallerCode(assert, "PLAN_INVALID")
  );
});

test("plain-prompt updates validate tracing after applying the tracing answer", async () => {
  const bundle = await loadVerifiedAssets();
  const installedPolicy = JSON.parse(bundle.contents["policies/openai.json"]);
  installedPolicy.ai.tracing.includeSensitiveData = true;
  const installation = {
    policy: installedPolicy,
    policySource: JSON.stringify(installedPolicy),
    modes: ["review"],
    contents: {}
  };
  assert.throws(
    () => buildInstallPlan({
      bundle,
      snapshot: {
        ...snapshot(),
        installation,
        existingSettings: {
          enabled: true,
          appClientId: "Iv123456789012345678",
          automationBotLogin: "codekeeper-acme[bot]"
        }
      },
      answers: answers({
        modes: ["review"],
        preset: "openai",
        tracing: false,
        capabilities: []
      })
    }),
    assertInstallerCode(assert, "SETTING_INVALID")
  );
});

test("plain-prompt updates derive the bot-login requirement from the effective policy", async () => {
  const bundle = await loadVerifiedAssets();
  const installedPolicy = JSON.parse(bundle.contents["policies/openai.json"]);
  installedPolicy.automation.ownerRequests = false;
  const plan = buildInstallPlan({
    bundle,
    snapshot: {
      ...snapshot(),
      installation: {
        policy: installedPolicy,
        policySource: JSON.stringify(installedPolicy),
        modes: ["issues"],
        contents: {}
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: null
      }
    },
    answers: answers({
      modes: ["issues"],
      preset: "openai",
      models: { issues: "terra-medium" },
      automationBotLogin: null,
      capabilities: []
    })
  });
  assert.equal(plan.policy.automation.ownerRequests, false);
  assert.equal(plan.variables.some((variable) => variable.name === "CODEKEEPER_AUTOMATION_BOT_LOGIN"), false);
});

test("plain-prompt updates validate capabilities after rendering the selected workflows", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({
      modes: ["review", "fix"],
      capabilities: ["reviewRepair"]
    })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  assert.equal(JSON.parse(contents[".github/codekeeper.json"]).review.autoRepair, true);

  const update = buildInstallPlan({
    bundle,
    snapshot: {
      ...snapshot(),
      installation: {
        policy: JSON.parse(contents[".github/codekeeper.json"]),
        policySource: contents[".github/codekeeper.json"],
        modes: initial.modes,
        contents
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-acme[bot]"
      },
      updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`
    },
    answers: answers({
      modes: ["review"],
      capabilities: []
    })
  });

  assert.equal(update.policy.review.autoRepair, false);
  assert.equal(update.files.some((file) => file.path === UNIFIED_CALLER_WORKFLOW.target && file.delete), false);
  assert.equal(update.files.some((file) => file.path === UNIFIED_CALLER_WORKFLOW.target), true);
});

test("GitHub App registration URL is private, webhook-free, repository-owned, and permission-bounded", () => {
  const url = new URL(appRegistrationUrl({
    repository: "Acme/Widget",
    displayName: "Widget App",
    ownerType: "User"
  }).split("#")[0]);
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/settings/apps/new");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    name: "Codekeeper Widget App",
    description: "Codekeeper automation for Acme/Widget",
    url: "https://github.com/Acme/Widget",
    public: "false",
    webhook_active: "false",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read"
  });
  const longNameUrl = new URL(appRegistrationUrl({
    repository: "Acme/Widget",
    displayName: "A very long repository display name that must be bounded",
    ownerType: "User"
  }).split("#")[0]);
  assert.equal(longNameUrl.searchParams.get("name").length, 34);

  const organizationUrl = new URL(appRegistrationUrl({
    repository: "Acme/Widget",
    displayName: "Widget App",
    ownerType: "Organization"
  }).split("#")[0]);
  assert.equal(organizationUrl.pathname, "/organizations/Acme/settings/apps/new");
  assert.throws(
    () => appRegistrationUrl({ repository: "Acme/Widget", displayName: "Widget App", ownerType: "Bot" }),
    assertInstallerCode(assert, "PLAN_INVALID")
  );

  assert.deepEqual(appPermissions({ modes: ["review"], capabilities: [] }), {
    contents: "write",
    issues: "write",
    pullRequests: "write",
    metadata: "read"
  });
  const reviewUrl = new URL(appRegistrationUrl({
    repository: "Acme/Widget",
    displayName: "Widget App",
    ownerType: "User",
    modes: ["review"],
    capabilities: [],
    ownerRequests: true
  }).split("#")[0]);
  assert.equal(reviewUrl.searchParams.get("contents"), "write");
  assert.equal(reviewUrl.searchParams.get("pull_requests"), "write");
  const reviewWithoutOwnerRequests = new URL(appRegistrationUrl({
    repository: "Acme/Widget",
    displayName: "Widget App",
    ownerType: "User",
    modes: ["review"],
    capabilities: [],
    ownerRequests: false
  }).split("#")[0]);
  assert.equal(reviewWithoutOwnerRequests.searchParams.get("contents"), "read");
  assert.equal(appPermissions({ modes: ["issues"], capabilities: [], ownerRequests: false }).pullRequests, "read");
  assert.equal(appPermissions({ modes: ["fix"], capabilities: [] }).contents, "write");
  assert.equal(appPermissions({ modes: ["fix"], capabilities: [] }).pullRequests, "write");
  assert.equal(appPermissions({ modes: ["maintain"], capabilities: ["repair"] }).contents, "write");
});

test("GitHub App client IDs accept the documented dotted form and reject whitespace or controls", async () => {
  const bundle = await loadVerifiedAssets();
  assert.doesNotThrow(() => buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ appClientId: "Iv1.ab1112223334445c" })
  }));
  for (const appClientId of ["Iv1.ab1112223334445c ", " Iv1.ab1112223334445c", "Iv1.ab1112223334445c\n", "Iv1.ab1112223334445c\u0000", "Iv1.ab1112223334445c-unsafe"]) {
    assert.throws(
      () => buildInstallPlan({ bundle, snapshot: snapshot(), answers: answers({ appClientId }) }),
      assertInstallerCode(assert, "PLAN_INVALID")
    );
  }
});
