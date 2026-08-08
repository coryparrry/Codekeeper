import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient, isOwnedMarkerComment, resolveGraphqlUrl } from "../src/lib/github.mjs";
import { findingFingerprint, findingMarker, fixRunMarker, repairMarker, repairNotificationMarker, sha256 } from "../src/lib/markers.mjs";
import {
  isTrustedMaintenanceIssue,
  isTrustedRepairPull,
  publishAudit,
  publishFix,
  publishIssue,
  publishReview,
  reconcileAutoMerge,
  repairBranch
} from "../src/lib/publish.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
);
const ambientGitHubEnvironment = ["GITHUB_REPOSITORY", "GITHUB_GRAPHQL_URL"].map((name) => [name, process.env[name]]);
for (const [name] of ambientGitHubEnvironment) delete process.env[name];
test.after(() => {
  for (const [name, value] of ambientGitHubEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const fingerprint = "a".repeat(64);
const identity = { login: "codekeeper[bot]", id: "123456" };
const trustedPull = {
  body: `A maintainer may edit this description without affecting deduplication.\n${repairMarker(fingerprint)}`,
  user: { login: identity.login, id: Number(identity.id), type: "Bot" },
  head: {
    ref: repairBranch(config, "audit", fingerprint),
    repo: { full_name: "owner/repository" }
  },
  base: { repo: { full_name: "owner/repository" } }
};

function matches(pull) {
  return isTrustedRepairPull(pull, {
    fingerprint,
    config,
    repository: "owner/repository",
    botLogin: identity.login,
    botId: identity.id,
    mode: "audit"
  });
}

async function writeSealedArtifact(artifactDirectory, {
  mode, context, result, configSha256, patch = null, validation = { checks: [] }, artifactConfig = config
}) {
  const components = {
    context: Buffer.from(JSON.stringify(context)),
    result: Buffer.from(JSON.stringify(result)),
    config: Buffer.from(JSON.stringify(artifactConfig)),
    validation: Buffer.from(JSON.stringify(validation))
  };
  await Promise.all(Object.entries(components).map(([name, bytes]) =>
    writeFile(path.join(artifactDirectory, `${name}.json`), bytes)
  ));
  const patchBytes = patch?.valid ? await readFile(path.join(artifactDirectory, "patch.diff")) : null;
  const manifest = {
    version: 2,
    sealed: true,
    mode,
    repository: context.repository,
    configSha256,
    context,
    patch,
    validation,
    contextSha256: sha256(components.context),
    resultSha256: sha256(components.result),
    configFileSha256: sha256(components.config),
    validationSha256: sha256(components.validation),
    patchSha256: patchBytes ? sha256(patchBytes) : null
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(artifactDirectory, "manifest.json"), manifestBytes);
  return { expectedManifestSha256: sha256(manifestBytes) };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function replaceGitHubMethods(methods) {
  const originals = Object.fromEntries(Object.keys(methods).map((name) => [name, GitHubClient.prototype[name]]));
  Object.assign(GitHubClient.prototype, methods);
  return () => Object.assign(GitHubClient.prototype, originals);
}

test("repair PR deduplication accepts only the configured App marker, branch, and repositories", () => {
  assert.equal(matches(trustedPull), true);
  assert.equal(matches({ ...trustedPull, user: { login: "person", id: 123456, type: "User" } }), false);
  assert.equal(matches({ ...trustedPull, user: { login: "other-app[bot]", id: 123456, type: "Bot" } }), false);
  assert.equal(matches({ ...trustedPull, user: { ...trustedPull.user, id: 999 } }), false);
  assert.equal(matches({ ...trustedPull, body: `${trustedPull.body}\nuntrusted suffix` }), false);
  assert.equal(matches({ ...trustedPull, head: { ...trustedPull.head, ref: "feature/spoofed-marker" } }), false);
  assert.equal(matches({
    ...trustedPull,
    head: { ...trustedPull.head, repo: { full_name: "attacker/repository" } }
  }), false);
});


test("sticky marker comments ignore human and unrelated-bot spoofing", () => {
  const marker = "<!-- codekeeper:review -->";
  const trusted = {
    body: `Trusted review\n${marker}`,
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  };
  assert.equal(isOwnedMarkerComment(trusted, marker, identity), true);
  assert.equal(isOwnedMarkerComment({ ...trusted, user: { login: "person", id: 123456, type: "User" } }, marker, identity), false);
  assert.equal(isOwnedMarkerComment({ ...trusted, user: { login: "other-app[bot]", id: 123456, type: "Bot" } }, marker, identity), false);
  assert.equal(isOwnedMarkerComment({ ...trusted, user: { ...trusted.user, id: 999 } }, marker, identity), false);
  assert.equal(isOwnedMarkerComment({ ...trusted, body: `${trusted.body}\nuntrusted suffix` }, marker, identity), false);
});

test("maintenance issue fingerprints require the configured App author", () => {
  const marker = findingMarker("b".repeat(64));
  const issue = {
    body: `Trusted maintenance finding\n${marker}`,
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  };
  const options = { marker, botLogin: identity.login, botId: identity.id };
  assert.equal(isTrustedMaintenanceIssue(issue, options), true);
  assert.equal(isTrustedMaintenanceIssue({ ...issue, user: { login: "person", id: 123456, type: "User" } }, options), false);
  assert.equal(isTrustedMaintenanceIssue({ ...issue, user: { login: "other-app[bot]", id: 123456, type: "Bot" } }, options), false);
  assert.equal(isTrustedMaintenanceIssue({ ...issue, user: { ...issue.user, id: 999 } }, options), false);
  assert.equal(isTrustedMaintenanceIssue({ ...issue, body: `${issue.body}\nuntrusted suffix` }, options), false);
});

test("GraphQL follows the configured GitHub API host", () => {
  assert.equal(resolveGraphqlUrl("https://api.github.com"), "https://api.github.com/graphql");
  assert.equal(resolveGraphqlUrl("https://github.example/api/v3"), "https://github.example/api/graphql");
});

test("branch tips normalize GitHub branch data and treat a missing branch as absent", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/branches/existing")) {
        return new Response(JSON.stringify({
          commit: { commit: { tree: { sha: "tree" } }, parents: [{ sha: "base" }] }
        }));
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };
    const github = new GitHubClient({ token: "token", repository: "owner/repository" });
    assert.deepEqual(await github.getBranchTip("existing"), { treeSha: "tree", parentShas: ["base"] });
    assert.equal(await github.getBranchTip("missing"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("label management preserves existing metadata and unrelated labels", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  try {
    globalThis.fetch = async (url, options) => {
      const method = options.method;
      const target = String(url);
      calls.push({ method, target, body: options.body });
      if (target.endsWith("/labels/existing")) return json({ name: "existing", color: "ffffff", description: "repository-owned" });
      if (target.endsWith("/labels/race") && method === "GET" && calls.filter((call) => call.target.endsWith("/labels/race")).length === 1) {
        return json({ message: "Not Found" }, 404);
      }
      if (target.endsWith("/labels/race") && method === "GET") return json({ name: "race", color: "ffffff", description: "other owner" });
      if (target.endsWith("/issues/7") && method === "GET") return json({ labels: [{ name: "external" }, { name: "managed-old" }] });
      if (target.endsWith("/issues/7/labels") && method === "POST") return json({});
      if (target.endsWith("/issues/7/labels/managed-old") && method === "DELETE") return new Response(null, { status: 204 });
      if (target.endsWith("/labels") && method === "POST") return json({ message: "already exists" }, 422);
      throw new Error(`Unexpected request ${method} ${target}`);
    };
    const github = new GitHubClient({ token: "token", repository: "owner/repository" });
    await github.ensureLabel("existing", { color: "000000", description: "must not overwrite" });
    await github.ensureLabel("race", { color: "000000", description: "create race" });
    await github.replaceManagedLabels(7, ["managed-new"], ["managed-old", "managed-new"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
  assert.equal(calls.some((call) => call.target.endsWith("/issues/7") && call.method === "PATCH"), false);
  const add = calls.find((call) => call.target.endsWith("/issues/7/labels") && call.method === "POST");
  assert.deepEqual(JSON.parse(add.body), { labels: ["managed-new"] });
  assert.ok(calls.some((call) => call.target.endsWith("/issues/7/labels/managed-old") && call.method === "DELETE"));
});

test("publication fails if stale auto-merge cannot be disabled", async () => {
  await assert.rejects(
    reconcileAutoMerge(
      { disableAutoMerge: async () => { throw new Error("forbidden"); } },
      { number: 7, node_id: "PR_7", auto_merge: { enabled_at: "now" } },
      config,
      { eligible: false, reasons: ["review is blocked"] }
    ),
    /Could not disable stale auto-merge/
  );
});

test("eligible auto-merge enablement remains successful", async () => {
  let enabled = false;
  const result = await reconcileAutoMerge(
    { enableAutoMerge: async (nodeId, method) => { enabled = nodeId === "PR_7" && method === config.merge.method; } },
    { number: 7, node_id: "PR_7", auto_merge: null },
    config,
    { eligible: true, reasons: [] }
  );
  assert.equal(enabled, true);
  assert.deepEqual(result, { enabled: true, disabled: false, reason: "enabled" });
});

test("eligible PRs with active auto-merge are not re-enabled", async () => {
  let enableCalls = 0;
  const result = await reconcileAutoMerge(
    { enableAutoMerge: async () => { enableCalls += 1; } },
    { number: 7, node_id: "PR_7", auto_merge: { enabled_at: "now" } },
    config,
    { eligible: true, reasons: [] }
  );
  assert.equal(enableCalls, 0);
  assert.deepEqual(result, { enabled: true, disabled: false, reason: "already enabled" });
});

test("failed enablement confirms auto-merge when the response was lost", async () => {
  let refetched = false;
  const result = await reconcileAutoMerge(
    {
      enableAutoMerge: async () => { throw new Error("request timed out"); },
      async getPull(number) {
        refetched = number === 7;
        return { number, auto_merge: { enabled_at: "now" } };
      }
    },
    { number: 7, node_id: "PR_7", auto_merge: null },
    config,
    { eligible: true, reasons: [] }
  );
  assert.equal(refetched, true);
  assert.deepEqual(result, { enabled: true, disabled: false, reason: "confirmed enabled after failed enable request" });
});

test("failed enablement publishes manual review only after an inactive refetch", async () => {
  const result = await reconcileAutoMerge(
    {
      enableAutoMerge: async () => { throw new Error("GitHub rejected enablement"); },
      async getPull(number) { return { number, auto_merge: null }; }
    },
    { number: 7, node_id: "PR_7", auto_merge: null },
    config,
    { eligible: true, reasons: [] }
  );
  assert.deepEqual(result, { enabled: false, disabled: false, reason: "GitHub rejected enablement" });
});

test("failed enablement fails publication when auto-merge state cannot be refetched", async () => {
  await assert.rejects(
    reconcileAutoMerge(
      {
        enableAutoMerge: async () => { throw new Error("request timed out"); },
        getPull: async () => { throw new Error("GitHub unavailable"); }
      },
      { number: 7, node_id: "PR_7", auto_merge: null },
      config,
      { eligible: true, reasons: [] }
    ),
    /Could not determine auto-merge state/
  );
});

test("review publication activates auto-merge last and falls back safely", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-review-auto-merge-test-"));
  const configSha256 = "d".repeat(64);
  const reviewConfig = structuredClone(config);
  reviewConfig.merge.enabled = true;
  const context = {
    mode: "review",
    repository: "owner/repository",
    configSha256,
    pullRequest: {
      number: 7,
      headSha: "head",
      baseSha: "base",
      diff: { truncated: false, disabled: false }
    }
  };
  const result = {
    mode: "review", summary: "No blocking findings.", risk: "low", labels: [], blockingFindings: [],
    nonBlockingFindings: [], tests: { adequate: true, notes: "Covered." }, mergeRecommendation: "auto", noActionReason: null
  };
  const pull = {
    number: 7,
    node_id: "PR_7",
    state: "open",
    draft: false,
    auto_merge: null,
    user: { login: identity.login, type: "Bot" },
    head: { sha: "head", ref: "automation/codekeeper/repair-test", repo: { full_name: context.repository } },
    base: { sha: "base", ref: reviewConfig.repository.defaultBranch, repo: { full_name: context.repository } }
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const calls = [];
  let rejectEnable = true;
  let rejectDisable = false;
  let rejectLabels = false;
  const restoreGitHub = replaceGitHubMethods({
    async getPull() { return structuredClone(pull); },
    async listPullFiles() { return [{ filename: "README.md", additions: 1, deletions: 0 }]; },
    async enableAutoMerge() {
      calls.push({ type: "enable" });
      if (rejectEnable) throw new Error("GitHub rejected enablement");
    },
    async disableAutoMerge() {
      calls.push({ type: "disable" });
      if (rejectDisable) throw new Error("GitHub rejected disablement");
      pull.auto_merge = null;
    },
    async ensureLabels(_definitions, desiredLabels) { calls.push({ type: "ensure", desiredLabels }); },
    async replaceManagedLabels(_number, desiredLabels) {
      calls.push({ type: "labels", desiredLabels });
      if (rejectLabels) throw new Error("label publication failed");
    },
    async upsertMarkerComment(_number, _marker, comment) { calls.push({ type: "comment", comment }); }
  });
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "review", context, result, configSha256, artifactConfig: reviewConfig
    });
    const publication = await publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" });
    const provisioned = calls.find((call) => call.type === "ensure");
    const labelCalls = calls.filter((call) => call.type === "labels");
    const commentCalls = calls.filter((call) => call.type === "comment");
    const labels = labelCalls.at(-1);
    const comment = commentCalls.at(-1);

    assert.equal(publication.blocking, false);
    assert.equal(publication.autoMerge.eligible, false);
    assert.equal(publication.autoMergeResult.enabled, false);
    assert.deepEqual(calls.map((call) => call.type), ["ensure", "labels", "comment", "enable", "labels", "comment"]);
    assert.ok(provisioned.desiredLabels.includes("codekeeper:auto-merge"));
    assert.ok(provisioned.desiredLabels.includes("codekeeper:manual-review"));
    assert.ok(labelCalls[0].desiredLabels.includes("codekeeper:auto-merge"));
    assert.ok(labels.desiredLabels.includes("codekeeper:manual-review"));
    assert.ok(!labels.desiredLabels.includes("codekeeper:auto-merge"));
    assert.match(comment.comment, /Manual boundary retained/);
    assert.match(comment.comment, /Auto-merge is not active: GitHub rejected enablement/);
    assert.doesNotMatch(comment.comment, /Eligible for policy-controlled auto-merge/);

    calls.length = 0;
    rejectEnable = false;
    const successful = await publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" });
    assert.equal(successful.autoMergeResult.enabled, true);
    assert.deepEqual(calls.map((call) => call.type), ["ensure", "labels", "comment", "enable"]);

    calls.length = 0;
    pull.auto_merge = { enabled_at: "now" };
    rejectLabels = true;
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" }),
      /label publication failed/
    );
    assert.deepEqual(calls.map((call) => call.type), ["disable", "ensure", "labels"]);
    assert.equal(pull.auto_merge, null);

    calls.length = 0;
    pull.auto_merge = { enabled_at: "now" };
    rejectDisable = true;
    rejectLabels = false;
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" }),
      /Could not suspend auto-merge/
    );
    assert.deepEqual(calls.map((call) => call.type), ["disable"]);
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue publication does not close a duplicate after the triaged issue changes", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-stale-test-"));
  const configSha256 = "a".repeat(64);
  const issueConfig = structuredClone(config);
  issueConfig.issues.closeExactDuplicates = true;
  const context = { mode: "issue", repository: "owner/repository", configSha256, issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Exact duplicate.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: 9, duplicateConfidence: "high", implementationRecommendation: "manual", comment: "Thanks for the report."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let triageCommentPublished = false;
  let duplicateCommentPublished = false;
  let issueClosed = false;
  const restoreGitHub = replaceGitHubMethods({
    async getIssue(number) {
      if (number === 9) return { number, state: "open" };
      return { number, state: "open", updated_at: triageCommentPublished ? "2026-08-05T10:01:00Z" : context.issue.updatedAt, labels: [] };
    },
    async ensureLabels() {},
    async replaceManagedLabels() {},
    async upsertMarkerComment() { triageCommentPublished = true; },
    async createComment(_number, body) { duplicateCommentPublished ||= body.includes("Closing as a duplicate"); },
    async updateIssue() { issueClosed = true; }
  });
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "issue", context, result, configSha256, artifactConfig: issueConfig
    });
    await assert.rejects(
      publishIssue({ artifactDirectory, config: issueConfig, configSha256, ...integrity, token: "token" }),
      /changed after analysis/
    );
    assert.equal(duplicateCommentPublished, false);
    assert.equal(issueClosed, false);
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("fix publication does not create a repair PR after the issue changes", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-stale-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-artifact-"));
  const configSha256 = "b".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let issueReads = 0;
  let pullCreated = false;
  const restoreGitHub = replaceGitHubMethods({
    async getIssue(number) {
      issueReads += 1;
      return { number, state: "open", updated_at: issueReads === 1 ? "2026-08-05T10:00:00Z" : "2026-08-05T10:01:00Z" };
    },
    async findOpenPullByHead() { return null; },
    async createPull() { pullCreated = true; }
  });
  try {
    await writeFile(path.join(repository, "README.md"), "# Example\n", "utf8");
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "initial"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repository, "README.md"), "# Example\n\nRepair.\n", "utf8");
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", "HEAD"], { cwd: repository });
    await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
    git(repository, ["checkout", "--", "README.md"]);

    const context = {
      mode: "fix", repository: "owner/repository", configSha256, baseSha,
      defaultBranch: config.repository.defaultBranch, issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "Repair the documentation.", changedSummary: "Adds the missing repair guidance.",
      risk: "low", issueNumber: 7, testsRun: [], readyForReview: true, noChangeReason: null
    };
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "fix",
      context,
      result,
      configSha256,
      patch: { valid: true, fileName: "patch.diff", sha256: sha256(patch), files: ["README.md"] }
    });
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    process.chdir(repository);
    await assert.rejects(
      publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
      /changed after implementation started/
    );
    assert.equal(pullCreated, false);
  } finally {
    process.chdir(originalDirectory);
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(repository, { recursive: true, force: true });
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("maintenance publication adopts an App-created issue after response loss", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-retry-artifact-"));
  const configSha256 = "c".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const issues = [];
  let creates = 0;
  const restoreGitHub = replaceGitHubMethods({
    async listMaintenanceIssues() { return issues; },
    async listIssueComments() { throw new Error("orphan adoption must not require a second write"); },
    async ensureLabels() {},
    async createIssue(input) {
      creates += 1;
      const issue = {
        number: 1,
        state: "open",
        body: input.body,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      };
      issues.push(issue);
      throw new Error("connection lost after issue creation");
    },
    async updateIssue(number, changes) {
      Object.assign(issues.find((issue) => issue.number === number), changes);
    },
    async replaceManagedLabels() {}
  });
  try {
    await writeFile(path.join(repository, "README.md"), "# Example\n", "utf8");
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "initial"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]);
    const context = { mode: "audit", repository: "owner/repository", configSha256, baseSha, runUrl: "https://example.test/run" };
    const result = {
      mode: "audit",
      summary: "One maintenance finding.",
      findings: [{
        title: "Missing guide", evidence: "The guide is missing.", proposedAction: "Add the guide.",
        owningPath: "README.md", category: "docs", priority: "p2", problemKey: "missing-guide", labels: []
      }],
      repair: {
        requested: false, findingIndex: null, title: "", body: "", risk: "low", validationSummary: ""
      },
      noActionReason: null
    };
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "audit", context, result, configSha256 });
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    process.chdir(repository);
    await assert.rejects(
      publishAudit({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
      /connection lost after issue creation/
    );
    const retry = await publishAudit({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
    assert.equal(creates, 1);
    assert.equal(issues.length, 1);
    assert.deepEqual(retry.findings.map(({ state, issueNumber }) => ({ state, issueNumber })), [
      { state: "updated", issueNumber: 1 }
    ]);
  } finally {
    process.chdir(originalDirectory);
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(repository, { recursive: true, force: true });
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("maintenance repair notification remains singular after response loss", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-repair-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-repair-retry-artifact-"));
  const configSha256 = "e".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const notifications = [];
  let notificationAttempts = 0;
  try {
    await writeFile(path.join(repository, "README.md"), "# Example\n", "utf8");
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "initial"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]);
    const finding = {
      title: "Missing guide", evidence: "The guide is missing.", proposedAction: "Add the guide.",
      owningPath: "README.md", category: "docs", priority: "p2", problemKey: "missing-guide", labels: []
    };
    const repairFingerprint = findingFingerprint(finding);
    const context = { mode: "audit", repository: "owner/repository", configSha256, baseSha, runUrl: "https://example.test/run" };
    const result = {
      mode: "audit",
      summary: "One maintenance finding.",
      findings: [finding],
      repair: {
        requested: true, findingIndex: 0, title: "Add the guide.", body: "Adds the missing guide.", risk: "low", validationSummary: ""
      },
      noActionReason: null
    };
    const patch = Buffer.from("");
    await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "audit",
      context,
      result,
      configSha256,
      patch: { valid: true, fileName: "patch.diff", sha256: sha256(patch), files: [] }
    });
    const maintenanceIssue = {
      number: 1,
      state: "open",
      body: `Existing maintenance finding\n${findingMarker(repairFingerprint)}`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" }
    };
    const repairPull = {
      number: 12,
      html_url: "https://example.test/pull/12",
      body: `Repair\n${repairMarker(repairFingerprint)}`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" },
      head: { ref: repairBranch(config, "audit", repairFingerprint), repo: { full_name: context.repository } },
      base: { repo: { full_name: context.repository } }
    };
    const restoreGitHub = replaceGitHubMethods({
      async listMaintenanceIssues() { return [maintenanceIssue]; },
      async ensureLabels() {},
      async updateIssue() {},
      async replaceManagedLabels() {},
      async findOpenPullByHead() { return repairPull; },
      async upsertMarkerComment(number, marker, body, authorIdentity) {
        assert.equal(number, maintenanceIssue.number);
        assert.equal(marker, repairNotificationMarker(repairFingerprint));
        assert.deepEqual(authorIdentity, identity);
        const content = `${body}\n${marker}`;
        if (notifications.length === 0) notifications.push(content);
        else notifications[0] = content;
        notificationAttempts += 1;
        if (notificationAttempts === 1) throw new Error("connection lost after repair notification");
      }
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      process.chdir(repository);
      await assert.rejects(
        publishAudit({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /connection lost after repair notification/
      );
      await publishAudit({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
      assert.equal(notificationAttempts, 2);
      assert.deepEqual(notifications, [
        `A repair pull request was opened: ${repairPull.html_url}\n${repairNotificationMarker(repairFingerprint)}`
      ]);
    } finally {
      restoreGitHub();
    }
  } finally {
    process.chdir(originalDirectory);
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(repository, { recursive: true, force: true });
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("fix repair notification remains singular after response loss", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-repair-retry-artifact-"));
  const configSha256 = "f".repeat(64);
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const notification = [];
  let notificationAttempts = 0;
  let labelReconciliations = 0;
  try {
    const patch = Buffer.from("");
    await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
    const context = {
      mode: "fix", repository: "owner/repository", configSha256, baseSha: "base",
      defaultBranch: config.repository.defaultBranch, issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "Repair the documentation.", changedSummary: "Adds the missing repair guidance.",
      risk: "low", issueNumber: 7, testsRun: [], readyForReview: true, noChangeReason: null
    };
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "fix",
      context,
      result,
      configSha256,
      patch: { valid: true, fileName: "patch.diff", sha256: sha256(patch), files: [] }
    });
    const repairFingerprint = sha256("issue|owner/repository|7");
    const repairPull = {
      number: 12,
      html_url: "https://example.test/pull/12",
      body: `Repair\n${repairMarker(repairFingerprint)}`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" },
      head: { ref: repairBranch(config, "fix", repairFingerprint), repo: { full_name: context.repository } },
      base: { repo: { full_name: context.repository } }
    };
    const restoreGitHub = replaceGitHubMethods({
      async getIssue(number) { return { number, state: "open", updated_at: context.issue.updatedAt }; },
      async findOpenPullByHead() { return repairPull; },
      async ensureLabels() {},
      async replaceManagedLabels() { labelReconciliations += 1; },
      async upsertMarkerComment(number, marker, body, authorIdentity) {
        assert.equal(number, context.issue.number);
        assert.equal(marker, repairNotificationMarker(repairFingerprint));
        assert.deepEqual(authorIdentity, identity);
        const content = `${body}\n${marker}`;
        if (notification.length === 0) notification.push(content);
        else notification[0] = content;
        notificationAttempts += 1;
        if (notificationAttempts === 1) throw new Error("connection lost after repair notification");
      }
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /connection lost after repair notification/
      );
      const retry = await publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
      assert.equal(retry.created, false);
      assert.equal(retry.reason, "Existing repair PR");
      assert.equal(labelReconciliations, 2);
      assert.equal(notificationAttempts, 2);
      assert.deepEqual(notification, [
        `Codekeeper opened a repair pull request: ${repairPull.html_url}\n${repairNotificationMarker(repairFingerprint)}`
      ]);
    } finally {
      restoreGitHub();
    }
  } finally {
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("fix no-patch notification remains singular after response loss", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-no-patch-retry-artifact-"));
  const configSha256 = "1".repeat(64);
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const notification = [];
  let notificationAttempts = 0;
  try {
    const context = {
      mode: "fix", repository: "owner/repository", configSha256, runId: "12345",
      issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "No change is safe.", changedSummary: "",
      risk: "low", issueNumber: 7, testsRun: [], readyForReview: false, noChangeReason: "No valid repair was produced."
    };
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "fix", context, result, configSha256 });
    const restoreGitHub = replaceGitHubMethods({
      async getIssue(number) { return { number, state: "open", updated_at: context.issue.updatedAt }; },
      async upsertMarkerComment(number, marker, body, authorIdentity) {
        assert.equal(number, context.issue.number);
        assert.equal(marker, fixRunMarker(context.runId));
        assert.deepEqual(authorIdentity, identity);
        const content = `${body}\n${marker}`;
        if (notification.length === 0) notification.push(content);
        else notification[0] = content;
        notificationAttempts += 1;
        if (notificationAttempts === 1) throw new Error("connection lost after no-patch notification");
      }
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /connection lost after no-patch notification/
      );
      const retry = await publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
      assert.equal(retry.created, false);
      assert.equal(notificationAttempts, 2);
      assert.deepEqual(notification, [
        `Codekeeper did not open a PR. ${result.noChangeReason}\n${fixRunMarker(context.runId)}`
      ]);
    } finally {
      restoreGitHub();
    }
  } finally {
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("fix publication adopts an exact orphan repair branch", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-retry-artifact-"));
  const configSha256 = "d".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let pullsCreated = 0;
  let deleteAttempts = 0;
  let labelReconciliations = 0;
  try {
    await writeFile(path.join(repository, "README.md"), "# Example\n", "utf8");
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "initial"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repository, "README.md"), "# Example\n\nRepair.\n", "utf8");
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", "HEAD"], { cwd: repository });
    await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
    git(repository, ["checkout", "-b", "seed-orphan"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "orphan repair"]);
    const orphanTreeSha = git(repository, ["rev-parse", "HEAD^{tree}"]);
    git(repository, ["checkout", "main"]);
    git(repository, ["branch", "-D", "seed-orphan"]);

    const context = {
      mode: "fix", repository: "owner/repository", configSha256, baseSha,
      defaultBranch: config.repository.defaultBranch, issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "Repair the documentation.", changedSummary: "Adds the missing repair guidance.",
      risk: "low", issueNumber: 7, testsRun: [], readyForReview: true, noChangeReason: null
    };
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "fix",
      context,
      result,
      configSha256,
      patch: { valid: true, fileName: "patch.diff", sha256: sha256(patch), files: ["README.md"] }
    });
    const branch = repairBranch(config, "fix", sha256("issue|owner/repository|7"));
    let remoteTreeSha = orphanTreeSha;
    const restoreGitHub = replaceGitHubMethods({
      async getIssue(number) { return { number, title: "Repair", state: "open", updated_at: context.issue.updatedAt }; },
      async findOpenPullByHead() { return null; },
      async getBranchTip(requestedBranch) {
        assert.equal(requestedBranch, branch);
        return { treeSha: remoteTreeSha, parentShas: [baseSha] };
      },
      async createPull(input) {
        pullsCreated += 1;
        assert.equal(input.head, branch);
        if (pullsCreated === 2) throw new Error("connection lost before pull creation");
        return { number: 12, html_url: "https://example.test/pull/12" };
      },
      async ensureLabels() {},
      async replaceManagedLabels() { labelReconciliations += 1; },
      async upsertMarkerComment() {},
      async deleteBranch() { deleteAttempts += 1; }
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      process.chdir(repository);
      const repair = await publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
      assert.equal(repair.created, true);
      assert.equal(repair.pullRequest, 12);
      assert.equal(pullsCreated, 1);
      assert.equal(labelReconciliations, 1);
      git(repository, ["checkout", "main"]);
      git(repository, ["branch", "-D", branch]);
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /connection lost before pull creation/
      );
      assert.equal(deleteAttempts, 0);
      assert.equal(pullsCreated, 2);
      git(repository, ["checkout", "main"]);
      git(repository, ["branch", "-D", branch]);
      remoteTreeSha = "0".repeat(40);
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /already exists with unexpected content/
      );
      assert.equal(pullsCreated, 2);
    } finally {
      restoreGitHub();
    }
  } finally {
    process.chdir(originalDirectory);
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(repository, { recursive: true, force: true });
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("publication rejects sealed artifacts with a tampered configuration hash", async () => {
  const expectedConfigSha256 = "a".repeat(64);
  for (const [manifestConfigSha256, contextConfigSha256] of [
    ["b".repeat(64), expectedConfigSha256],
    [expectedConfigSha256, "b".repeat(64)]
  ]) {
    const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-publish-test-"));
    try {
      const context = { mode: "audit", repository: "owner/repository", configSha256: contextConfigSha256 };
      const integrity = await writeSealedArtifact(artifactDirectory, {
        mode: "audit", context, result: { mode: "audit" }, configSha256: manifestConfigSha256
      });
      await assert.rejects(
        publishAudit({ artifactDirectory, config, configSha256: expectedConfigSha256, ...integrity, token: "unused" }),
        /Artifact configuration does not match/
      );
    } finally {
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  }
});

test("publication rejects a result changed after sealing before GitHub access", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-result-tamper-"));
  const configSha256 = "a".repeat(64);
  const context = {
    mode: "issue", repository: "owner/repository", configSha256,
    issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" }
  };
  const result = {
    mode: "issue", summary: "Ready for triage.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual", comment: "Thanks."
  };
  const originalFetch = globalThis.fetch;
  let githubAccessed = false;
  try {
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256 });
    await writeFile(path.join(artifactDirectory, "result.json"), JSON.stringify({ ...result, priority: "p1" }));
    globalThis.fetch = async () => { githubAccessed = true; throw new Error("unexpected GitHub access"); };
    await assert.rejects(
      publishIssue({ artifactDirectory, config, configSha256, ...integrity, token: "unused" }),
      /component changed after sealing/
    );
    assert.equal(githubAccessed, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("publication revalidates a sealed result before GitHub access", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-result-schema-"));
  const configSha256 = "a".repeat(64);
  const context = { mode: "issue", repository: "owner/repository", configSha256, issue: { number: 7 } };
  try {
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "issue", context, result: { mode: "issue" }, configSha256
    });
    await assert.rejects(
      publishIssue({ artifactDirectory, config, configSha256, ...integrity, token: "unused" }),
      /Invalid Codex result/
    );
  } finally {
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("review publication rejects same-SHA retargets before mutations", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-review-test-"));
  const configSha256 = "a".repeat(64);
  const context = {
    mode: "review",
    repository: "owner/repository",
    configSha256,
    pullRequest: { number: 7, headSha: "head", baseSha: "base" }
  };
  const result = {
    mode: "review", summary: "No blocking findings.", risk: "low", labels: [], blockingFindings: [],
    nonBlockingFindings: [], tests: { adequate: true, notes: "" }, mergeRecommendation: "manual", noActionReason: null
  };
  const originalFetch = globalThis.fetch;
  try {
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "review", context, result, configSha256 });
    for (const pull of [
      { baseRef: "release", headRepository: context.repository, baseRepository: context.repository },
      { baseRef: config.repository.defaultBranch, headRepository: "attacker/repository", baseRepository: context.repository },
      { baseRef: config.repository.defaultBranch, headRepository: context.repository, baseRepository: "attacker/repository" }
    ]) {
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ method: options.method, url: String(url) });
        return new Response(JSON.stringify({
          number: context.pullRequest.number,
          state: "open",
          head: { sha: context.pullRequest.headSha, repo: { full_name: pull.headRepository } },
          base: { sha: context.pullRequest.baseSha, ref: pull.baseRef, repo: { full_name: pull.baseRepository } }
        }));
      };
      await assert.rejects(
        publishReview({ artifactDirectory, config, configSha256, ...integrity, token: "unused", dryRun: true }),
        /base branch changed|repository changed/
      );
      assert.deepEqual(calls.map((call) => call.method), ["GET"]);
      assert.ok(calls[0].url.endsWith("/pulls/7"));
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue context pagination stops once the configured limit is satisfied", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify([{ number: 2, pull_request: {} }, { number: 1, title: "Issue" }]),
        { headers: { Link: '<https://api.github.com/repos/owner/repository/issues?page=2>; rel="next"' } }
      );
    };
    const github = new GitHubClient({ token: "token", repository: "owner/repository" });
    const issues = await github.listOpenIssues(1);
    assert.deepEqual(issues.map((issue) => issue.number), [1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 1);
});
