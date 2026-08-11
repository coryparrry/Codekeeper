import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient, isOwnedMarkerComment, resolveGraphqlUrl } from "../src/lib/github.mjs";
import { AGENT_PROFILE_BUNDLE_FILE, AGENT_PROFILE_PATHS } from "../src/lib/agent-profiles.mjs";
import { createCommitOnCurrentHead } from "../src/lib/git.mjs";
import { deferredReviewMarker, deferredReviewFingerprint, findingFingerprint, findingMarker, fixRunMarker, repairMarker, repairNotificationMarker, sha256 } from "../src/lib/markers.mjs";
import { frozenPullRepairSubject, frozenPullRepairSubjectSha256 } from "../src/lib/pr-repair.mjs";
import {
  isTrustedMaintenanceIssue,
  isTrustedRepairPull,
  publishAudit as publishAuditProduction,
  publishFix as publishFixProduction,
  publishIssue as publishIssueProduction,
  publishReview as publishReviewProduction,
  reconcileAutoMerge,
  repairBranch,
  replyToReviewFeedback,
  upsertDeferredReviewFeedback
} from "../src/lib/publish.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8")
);
const profileFixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-publish-profiles-"));
const profilePaths = {};
const profileBytes = {};
for (const [mode, relativePath] of Object.entries(AGENT_PROFILE_PATHS)) {
  const filePath = path.join(profileFixtureRoot, relativePath);
  const bytes = Buffer.from(`# Test ${mode} profile\n\nUse frozen evidence only.\n`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  profilePaths[mode] = filePath;
  profileBytes[mode] = bytes;
}
test.after(() => rm(profileFixtureRoot, { recursive: true, force: true }));

function publishReview(options) {
  return publishReviewProduction({ agentProfilePath: profilePaths.review, ...options });
}

function publishAudit(options) {
  return publishAuditProduction({ agentProfilePath: profilePaths.audit, ...options });
}

function publishIssue(options) {
  return publishIssueProduction({ agentProfilePath: profilePaths.issue, ...options });
}

function publishFix(options) {
  return publishFixProduction({ agentProfilePath: profilePaths.fix, ...options });
}
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
  const agentProfile = profileBytes[mode];
  context.agentProfile ??= {
    path: AGENT_PROFILE_PATHS[mode],
    sha256: sha256(agentProfile),
    sourceSha: "a".repeat(40)
  };
  const components = {
    context: Buffer.from(JSON.stringify(context)),
    result: Buffer.from(JSON.stringify(result)),
    config: Buffer.from(JSON.stringify(artifactConfig)),
    validation: Buffer.from(JSON.stringify(validation)),
    "runtime-metadata": Buffer.from(JSON.stringify({
      mode,
      provider: "offline",
      model: "offline-fixture",
      attempt: 1,
      structuredOutputs: true,
      workspaceSpecialistUsed: true,
      maxTurns: 1,
      durationMs: 1,
      promptBytes: 1,
      evidenceBytes: 1,
      outputBytes: 1,
      cacheKey: "offline-fixture",
      cacheMode: "unsupported",
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0 }
    })),
    [AGENT_PROFILE_BUNDLE_FILE]: agentProfile
  };
  await Promise.all(Object.entries(components).map(([name, bytes]) => writeFile(
    path.join(artifactDirectory, name === AGENT_PROFILE_BUNDLE_FILE ? name : `${name}.json`),
    bytes
  )));
  const patchBytes = patch?.valid ? await readFile(path.join(artifactDirectory, "patch.diff")) : null;
  const manifest = {
    version: 3,
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
    agentProfileSha256: sha256(agentProfile),
    runtimeMetadataSha256: sha256(components["runtime-metadata"]),
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

test("verified deferred feedback creates one idempotent issue with backlinks and triage metadata", async () => {
  const context = {
    repository: "owner/repository",
    runUrl: "https://github.com/owner/repository/actions/runs/9",
    pullRequest: {
      number: 7,
      url: "https://github.com/owner/repository/pull/7",
      reviewFeedback: [
        { sourceKey: "review_comment:41", rootCommentId: 41, author: "reviewer", url: "https://github.com/owner/repository/pull/7#discussion_r41" },
        { sourceKey: "review_comment:42", rootCommentId: 41, author: "owner", url: "https://github.com/owner/repository/pull/7#discussion_r42" }
      ]
    }
  };
  const feedback = {
    problemKey: "timeout-regression-coverage",
    disposition: "defer",
    type: "testing",
    explanation: "Add deterministic timeout regression coverage.",
    validation: "The current head still lacks the timeout case.",
    sourceKeys: ["review_comment:41", "review_comment:42"],
    threadIds: ["PRRT_thread"]
  };
  const fingerprint = deferredReviewFingerprint(context.repository, 7, feedback.problemKey);
  const existing = [];
  const calls = { created: [], updated: [], replies: [], labels: [] };
  const github = {
    async listMaintenanceIssues() { return existing; },
    async ensureLabels(_definitions, labels) { calls.labels.push(labels); },
    async createIssue(input) {
      calls.created.push(input);
      const issue = { ...input, number: 51, html_url: "https://github.com/owner/repository/issues/51", state: "open", user: { login: identity.login, id: Number(identity.id), type: "Bot" } };
      return issue;
    },
    async updateIssue(number, input) {
      calls.updated.push({ number, input });
      return { ...existing[0], ...input };
    },
    async replaceManagedLabels() {},
    async upsertReviewReply(number, commentId, marker, body) { calls.replies.push({ number, commentId, marker, body }); }
  };
  const input = { github, context, result: { reviewFeedback: [feedback] }, config, automationIdentity: identity };

  const created = await upsertDeferredReviewFeedback(input);
  assert.deepEqual(created.map((item) => item.state), ["created"]);
  assert.deepEqual(calls.created[0].labels, ["codekeeper:deferred", "codekeeper:type-testing"]);
  assert.match(calls.created[0].body, /pull\/7#discussion_r41/);
  assert.match(calls.created[0].body, new RegExp(deferredReviewMarker(fingerprint)));
  assert.equal(calls.replies[0].commentId, 41);
  assert.match(calls.replies[0].body, /issue #51/);

  existing.push({
    ...calls.created[0],
    number: 51,
    state: "open",
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  });
  const updated = await upsertDeferredReviewFeedback(input);
  assert.deepEqual(updated.map((item) => item.state), ["updated"]);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.replies.length, 2, "one idempotent thread-reply upsert runs per publication");

  const automaticPolicyOff = structuredClone(config);
  automaticPolicyOff.review.createDeferredIssues = false;
  assert.deepEqual(await upsertDeferredReviewFeedback({
    ...input,
    config: automaticPolicyOff,
    ownerRequested: false,
    dryRun: true
  }), []);
  assert.deepEqual((await upsertDeferredReviewFeedback({
    ...input,
    config: automaticPolicyOff,
    ownerRequested: true,
    dryRun: true
  })).map((item) => item.state), ["would-update"]);
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

test("ignored and repairable inline feedback receive idempotent replies without resolving threads", async () => {
  const replies = [];
  const context = {
    repository: "owner/repository",
    pullRequest: {
      number: 7,
      reviewFeedback: [
        { sourceKey: "review_comment:41", rootCommentId: 41 },
        { sourceKey: "review_comment:42", rootCommentId: 41 },
        { sourceKey: "review_comment:43", rootCommentId: 43 }
      ]
    }
  };
  const result = { reviewFeedback: [
    { problemKey: "duplicate-style-request", disposition: "ignore", explanation: "This duplicates an already resolved preference.", validation: "No current defect remains.", sourceKeys: ["review_comment:41", "review_comment:42"] },
    { problemKey: "current-null-crash", disposition: "fix_now", explanation: "The current head can crash.", validation: "A regression test reproduces it.", sourceKeys: ["review_comment:43"] }
  ] };
  const published = await replyToReviewFeedback({
    github: { async upsertReviewReply(number, commentId, marker, body) { replies.push({ number, commentId, marker, body }); } },
    context,
    result,
    automationIdentity: identity
  });
  assert.deepEqual(published.map(({ commentId, disposition }) => ({ commentId, disposition })), [
    { commentId: 41, disposition: "ignore" },
    { commentId: 43, disposition: "fix_now" }
  ]);
  assert.match(replies[0].body, /^No action:/);
  assert.match(replies[1].body, /^Fix now:/);
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
    runId: "7001",
    runUrl: "https://github.com/owner/repository/actions/runs/7001",
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
    labels: [],
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
  let mutateHeadAfterEnable = false;
  let pauseAfterEnable = false;
  let hideAutoMergeAfterEnable = false;
  let enabledThisRun = false;
  const restoreGitHub = replaceGitHubMethods({
    async getPull() {
      if ((mutateHeadAfterEnable || pauseAfterEnable) && enabledThisRun) {
        if (mutateHeadAfterEnable) pull.head.sha = "moved-after-activation";
        if (pauseAfterEnable) pull.labels = [{ name: "codekeeper:paused" }];
        pull.auto_merge = { enabled_at: "now" };
        enabledThisRun = false;
      }
      if (hideAutoMergeAfterEnable && enabledThisRun) {
        hideAutoMergeAfterEnable = false;
        const hidden = structuredClone(pull);
        hidden.auto_merge = null;
        return hidden;
      }
      return structuredClone(pull);
    },
    async listPullFiles() { return [{ filename: "README.md", additions: 1, deletions: 0 }]; },
    async enableAutoMerge() {
      calls.push({ type: "enable" });
      if (rejectEnable) throw new Error("GitHub rejected enablement");
      pull.auto_merge = { enabled_at: "now" };
      enabledThisRun = true;
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
    assert.match(comment.comment, /<sub>Codekeeper workflow run: https:\/\/github\.com\/owner\/repository\/actions\/runs\/7001<\/sub>/);

    calls.length = 0;
    rejectEnable = false;
    const successful = await publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" });
    assert.equal(successful.autoMergeResult.enabled, true);
    assert.deepEqual(calls.map((call) => call.type), ["ensure", "labels", "comment", "enable"]);

    calls.length = 0;
    pull.auto_merge = null;
    enabledThisRun = false;
    hideAutoMergeAfterEnable = true;
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" }),
      /auto-merge.*postcondition/i
    );
    assert.deepEqual(calls.map((call) => call.type), ["ensure", "labels", "comment", "enable", "disable"]);
    assert.equal(pull.auto_merge, null);

    calls.length = 0;
    pull.auto_merge = null;
    enabledThisRun = false;
    mutateHeadAfterEnable = true;
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" }),
      /auto-merge.*postcondition|stale review/i
    );
    assert.deepEqual(calls.map((call) => call.type), ["ensure", "labels", "comment", "enable", "disable"]);
    assert.equal(pull.auto_merge, null);
    pull.head.sha = "head";
    mutateHeadAfterEnable = false;
    enabledThisRun = false;

    calls.length = 0;
    pauseAfterEnable = true;
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" }),
      /postcondition.*paused/i
    );
    assert.deepEqual(calls.map((call) => call.type), ["ensure", "labels", "comment", "enable", "disable"]);
    assert.equal(pull.auto_merge, null);
    pull.labels = [];
    pauseAfterEnable = false;
    enabledThisRun = false;

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
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7002", runUrl: "https://github.com/owner/repository/actions/runs/7002", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Exact duplicate.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: 9, duplicateConfidence: "high", implementationRecommendation: "manual", comment: "Thanks for the report."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let triageCommentPublished = false;
  let duplicateCommentPublished = false;
  let issueClosed = false;
  let updatedAt = context.issue.updatedAt;
  let labels = [];
  const restoreGitHub = replaceGitHubMethods({
    async getIssue(number) {
      if (number === 9) return { number, state: "open" };
      return { number, state: "open", updated_at: updatedAt, labels };
    },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = desiredLabels.map((name) => ({ name }));
      updatedAt = "2026-08-05T10:00:30Z";
    },
    async upsertMarkerComment() {
      triageCommentPublished = true;
      updatedAt = "2026-08-05T10:01:00Z";
    },
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
    assert.equal(triageCommentPublished, true);
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

test("issue publication accepts its exact managed-label mutation before publishing the App marker", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-label-revision-test-"));
  const configSha256 = "c".repeat(64);
  const issueConfig = structuredClone(config);
  issueConfig.issues.allowAiImplementation = true;
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7003", runUrl: "https://github.com/owner/repository/actions/runs/7003", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Ready for triage.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "ai-ready", comment: "Thanks for the report."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let updatedAt = context.issue.updatedAt;
  let labels = [{ name: "external" }, { name: "codekeeper:priority-p1" }];
  let markerPublished = false;
  const issue = () => ({
    number: 7, title: "Report", body: "Details", state: "open", updated_at: updatedAt,
    html_url: "https://github.com/owner/repository/issues/7",
    user: { id: 1, login: "reporter", type: "User" }, labels
  });
  const restoreGitHub = replaceGitHubMethods({
    async getIssue() { return issue(); },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = [{ name: "external" }, ...desiredLabels.map((name) => ({ name }))];
      updatedAt = "2026-08-05T10:01:00Z";
    },
    async upsertMarkerComment() { markerPublished = true; }
  });
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256, artifactConfig: issueConfig });
    await publishIssue({ artifactDirectory, config: issueConfig, configSha256, ...integrity, token: "token" });
    assert.equal(markerPublished, true);
    assert.deepEqual(labels.map((label) => label.name).sort(), ["codekeeper:priority-p3", "codekeeper:ready", "codekeeper:type-bug", "external"].sort());
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue publication rejects subject drift during its managed-label mutation", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-label-drift-test-"));
  const configSha256 = "d".repeat(64);
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7004", runUrl: "https://github.com/owner/repository/actions/runs/7004", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Manual triage.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual", comment: "Thanks."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let title = "Report";
  let updatedAt = context.issue.updatedAt;
  let labels = [];
  let markerPublished = false;
  const restoreGitHub = replaceGitHubMethods({
    async getIssue() { return { number: 7, title, body: "Details", state: "open", updated_at: updatedAt, user: { id: 1, login: "reporter", type: "User" }, labels }; },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = desiredLabels.map((name) => ({ name }));
      title = "Externally edited report";
      updatedAt = "2026-08-05T10:01:00Z";
    },
    async upsertMarkerComment() { markerPublished = true; }
  });
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256 });
    await assert.rejects(
      publishIssue({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
      /changed while Codekeeper reconciled labels/
    );
    assert.equal(markerPublished, false);
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue publication rejects same-timestamp subject drift after verified label reconciliation", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-post-label-drift-test-"));
  const configSha256 = "e".repeat(64);
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7005", runUrl: "https://github.com/owner/repository/actions/runs/7005", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Manual triage.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual", comment: "Thanks."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let labels = [];
  let updatedAt = context.issue.updatedAt;
  let postMutationReads = 0;
  let mutationComplete = false;
  let markerPublished = false;
  const restoreGitHub = replaceGitHubMethods({
    async getIssue() {
      if (mutationComplete) postMutationReads += 1;
      return {
        number: 7,
        title: postMutationReads >= 2 ? "Externally edited at the same timestamp" : "Report",
        body: "Details",
        state: "open",
        updated_at: updatedAt,
        user: { id: 1, login: "reporter", type: "User" },
        labels
      };
    },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = desiredLabels.map((name) => ({ name }));
      updatedAt = "2026-08-05T10:01:00Z";
      mutationComplete = true;
    },
    async upsertMarkerComment() { markerPublished = true; }
  });
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256 });
    await assert.rejects(
      publishIssue({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
      /changed while Codekeeper reconciled labels/
    );
    assert.equal(markerPublished, false);
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue publication rejects malformed post-label timestamps and label metadata", async (t) => {
  const cases = [
    {
      name: "invalid timestamp",
      mutate(desiredLabels) { return { updatedAt: "not-a-timestamp", labels: desiredLabels.map((name) => ({ name })) }; },
      error: /no updated timestamp/
    },
    {
      name: "duplicate label",
      mutate(desiredLabels) { return { updatedAt: "2026-08-05T10:01:00Z", labels: [{ name: desiredLabels[0] }, ...desiredLabels.map((name) => ({ name }))] }; },
      error: /invalid or duplicate label metadata/
    },
    {
      name: "nameless label",
      mutate(desiredLabels) { return { updatedAt: "2026-08-05T10:01:00Z", labels: [{ color: "ffffff" }, ...desiredLabels.map((name) => ({ name }))] }; },
      error: /invalid or duplicate label metadata/
    }
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-label-metadata-test-"));
      const configSha256 = "f".repeat(64);
      const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7006", runUrl: "https://github.com/owner/repository/actions/runs/7006", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
      const result = {
        mode: "issue", summary: "Manual triage.", type: "bug", priority: "p3", labels: [], actionable: true,
        missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual", comment: "Thanks."
      };
      const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
      const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
      let updatedAt = context.issue.updatedAt;
      let labels = [];
      let markerPublished = false;
      const restoreGitHub = replaceGitHubMethods({
        async getIssue() { return { number: 7, title: "Report", body: "Details", state: "open", updated_at: updatedAt, user: { id: 1, login: "reporter", type: "User" }, labels }; },
        async ensureLabels() {},
        async replaceManagedLabels(_number, desiredLabels) {
          ({ updatedAt, labels } = fixture.mutate(desiredLabels));
        },
        async upsertMarkerComment() { markerPublished = true; }
      });
      try {
        process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
        process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
        const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256 });
        await assert.rejects(
          publishIssue({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
          fixture.error
        );
        assert.equal(markerPublished, false);
      } finally {
        restoreGitHub();
        if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
        else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
        if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
        else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
        await rm(artifactDirectory, { recursive: true, force: true });
      }
    });
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
      defaultBranch: config.repository.defaultBranch, target: { kind: "issue", number: 7 },
      issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "Repair the documentation.", changedSummary: "Adds the missing repair guidance.",
      risk: "low", targetKind: "issue", targetNumber: 7, testsRun: [], readyForReview: true, noChangeReason: null
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

function pullRepairContext({ configSha256, headSha, baseSha = "b".repeat(40), runId = "7001", authorizationMode = "owner" }) {
  const pull = {
    number: 42,
    title: "Repair this change",
    body: "The current repair evidence.",
    user: { login: "pull-author" },
    html_url: "https://example.test/pull/42"
  };
  const comments = [{
    body: "Please repair this safely.",
    created_at: "2026-08-10T09:00:00Z",
    user: { login: "repository-owner" }
  }];
  return {
    mode: "fix",
    repository: "owner/repository",
    configSha256,
    runId,
    authorizationMode,
    baseSha: headSha,
    defaultBranch: config.repository.defaultBranch,
    target: {
      kind: "pull_request",
      number: 42,
      headRef: "feature/repair",
      headSha,
      headRepository: "owner/repository",
      baseRef: config.repository.defaultBranch,
      baseSha,
      baseRepository: "owner/repository",
      subjectSha256: frozenPullRepairSubjectSha256(pull, comments)
    },
    pullRequest: frozenPullRepairSubject(pull, comments)
  };
}

function liveRepairPull(context, overrides = {}) {
  const target = context.target;
  return {
    number: target.number,
    state: "open",
    draft: false,
    title: context.pullRequest.title,
    body: context.pullRequest.body,
    user: { login: context.pullRequest.author },
    html_url: context.pullRequest.url,
    labels: [],
    head: { ref: target.headRef, sha: target.headSha, repo: { full_name: target.headRepository } },
    base: { ref: target.baseRef, sha: target.baseSha, repo: { full_name: target.baseRepository } },
    ...overrides
  };
}

function liveRepairComments(context, overrides = undefined) {
  if (overrides !== undefined) return overrides;
  return context.pullRequest.comments.map((comment) => ({
    body: comment.body,
    created_at: comment.createdAt,
    user: { login: comment.author }
  }));
}

function pullRepairResult() {
  return {
    mode: "fix",
    summary: "Repair the existing pull request.",
    risk: "low",
    targetKind: "pull_request",
    targetNumber: 42,
    changedSummary: "Adds the missing regression coverage.",
    testsRun: [{ command: "git diff --check", result: "passed" }],
    readyForReview: true,
    noChangeReason: null
  };
}

test("owner-commanded PR repair adds one App commit to the existing head and fails closed on push rejection", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-pr-repair-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-pr-repair-artifact-"));
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const configSha256 = "2".repeat(64);
  let liveHead;
  let pushes = 0;
  let createPullCalls = 0;
  let rejectPush = false;
  const failureComments = [];
  try {
    await writeFile(path.join(repository, "README.md"), "# Example\n", "utf8");
    git(repository, ["init", "-q", "-b", "feature/repair"]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "initial PR head"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]);
    liveHead = headSha;
    await writeFile(path.join(repository, "README.md"), "# Example\n\nRegression covered.\n", "utf8");
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", "HEAD"], { cwd: repository });
    await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
    git(repository, ["checkout", "--", "README.md"]);
    const context = pullRepairContext({ configSha256, headSha });
    context.target.reviewThreadIds = ["PRRT_thread"];
    const result = { ...pullRepairResult(), resolvedReviewThreadIds: ["PRRT_thread"] };
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "fix",
      context,
      result,
      configSha256,
      patch: { valid: true, fileName: "patch.diff", sha256: sha256(patch), files: ["README.md"] }
    });
    const restoreGitHub = replaceGitHubMethods({
      async getPull() {
        return liveRepairPull(context, {
          head: { ref: context.target.headRef, sha: liveHead, repo: { full_name: context.repository } }
        });
      },
      async listIssueComments() { return liveRepairComments(context); },
      async getBranch() { return { protected: false, commit: { sha: liveHead } }; },
      async createPull() { createPullCalls += 1; throw new Error("must not create a second pull request"); },
      async updateIssue() { throw new Error("must not close or mutate an issue"); },
      async enableAutoMerge() { throw new Error("must not enable auto-merge"); },
      async resolveReviewThread(threadId) { assert.equal(threadId, "PRRT_thread"); },
      async listPullReviewThreads() { return [{ id: "PRRT_thread", isResolved: true }]; },
      async upsertMarkerComment(number, marker, body, authorIdentity) {
        if (!rejectPush) throw new Error("successful PR repair should not publish a failure comment");
        failureComments.push({ number, marker, body, authorIdentity });
      }
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      process.chdir(repository);
      const repair = await publishFix({
        artifactDirectory,
        config,
        configSha256,
        ...integrity,
        token: "token",
        prRepairGit: {
          configureAutomationIdentity() {
            git(repository, ["config", "user.name", identity.login]);
            git(repository, ["config", "user.email", `${identity.id}+codekeeper@users.noreply.github.com`]);
          },
          createCommitOnCurrentHead,
          pushHeadToBranch(branch) {
            assert.equal(branch, context.target.headRef);
            if (rejectPush) throw new Error("non-fast-forward update rejected");
            pushes += 1;
            liveHead = git(repository, ["rev-parse", "HEAD"]);
            return liveHead;
          }
        }
      });
      assert.equal(repair.updated, true);
      assert.deepEqual(repair.resolvedReviewThreadIds, ["PRRT_thread"]);
      assert.equal(repair.previousHeadSha, headSha);
      assert.equal(repair.headSha, liveHead);
      assert.equal(pushes, 1);
      assert.equal(createPullCalls, 0);
      assert.equal(git(repository, ["rev-parse", "HEAD^"]), headSha);
      assert.equal(git(repository, ["rev-list", "--count", `${headSha}..HEAD`]), "1");
      assert.equal(git(repository, ["branch", "--show-current"]), "feature/repair");

      git(repository, ["reset", "--hard", headSha]);
      liveHead = headSha;
      rejectPush = true;
      await assert.rejects(
        publishFix({
          artifactDirectory,
          config,
          configSha256,
          ...integrity,
          token: "token",
          prRepairGit: {
            configureAutomationIdentity() {},
            createCommitOnCurrentHead,
            pushHeadToBranch() { throw new Error("non-fast-forward update rejected"); }
          }
        }),
        /non-fast-forward update rejected/
      );
      assert.equal(pushes, 1);
      assert.equal(createPullCalls, 0);
      assert.equal(failureComments.length, 1);
      assert.equal(failureComments[0].number, context.target.number);
      assert.equal(failureComments[0].marker, fixRunMarker(context.runId));
      assert.deepEqual(failureComments[0].authorIdentity, identity);
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

test("PR repair rejects changed, stale-evidence, paused, forked, draft, closed, retargeted, and protected targets", async (t) => {
  const cases = [
    ["closed", (pull) => ({ ...pull, state: "closed" }), /not open/],
    ["draft", (pull) => ({ ...pull, draft: true }), /is a draft/],
    ["stale head", (pull) => ({ ...pull, head: { ...pull.head, sha: "c".repeat(40) } }), /head SHA changed/],
    ["stale repair evidence", (pull) => ({ ...pull, body: "The PR body changed after implementation started." }), /repair evidence changed/],
    ["stale repair comment", (pull) => pull, /repair evidence changed/, undefined, [{
      body: "A new comment changed the requested repair.",
      created_at: "2026-08-10T09:05:00Z",
      user: { login: "repository-owner" }
    }]],
    ["fork", (pull) => ({ ...pull, head: { ...pull.head, repo: { full_name: "fork/repository" } } }), /head repository changed/],
    ["retargeted", (pull) => ({ ...pull, base: { ...pull.base, ref: "release" } }), /base branch changed/],
    ["base moved", (pull) => ({ ...pull, base: { ...pull.base, sha: "d".repeat(40) } }), /base SHA changed/],
    ["paused owner repair", (pull) => ({ ...pull, labels: [{ name: "codekeeper:paused" }] }), /paused/, undefined, undefined, "owner", 0],
    ["paused automatic repair", (pull) => ({ ...pull, labels: [{ name: "codekeeper:paused" }] }), /paused/, undefined, undefined, "policy", 0],
    ["protected", (pull) => pull, /is protected/, { protected: true }],
    ["branch moved", (pull) => pull, /head branch moved/, { protected: false, commit: { sha: "e".repeat(40) } }]
  ];
  for (const [name, mutate, expected, branchOverride, commentsOverride, authorizationMode = "owner", expectedComments = 1] of cases) {
    await t.test(name, async () => {
      const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-pr-repair-negative-"));
      const configSha256 = "3".repeat(64);
      const context = pullRepairContext({ configSha256, headSha: "a".repeat(40), runId: `negative-${name}`, authorizationMode });
      const patch = Buffer.from("not reached");
      await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
      const integrity = await writeSealedArtifact(artifactDirectory, {
        mode: "fix",
        context,
        result: pullRepairResult(),
        configSha256,
        patch: { valid: true, fileName: "patch.diff", sha256: sha256(patch), files: ["README.md"] }
      });
      const comments = [];
      let createPullCalls = 0;
      const restoreGitHub = replaceGitHubMethods({
        async getPull() { return mutate(liveRepairPull(context)); },
        async listIssueComments() { return liveRepairComments(context, commentsOverride); },
        async getBranch() { return branchOverride ?? { protected: false, commit: { sha: context.target.headSha } }; },
        async createPull() { createPullCalls += 1; },
        async upsertMarkerComment(number, marker, body, authorIdentity) {
          comments.push({ number, marker, body, authorIdentity });
        }
      });
      const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
      const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
      try {
        process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
        process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
        await assert.rejects(
          publishFix({
            artifactDirectory,
            config,
            configSha256,
            ...integrity,
            token: "token",
            prRepairGit: {
              configureAutomationIdentity() { throw new Error("must not configure git"); },
              createCommitOnCurrentHead() { throw new Error("must not commit"); },
              pushHeadToBranch() { throw new Error("must not push"); }
            }
          }),
          expected
        );
        assert.equal(createPullCalls, 0);
        assert.equal(comments.length, expectedComments);
        if (expectedComments > 0) {
          assert.equal(comments[0].number, context.target.number);
          assert.equal(comments[0].marker, fixRunMarker(context.runId));
          assert.deepEqual(comments[0].authorIdentity, identity);
        }
      } finally {
        restoreGitHub();
        if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
        else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
        if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
        else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
        await rm(artifactDirectory, { recursive: true, force: true });
      }
    });
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
    const context = { mode: "audit", repository: "owner/repository", configSha256, baseSha, runUrl: "https://example.test/run", repairAuthorized: false };
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
  const auditConfig = structuredClone(config);
  auditConfig.audit.repair.enabled = true;
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
    const context = { mode: "audit", repository: "owner/repository", configSha256, baseSha, runUrl: "https://example.test/run", repairAuthorized: true };
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
      artifactConfig: auditConfig,
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
      head: { ref: repairBranch(auditConfig, "audit", repairFingerprint), repo: { full_name: context.repository } },
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
        publishAudit({ artifactDirectory, config: auditConfig, configSha256, ...integrity, token: "token" }),
        /connection lost after repair notification/
      );
      await publishAudit({ artifactDirectory, config: auditConfig, configSha256, ...integrity, token: "token" });
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
      defaultBranch: config.repository.defaultBranch, target: { kind: "issue", number: 7 },
      issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "Repair the documentation.", changedSummary: "Adds the missing repair guidance.",
      risk: "low", targetKind: "issue", targetNumber: 7, testsRun: [], readyForReview: true, noChangeReason: null
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
      target: { kind: "issue", number: 7 },
      issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "No change is safe.", changedSummary: "",
      risk: "low", targetKind: "issue", targetNumber: 7, testsRun: [], readyForReview: false, noChangeReason: "No valid repair was produced."
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
      defaultBranch: config.repository.defaultBranch, target: { kind: "issue", number: 7 },
      issue: { number: 7, title: "Repair", updatedAt: "2026-08-05T10:00:00Z" }
    };
    const result = {
      mode: "fix", summary: "Repair the documentation.", changedSummary: "Adds the missing repair guidance.",
      risk: "low", targetKind: "issue", targetNumber: 7, testsRun: [], readyForReview: true, noChangeReason: null
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
      const context = { mode: "audit", repository: "owner/repository", configSha256: contextConfigSha256, repairAuthorized: false };
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

test("publication rejects a changed trusted-default agent profile before GitHub access", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-profile-stale-artifact-"));
  const liveRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-profile-stale-live-"));
  const configSha256 = "4".repeat(64);
  let githubAccessed = false;
  const restoreGitHub = replaceGitHubMethods({
    async getIssue() { githubAccessed = true; throw new Error("GitHub must not be accessed"); }
  });
  try {
    const context = {
      mode: "issue",
      repository: "owner/repository",
      configSha256,
      issue: { number: 7, updatedAt: "2026-08-05T10:00:00Z" },
      existingOpenIssues: []
    };
    const result = {
      mode: "issue", summary: "Ready for triage.", type: "bug", priority: "p3", labels: [], actionable: true,
      missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual", comment: "Thanks."
    };
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256 });
    const liveProfile = path.join(liveRoot, AGENT_PROFILE_PATHS.issue);
    await mkdir(path.dirname(liveProfile), { recursive: true });
    await writeFile(liveProfile, "# Changed after preparation\n", "utf8");
    await assert.rejects(
      publishIssueProduction({
        artifactDirectory,
        config,
        configSha256,
        ...integrity,
        agentProfilePath: liveProfile,
        token: "token"
      }),
      /Agent profile changed after preparation/
    );
    assert.equal(githubAccessed, false);
  } finally {
    restoreGitHub();
    await rm(artifactDirectory, { recursive: true, force: true });
    await rm(liveRoot, { recursive: true, force: true });
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
