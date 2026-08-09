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
  APP_SECRET,
  ASSET_KEYS,
  DEEPSEEK_SECRET,
  MODE_IDS,
  MODES,
  OPENAI_SECRET,
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
  "policies/mixed.json": "37e32105ba2300e465af8132b241633833130394eb5c15a300c0a6bf1c1f589d",
  "policies/openai.json": "753741a11159d48a9c6bd7d938edd3310b1e9d0d242e86098715db0e499faad0",
  "workflows/fix.yml": "5fbe5f521c95050b5b695d74f1a119b7301229e43a594554e3b333c090a3209e",
  "workflows/issues.yml": "499f550427c88bfce685f7be0f8b923b52c0edebeb066c4a35626096029e0ca0",
  "workflows/maintain.yml": "6f6645a87e00442070a1ff61fb473b51ede872910e3a19cc7e31e71d43634f36",
  "workflows/review.yml": "c4a5717051e1b634d1ab863ee6307752fe050cb3cb131acbb6637772fdd00f5d"
});

const CHECKPOINT_PATHS = Object.freeze({
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
  return {
    modes: ["review", "maintain", "issues", "fix"],
    preset: "mixed",
    displayName: "Widget",
    ownerLogins: ["CoryParrry", "Acme-Bot"],
    appClientId: "Iv123456789012345678",
    automationBotLogin: "Codekeeper-Acme[bot]",
    ...overrides
  };
}

test("the six bundled assets have immutable release inventory, provenance, byte counts, and digests", async () => {
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

test("checkpoint-backed policy and workflow assets are byte-for-byte source release files", async () => {
  const bundle = await loadVerifiedAssets();
  for (const [asset, sourcePath] of Object.entries(CHECKPOINT_PATHS)) {
    const source = execFileSync("git", ["show", `${PINNED_COMMIT}:${sourcePath}`], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8"
    });
    assert.equal(bundle.contents[asset], source, `${asset} differs from ${sourcePath} at the pinned checkpoint`);
  }
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

test("renderInstallFiles emits only the policy and selected callers with verified output digests", async () => {
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
    ".github/workflows/codekeeper-review.yml",
    ".github/workflows/codekeeper-issues.yml"
  ]);
  for (const file of files) {
    assert.equal(file.bytes, Buffer.byteLength(file.contents));
    assert.equal(file.sha256, sha256(file.contents));
    assert.ok(Object.isFrozen(file));
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

test("install plan is frozen, disabled first, and documents selected workflows without credential values", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({ bundle, snapshot: snapshot(), answers: answers() });
  assert.ok(Object.isFrozen(plan));
  assert.deepEqual(plan.variables[0], { name: "CODEKEEPER_ENABLED", value: "false" });
  assert.deepEqual(plan.variables.slice(1), [
    { name: "CODEKEEPER_APP_CLIENT_ID", value: "Iv123456789012345678" },
    { name: "CODEKEEPER_AUTOMATION_BOT_LOGIN", value: "codekeeper-acme[bot]" }
  ]);
  assert.deepEqual(plan.ownerLogins, ["coryparrry", "acme-bot"]);
  assert.equal(plan.originalHead, HEAD_SHA);
  assert.equal(plan.branch, "codekeeper/setup");
  assert.match(plan.pullRequest.body, /\| Document \| Purpose \|/);
  assert.match(plan.pullRequest.body, /\| Mode \| Trigger \| Policy agent \|/);
  assert.match(plan.pullRequest.body, /CODEKEEPER_ENABLED=false/);
  assert.match(plan.pullRequest.body, /did not merge.*enable Codekeeper.*dispatch a workflow/s);
  assert.doesNotMatch(plan.pullRequest.body, /PRIVATE KEY|sk-[A-Za-z0-9]/i);
  assert.deepEqual(documentMap(plan.files).map((item) => item.path), plan.files.map((file) => file.path));
  assert.deepEqual(workflowMap(plan.modes).map((item) => item.mode), MODE_IDS);
  assert.equal(setupPullRequestBody(plan), plan.pullRequest.body);
});

test("GitHub App registration URL is private, webhook-free, repository-owned, and permission-bounded", () => {
  const url = new URL(appRegistrationUrl({
    repository: "Acme/Widget",
    displayName: "Widget App"
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
    displayName: "A very long repository display name that must be bounded"
  }).split("#")[0]);
  assert.equal(longNameUrl.searchParams.get("name").length, 34);
});
