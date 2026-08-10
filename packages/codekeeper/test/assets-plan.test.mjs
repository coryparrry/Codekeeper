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
  MODES,
  OPENAI_SECRET,
  RECOMMENDED_MODES,
  RECOMMENDED_PRESET,
  SOURCE_COMMIT,
  SOURCE_REPOSITORY,
  TRACE_SECRET
} from "../src/constants.mjs";
import {
  appRegistrationUrl,
  buildInstallPlan,
  documentMap,
  normalizeModes,
  normalizeOwnerLogins,
  requiredSecretNames,
  setupPullRequestBody,
  workflowMap
} from "../src/plan.mjs";
import {
  assertInstallerCode,
  HEAD_SHA,
  PACKAGE_ROOT,
  PINNED_COMMIT,
  REPOSITORY_ROOT
} from "./helpers.mjs";

const EXPECTED_ASSETS = Object.freeze({
  "agents/issue-triager.md": "866e45a5431d9e08fe036d47d3334106f0e0734dfeef0421bd5465a1f472b5d2",
  "agents/maintenance-planner.md": "8ff0abe5c7b232b595f6e4f43c947314e7d0cce5c15d1b7cd0884f7526e17479",
  "agents/pr-reviewer.md": "9b90b3ae1d2ac501924b0a38d4a559c8fb8e7e84ab309a41fc5b33739a40ce76",
  "agents/repository-auditor.md": "82af520eee898bb55136d448116cf68308645c714f9626c0b099850a2e94b7ff",
  "policies/mixed.json": "37e32105ba2300e465af8132b241633833130394eb5c15a300c0a6bf1c1f589d",
  "policies/openai.json": "753741a11159d48a9c6bd7d938edd3310b1e9d0d242e86098715db0e499faad0",
  "workflows/fix.yml": "60e142109c0ff184d61ba1c149a96b134a038c5d3f41edb4c67876e6a7e6d5fc",
  "workflows/issues.yml": "3260d387b1ae7f76e21fdd0228062e139be3a25f047bfbd5762f638b67e153ca",
  "workflows/maintain.yml": "1df21ec555e467813a086ef6c63a30fe1edfcf93389e4147f607b51d0a40082a",
  "workflows/review.yml": "b77995d237b98fa02f79ea3bcd3363e63a38cd4580de126e1e64fab18c683730"
});

const CHECKPOINT_PATHS = Object.freeze({
  "agents/issue-triager.md": "tools/codekeeper/agents/issue-triager.md",
  "agents/maintenance-planner.md": "tools/codekeeper/agents/maintenance-planner.md",
  "agents/pr-reviewer.md": "tools/codekeeper/agents/pr-reviewer.md",
  "agents/repository-auditor.md": "tools/codekeeper/agents/repository-auditor.md",
  "policies/mixed.json": ".github/codekeeper.json",
  "workflows/fix.yml": "examples/workflows/codekeeper-fix.yml.example",
  "workflows/issues.yml": "examples/workflows/codekeeper-issues.yml.example",
  "workflows/maintain.yml": "examples/workflows/codekeeper-maintain.yml.example",
  "workflows/review.yml": "examples/workflows/codekeeper-review.yml.example"
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
      ...(value.modes.includes("maintain") ? ["repair"] : []),
      ...(value.modes.includes("fix") ? ["issueImplementation"] : []),
      ...(value.modes.includes("issues") ? ["duplicateClosure"] : []),
      ...(value.modes.some((mode) => mode === "maintain" || mode === "fix") ? ["autoMerge"] : [])
    ];
  }
  return value;
}

test("the ten bundled assets have immutable release inventory, provenance, byte counts, and digests", async () => {
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

test("bundled starter profiles are byte-for-byte canonical current-branch profiles", async () => {
  const bundle = await loadVerifiedAssets();
  for (const profile of AGENT_PROFILE_IDS) {
    const definition = AGENT_PROFILES[profile];
    const canonical = await readFile(path.join(REPOSITORY_ROOT, "tools", "codekeeper", "agents", `${profile}.md`), "utf8");
    assert.equal(bundle.contents[definition.asset], canonical, definition.target);
  }
});

test("bundled starter profiles preserve the deterministic mutation boundary", async () => {
  const { contents } = await loadVerifiedAssets();
  assert.match(contents["agents/repository-auditor.md"], /report-only unless the frozen trusted context explicitly records/);
  assert.match(contents["agents/issue-triager.md"], /Triage never starts or authorizes implementation/);
  assert.match(contents["agents/issue-triager.md"], /exact `\/codekeeper fix` command from a configured owner/);
  assert.match(contents["agents/maintenance-planner.md"], /exact open same-repository pull request's frozen head branch/);
  assert.match(contents["agents/maintenance-planner.md"], /Never propose a sibling branch, a replacement or follow-up pull request/);
  assert.match(contents["agents/pr-reviewer.md"], /Review is not repair authorization/);
  assert.match(contents["agents/pr-reviewer.md"], /it must never open a second pull request/);
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
    assert.deepEqual(rendered.ai, original.ai);
  }
});

test("model selection is a policy-only edit and does not require workflow rewriting", async () => {
  const bundle = await loadVerifiedAssets();
  const custom = JSON.parse(bundle.contents["policies/openai.json"]);
  custom.ai.agents.review.model = "gpt-5.6-luna";
  custom.ai.agents.review.workspace.model = "gpt-5.6-luna";
  const renderedPolicy = JSON.parse(renderPolicy(JSON.stringify(custom), {
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["coryparrry"]
  }));
  assert.equal(renderedPolicy.ai.agents.review.model, "gpt-5.6-luna");
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
  assert.equal(openaiIssue.workspace.model, "gpt-5.6-terra");
  assert.equal(openaiIssue.workspace.effort, "medium");
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
    ".github/codekeeper/agents/maintenance-planner.md",
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
  assert.match(plan.pullRequest.body, /\| Mode \| Trigger \| Policy agent \|/);
  assert.match(plan.pullRequest.body, /enabled after this setup pull request merges/i);
  assert.match(plan.pullRequest.body, /Edit `.github\/codekeeper\/agents\/\*\.md` to tune evidence thresholds/);
  assert.match(plan.pullRequest.body, /cannot grant writes, change triggers or branches, authorize repairs, close issues, or enable merge/);
  assert.match(plan.pullRequest.body, /Maintenance remains report-only unless an owner explicitly commands a repair/);
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
    ".github/codekeeper/agents/maintenance-planner.md",
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
