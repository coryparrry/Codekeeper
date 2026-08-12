import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadVerifiedAssets,
  renderInstallFiles,
  renderPolicy,
  renderWorkflow,
  sha256
} from "../src/assets.mjs";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  APP_SECRET,
  ASSET_KEYS,
  DEEPSEEK_SECRET,
  MODE_IDS,
  MODEL_OPTIONS,
  MODES,
  OPENAI_SECRET,
  OPENROUTER_SECRET,
  RECOMMENDED_MODES,
  RECOMMENDED_PRESET,
  SOURCE_COMMIT,
  SOURCE_REPOSITORY,
  TRACE_SECRET
} from "../src/constants.mjs";
import {
  appRegistrationUrl,
  buildInstallPlan,
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
  PACKAGE_ROOT,
  PINNED_COMMIT,
  REPOSITORY_ROOT
} from "./helpers.mjs";

const EXPECTED_ASSETS = Object.freeze({
  "agents/fixer.md": "6770753275c0df9a6546cfe0453b82e6bae985819ddb57998eeb94b14c6ae38a",
  "agents/issue-triager.md": "387961b2138ef227f268efcb80afc254af24a3d91fdbda31bf359d7fe645705c",
  "agents/pr-reviewer.md": "2432af8cca474962d50a764af894639716ad5ae1076bc60ae811d34e4e2a4a1f",
  "agents/repository-auditor.md": "6aade309d79b96e507e286a29ebd168a9d84f9e2afaaacbf594e99ffe5997208",
  "policies/mixed.json": "c53612a50a6af7b3f6f00171160d333fc4ddefdcd7dbed1d925def56c53f94d7",
  "policies/openai.json": "9c7c5665d8471f474b83380b71cbc3cc528308258029dfbcc8d3786462283501",
  "workflows/assistant.yml": "58d92290268aca6fc25eb3ead3e12b969d4926e2ab371b2009caf2fbb47cbd66",
  "workflows/fix.yml": "72c50767a21b45213b250d40b191548da68675442a61ceeb6ac5f9eeea7edc1d",
  "workflows/issues.yml": "1d3d5f452a94ecf14533dbb4d80cd64134e4d30959897963a4e9e2b6add058f8",
  "workflows/maintain.yml": "a8c150416ff8f98b90994f7f32a708371be991d42ec095cf77a74765c2bddb31",
  "workflows/review.yml": "367b0af80030c0d3dd4d0f8bedfb54d958f10f072b0e72605616314a05185d0a"
});

const CHECKPOINT_PATHS = Object.freeze({
  "agents/fixer.md": "tools/codekeeper/agents/fixer.md",
  "agents/issue-triager.md": "tools/codekeeper/agents/issue-triager.md",
  "agents/pr-reviewer.md": "tools/codekeeper/agents/pr-reviewer.md",
  "agents/repository-auditor.md": "tools/codekeeper/agents/repository-auditor.md",
  "policies/mixed.json": ".github/codekeeper.json",
  "workflows/assistant.yml": "examples/workflows/codekeeper-assistant.yml.example",
  "workflows/fix.yml": "examples/workflows/codekeeper-fix.yml.example",
  "workflows/issues.yml": "examples/workflows/codekeeper-issues.yml.example",
  "workflows/maintain.yml": "examples/workflows/codekeeper-maintain.yml.example",
  "workflows/review.yml": "examples/workflows/codekeeper-review.yml.example"
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
    viewerLogin: "coryparrry"
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

test("the bundled assets have immutable release inventory, provenance, byte counts, and digests", async () => {
  const bundle = await loadVerifiedAssets();
  assert.equal(bundle.metadata.source.repository, SOURCE_REPOSITORY);
  assert.equal(bundle.metadata.source.commit, SOURCE_COMMIT);
  assert.equal(SOURCE_COMMIT, PINNED_COMMIT);
  assert.deepEqual(Object.keys(bundle.metadata.assets).sort(), ASSET_KEYS);
  assert.deepEqual(Object.keys(bundle.contents).sort(), ASSET_KEYS);
  assert.deepEqual(
    Object.fromEntries(Object.entries(bundle.metadata.assets).map(([key, value]) => [key, value.sha256])),
    EXPECTED_ASSETS
  );
  for (const key of ASSET_KEYS) {
    const contents = bundle.contents[key];
    assert.equal(Buffer.byteLength(contents), bundle.metadata.assets[key].bytes, key);
    assert.equal(sha256(contents), EXPECTED_ASSETS[key], key);
  }
  assert.ok(Object.isFrozen(bundle));
  assert.ok(Object.isFrozen(bundle.metadata.assets));
});

test("checkpoint-backed assets are byte-for-byte source release files", async () => {
  const bundle = await loadVerifiedAssets();
  for (const [asset, sourcePath] of Object.entries(CHECKPOINT_PATHS)) {
    const source = execFileSync("git", ["show", `${PINNED_COMMIT}:${sourcePath}`], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8"
    });
    assert.equal(bundle.contents[asset], source, `${asset} differs from ${sourcePath} at the pinned checkpoint`);
  }
});

test("the pinned runtime accepts the policy version emitted by this installer", async () => {
  const bundle = await loadVerifiedAssets();
  const emittedVersion = JSON.parse(renderPolicy(bundle.contents["policies/openai.json"], {
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"]
  })).version;
  const pinnedConfig = execFileSync("git", ["show", `${SOURCE_COMMIT}:tools/codekeeper/src/lib/config.mjs`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8"
  });
  assert.equal(emittedVersion, 3);
  assert.match(pinnedConfig, /config\.version === 3/);
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

test("bundled starter profiles are byte-for-byte canonical current-branch profiles", async () => {
  const bundle = await loadVerifiedAssets();
  for (const profile of AGENT_PROFILE_IDS) {
    const definition = AGENT_PROFILES[profile];
    const canonical = await readFile(path.join(REPOSITORY_ROOT, "tools", "codekeeper", "agents", `${profile}.md`), "utf8");
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
  extra.assets["workflows/extra.yml"] = extra.assets["workflows/review.yml"];
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

  const reviewPath = path.join(PACKAGE_ROOT, "assets", "workflows", "review.yml");
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
    assert.equal(rendered.merge.enabled, false);
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
  for (const mode of MODE_IDS) {
    const rendered = renderWorkflow(bundle.contents[MODES[mode].asset], {
      sourceRepository: SOURCE_REPOSITORY,
      sourceCommit: SOURCE_COMMIT,
      mode,
      preset: "openai"
    });
    assert.doesNotMatch(rendered, /gpt-5\.6-(?:sol|terra|luna)/);
  }
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
  const bundledPolicy = JSON.parse(bundle.contents["policies/openai.json"]);
  const previous = structuredClone(bundledPolicy);
  delete previous.labels["codekeeper:paused"];
  delete previous.labels["codekeeper:auto-repaired"];
  previous.labels["codekeeper:ready"].description = "Repository-specific ready label";
  const rendered = JSON.parse(renderPolicy(JSON.stringify(previous), {
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"],
    enforceBundledDefaults: false,
    requiredPolicySource: bundle.contents["policies/openai.json"]
  }));
  assert.equal(rendered.labels["codekeeper:ready"].description, "Repository-specific ready label");
  assert.deepEqual(rendered.labels["codekeeper:paused"], bundledPolicy.labels["codekeeper:paused"]);
  assert.deepEqual(rendered.labels["codekeeper:auto-repaired"], bundledPolicy.labels["codekeeper:auto-repaired"]);
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
  assert.equal(openaiIssue.workspace.enabled, false);
  assert.equal(openaiIssue.workspace.allowWrites, false);
  assert.deepEqual(openaiIssue.workspace, mixedIssue.workspace);
});

test("each rendered workflow contains exactly the paired immutable bootstrap and reusable-workflow pins", async () => {
  const bundle = await loadVerifiedAssets();
  for (const preset of ["mixed", "openai"]) {
    for (const mode of MODE_IDS) {
      const rendered = renderWorkflow(bundle.contents[MODES[mode].asset], {
        sourceRepository: SOURCE_REPOSITORY,
        sourceCommit: SOURCE_COMMIT,
        mode,
        preset
      });
      const uses = rendered.split("\n").map((line) => line.trim()).filter((line) => /^(?:- )?uses:/.test(line));
      assert.equal(uses.length, 2, `${preset}/${mode}`);
      assert.ok(uses.every((line) => line.endsWith(`@${SOURCE_COMMIT}`)), `${preset}/${mode}`);
      assert.match(rendered, new RegExp(`tools/codekeeper@${SOURCE_COMMIT}`));
      assert.match(rendered, new RegExp(`${path.basename(MODES[mode].target).replace(".", "\\.")}@${SOURCE_COMMIT}`));
      assert.doesNotMatch(rendered, /OWNER\/REPOSITORY|FULL_COMMIT_SHA|replace OWNER/);
    }
  }
  const mixedIssue = renderWorkflow(bundle.contents[MODES.issues.asset], {
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: SOURCE_COMMIT,
    mode: "issues",
    preset: "mixed"
  });
  const openaiIssue = renderWorkflow(bundle.contents[MODES.issues.asset], {
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: SOURCE_COMMIT,
    mode: "issues",
    preset: "openai"
  });
  assert.match(mixedIssue, /secrets\.DEEPSEEK_API_KEY/);
  assert.doesNotMatch(mixedIssue, /model_api_key: \$\{\{ secrets\.OPENAI_API_KEY/);
  assert.match(openaiIssue, /model_api_key: \$\{\{ secrets\.OPENAI_API_KEY/);
  assert.doesNotMatch(openaiIssue, /secrets\.DEEPSEEK_API_KEY/);
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
  assert.match(contents[MODES.review.target], /auto_review: false/);
  assert.match(contents[MODES.review.target], /feedback_triage: false/);
  assert.match(contents[MODES.issues.target], /auto_triage: false/);
  assert.doesNotMatch(contents[MODES.issues.target], /owner_requests:/);
  assert.doesNotMatch(contents[MODES.fix.target], /owner_requests:/);
  assert.match(contents[".github/workflows/codekeeper-assistant.yml"], /owner_requests: false/);
  assert.match(contents[MODES.maintain.target], /cron: "5 4 \* \* 1"/);
});

test("renderInstallFiles emits policy, every profile, and only selected callers with verified output digests", async () => {
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
    ".github/codekeeper/agents/pr-reviewer.md",
    ".github/codekeeper/agents/repository-auditor.md",
    ".github/codekeeper/agents/issue-triager.md",
    ".github/codekeeper/agents/fixer.md",
    ".github/workflows/codekeeper-assistant.yml",
    ".github/workflows/codekeeper-review.yml",
    ".github/workflows/codekeeper-issues.yml"
  ]);
  for (const file of files) {
    assert.equal(file.bytes, Buffer.byteLength(file.contents));
    assert.equal(file.sha256, sha256(file.contents));
    assert.ok(Object.isFrozen(file));
  }
  for (const profile of AGENT_PROFILE_IDS) {
    const definition = AGENT_PROFILES[profile];
    assert.equal(files.find((file) => file.path === definition.target).contents, bundle.contents[definition.asset]);
  }
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
  delete legacy.labels["codekeeper:deferred"];
  legacy.issues.managedLabels = legacy.issues.managedLabels.filter((label) => label !== "codekeeper:deferred");
  assert.equal(upgradePolicy(legacy).review.createDeferredIssues, false);
});

test("install plan is frozen, applies startup first, and documents selected workflows without credential values", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({ bundle, snapshot: snapshot(), answers: answers() });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.files));
  assert.ok(plan.files.every(Object.isFrozen));
  assert.deepEqual(plan.variables[0], { name: "CODEKEEPER_ENABLED", value: "true" });
  assert.deepEqual(plan.variables.slice(1), [
    { name: "CODEKEEPER_APP_CLIENT_ID", value: "Iv123456789012345678" },
    { name: "CODEKEEPER_AUTOMATION_BOT_LOGIN", value: "codekeeper-acme[bot]" }
  ]);
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
  assert.match(plan.pullRequest.body, /Edit `.github\/codekeeper\/agents\/\*\.md` to tune priorities, work selection, implementation approach/);
  assert.match(plan.pullRequest.body, /capability switches above control which GitHub actions Codekeeper can take/);
  assert.match(plan.pullRequest.body, /live maintenance run can repair when repository repair is on/);
  assert.doesNotMatch(plan.pullRequest.body, /CODEKEEPER_ENABLED=false/);
  assert.match(plan.pullRequest.body, /did not merge this pull request or run a workflow/);
  assert.doesNotMatch(plan.pullRequest.body, /PRIVATE KEY|sk-[A-Za-z0-9]/i);
  assert.deepEqual(documentMap(plan.files).map((item) => item.path), plan.files.map((file) => file.path));
  assert.deepEqual(
    documentMap(plan.files).filter((item) => item.path.startsWith(".github/codekeeper/agents/")).map((item) => item.purpose),
    AGENT_PROFILE_IDS.map((profile) => AGENT_PROFILES[profile].purpose)
  );
  assert.deepEqual(workflowMap(plan.modes).map((item) => item.mode), MODE_IDS);
  assert.equal(setupPullRequestBody(plan), plan.pullRequest.body);
});

test("recommended starter plan selects review and maintenance with separate OpenAI model and trace keys", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET })
  });
  assert.deepEqual(plan.modes, ["review", "maintain"]);
  assert.equal(plan.preset, "openai");
  assert.deepEqual(plan.files.map((file) => file.path), [
    ".github/codekeeper.json",
    ".github/codekeeper/agents/pr-reviewer.md",
    ".github/codekeeper/agents/repository-auditor.md",
    ".github/codekeeper/agents/issue-triager.md",
    ".github/codekeeper/agents/fixer.md",
    ".github/workflows/codekeeper-assistant.yml",
    ".github/workflows/codekeeper-review.yml",
    ".github/workflows/codekeeper-maintain.yml"
  ]);
  assert.deepEqual(plan.secrets.map((secret) => secret.name), [
    "OPENAI_API_KEY",
    "OPENAI_TRACE_API_KEY",
    "CODEKEEPER_APP_PRIVATE_KEY"
  ]);
  assert.equal(plan.secrets.some((secret) => secret.name === "DEEPSEEK_API_KEY"), false);
  const policy = JSON.parse(plan.files[0].contents);
  assert.deepEqual(
    [policy.ai.agents.review.provider, policy.ai.agents.review.model, policy.ai.agents.review.effort],
    ["openai", "gpt-5.6-sol", "high"]
  );
  assert.deepEqual(
    [policy.ai.agents.audit.provider, policy.ai.agents.audit.model, policy.ai.agents.audit.effort],
    ["openai", "gpt-5.6-sol", "high"]
  );
});

test("normal installation enables selected workflows after the setup pull request merges", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET, enabled: true })
  });
  assert.deepEqual(plan.variables[0], { name: "CODEKEEPER_ENABLED", value: "true" });
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
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-sol");
  assert.equal(policy.ai.agents.review.workspace.effort, "high");
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
  const reviewWorkflow = plan.files.find((file) => file.path === MODES.review.target).contents;
  const issueWorkflow = plan.files.find((file) => file.path === MODES.issues.target).contents;

  assert.equal(policy.ai.agents.review.provider, "deepseek");
  assert.equal(policy.ai.agents.review.model, "deepseek-v4-flash");
  assert.equal(policy.ai.agents.review.workspace.enabled, true);
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-sol");
  assert.equal(policy.ai.agents.issue.provider, "openai");
  assert.equal(policy.ai.agents.issue.model, "gpt-5.6-luna");
  assert.match(reviewWorkflow, /secrets\.DEEPSEEK_API_KEY/);
  assert.match(issueWorkflow, /secrets\.OPENAI_API_KEY/);
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
  const workflow = plan.files.find((file) => file.path === MODES.review.target).contents;

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
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-sol");
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
    answers: answers({ modes: ["fix"], preset: "openai", models: { fix: "sol-high" }, tracing: false })
  });
  const policy = JSON.parse(plan.files.find((file) => file.path === ".github/codekeeper.json").contents);
  const workflow = plan.files.find((file) => file.path === MODES.fix.target).contents;
  assert.equal(policy.ai.agents.fix.model, "gpt-5.6-sol");
  assert.doesNotMatch(workflow, /planner_model_api_key/);
  assert.match(workflow, /model_api_key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
});

test("OpenAI model choices include Luna, Terra, and Sol and map Luna to one agent", async () => {
  assert.deepEqual(
    [...new Set(MODEL_OPTIONS.openai.map((choice) => choice.model))],
    ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]
  );
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
  assert.equal(policy.ai.agents.review.workspace.model, "gpt-5.6-sol");
});

test("a rerun creates a configuration-only update and preserves edited profiles", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers({ modes: RECOMMENDED_MODES, preset: RECOMMENDED_PRESET })
  });
  const contents = Object.fromEntries(initial.files.map((file) => [file.path, file.contents]));
  contents[".github/codekeeper/agents/pr-reviewer.md"] += "\nRepository preference: report API regressions first.\n";
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
  assert.match(update.pullRequest.body, /continues running the current default-branch configuration now/i);
  assert.match(completionGuidance(update.modes, update.enabled, update.update).heading, /running now with the current default-branch configuration/i);

  const providerUpdate = buildInstallPlan({
    bundle,
    snapshot: existingSnapshot,
    answers: answers({
      modes: RECOMMENDED_MODES,
      preset: RECOMMENDED_PRESET,
      models: { review: "deepseek-v4-flash", maintain: "sol-high" }
    })
  });
  assert.deepEqual(providerUpdate.secrets, [{ name: DEEPSEEK_SECRET }]);
  assert.deepEqual(providerUpdate.files.map((file) => file.path), [
    ".github/codekeeper.json",
    ".github/workflows/codekeeper-review.yml"
  ]);
  assert.match(providerUpdate.files[1].contents, /secrets\.DEEPSEEK_API_KEY/);

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

test("optional disabled installation keeps Codekeeper off after merge", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({ bundle, snapshot: snapshot(), answers: answers({ enabled: false }) });
  assert.deepEqual(plan.variables[0], { name: "CODEKEEPER_ENABLED", value: "false" });
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
