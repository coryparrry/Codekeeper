import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient, isOwnedMarkerComment, resolveGraphqlUrl } from "../src/lib/github.mjs";
import { AGENT_PROFILE_BUNDLE_FILE, AGENT_PROFILE_PATHS } from "../src/lib/agent-profiles.mjs";
import { createCommitOnCurrentHead } from "../src/lib/git.mjs";
import { automaticRepairMarker, deferredReviewMarker, deferredReviewFingerprint, findingFingerprint, findingMarker, fixRunMarker, repairMarker, repairNotificationMarker, reviewFeedbackReplyMarker, sha256 } from "../src/lib/markers.mjs";
import { frozenPullRepairReviewThreads, frozenPullRepairSubject, frozenPullRepairSubjectSha256 } from "../src/lib/pr-repair.mjs";
import { completeReviewFeedback } from "../src/lib/review-feedback.mjs";
import { evaluateAutoMerge, reviewLabels } from "../src/lib/policy.mjs";
import {
  isTrustedMaintenanceFindingIssue,
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

async function automaticRepairReviewFixture() {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-review-cheap-repair-test-"));
  const configSha256 = "e".repeat(64);
  const reviewConfig = structuredClone(config);
  reviewConfig.merge.enabled = true;
  reviewConfig.review.autoRepair = true;
  const frozenFeedback = {
    sourceKey: "review_comment:41", kind: "review_comment", author: "reviewer",
    body: "Please make this repair.", bodySha256: sha256("Please make this repair."),
    url: "https://github.test/comment/41",
    state: "commented", threadId: "PRRT_thread", rootCommentId: 41,
    resolved: false, outdated: false, path: "README.md", line: 1
  };
  const headSha = "1".repeat(40);
  const baseSha = "2".repeat(40);
  const context = {
    mode: "review", repository: "owner/repository", configSha256, runId: "7004",
    runUrl: "https://github.com/owner/repository/actions/runs/7004",
    pullRequest: {
      number: 7, headSha, baseSha,
      diff: { truncated: false, disabled: false }, reviewFeedbackFrozen: true,
      reviewFeedback: [frozenFeedback]
    }
  };
  const result = {
    mode: "review", summary: "Queue the cheap repair.", risk: "low", labels: [],
    blockingFindings: [], nonBlockingFindings: [],
    reviewFeedback: [{
      problemKey: "cheap-repair", disposition: "fix_if_cheap", type: "bug",
      explanation: "Apply the bounded repair.", validation: "The repair remains applicable.",
      sourceKeys: [frozenFeedback.sourceKey], threadIds: [frozenFeedback.threadId]
    }],
    tests: { adequate: true, notes: "Covered." }, mergeRecommendation: "auto", noActionReason: null
  };
  const pull = {
    number: 7, node_id: "PR_7", state: "open", draft: false, auto_merge: null, labels: [],
    user: { login: identity.login, type: "Bot" },
    head: { sha: headSha, ref: "automation/codekeeper/cheap-repair", repo: { full_name: context.repository } },
    base: { sha: baseSha, ref: reviewConfig.repository.defaultBranch, repo: { full_name: context.repository } }
  };
  const repair = {
    state: "Automatic repair was dispatched.",
    head: "0".repeat(40),
    comments: []
  };
  const restoreGitHub = replaceGitHubMethods({
    async getPull() { return structuredClone(pull); },
    async listPullFiles() { return [{ filename: "README.md", additions: 1, deletions: 0 }]; },
    async listPullReviews() { return []; },
    async listPullReviewThreads() {
      return [{
        id: frozenFeedback.threadId, isResolved: false, isOutdated: false,
        comments: { nodes: [{
          databaseId: 41, body: frozenFeedback.body, url: frozenFeedback.url,
          path: frozenFeedback.path, line: frozenFeedback.line, originalLine: frozenFeedback.line,
          author: { login: frozenFeedback.author }
        }] }
      }];
    },
    async listIssueComments() {
      return [{
        body: `${repair.state}\n${automaticRepairMarker(repair.head)}`,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      }, ...repair.comments];
    }
  });
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
  process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
  const integrity = await writeSealedArtifact(artifactDirectory, {
    mode: "review", context, result, configSha256, artifactConfig: reviewConfig
  });
  return {
    artifactDirectory, configSha256, context, headSha, integrity, pull, repair, result, reviewConfig,
    publish(artifactIntegrity = integrity) {
      return publishReview({
        artifactDirectory, config: reviewConfig, configSha256, ...artifactIntegrity, token: "unused", dryRun: true
      });
    },
    async cleanup() {
      restoreGitHub();
      if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
      else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
      if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
      else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  };
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
    sourceKeys: ["review_comment:41"],
    threadIds: ["PRRT_thread"]
  };
  const fingerprint = deferredReviewFingerprint(context.repository, 7, feedback.sourceKeys);
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
  assert.deepEqual(calls.created[0].labels, ["deferred", "testing"]);
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
  feedback.problemKey = "renamed-timeout-coverage";
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

test("deferred feedback identity stays per-source when the model regroups findings", async () => {
  const context = {
    repository: "owner/repository",
    runUrl: "https://github.com/owner/repository/actions/runs/9",
    pullRequest: {
      number: 7,
      url: "https://github.com/owner/repository/pull/7",
      reviewFeedback: [
        { sourceKey: "review:41", author: "reviewer", url: "https://github.com/owner/repository/pull/7#pullrequestreview-41" },
        { sourceKey: "review:42", author: "reviewer", url: "https://github.com/owner/repository/pull/7#pullrequestreview-42" }
      ]
    }
  };
  const existing = [];
  const created = [];
  const updated = [];
  const github = {
    async listMaintenanceIssues() { return existing; },
    async ensureLabels() {},
    async createIssue(input) {
      const issue = {
        ...input,
        number: 50 + created.length,
        html_url: `https://github.com/owner/repository/issues/${50 + created.length}`,
        state: "open",
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      };
      created.push(issue);
      return issue;
    },
    async updateIssue(number, input) {
      updated.push({ number, input });
      const issue = existing.find((candidate) => candidate.number === number);
      Object.assign(issue, input);
      return issue;
    },
    async replaceManagedLabels() {},
    async upsertMarkerComment() {}
  };
  const grouped = {
    problemKey: "grouped",
    disposition: "defer",
    type: "testing",
    explanation: "Track both sources.",
    validation: "Both remain current.",
    sourceKeys: ["review:41", "review:42"],
    threadIds: []
  };

  await upsertDeferredReviewFeedback({
    github,
    context,
    result: { reviewFeedback: [grouped] },
    config,
    automationIdentity: identity
  });
  assert.equal(created.length, 2);

  await upsertDeferredReviewFeedback({
    github,
    context,
    result: { reviewFeedback: [
      { ...grouped, problemKey: "split-41", sourceKeys: ["review:41"] },
      { ...grouped, problemKey: "split-42", sourceKeys: ["review:42"] }
    ] },
    config,
    automationIdentity: identity
  });
  assert.equal(created.length, 2);
  assert.equal(updated.length, 2);
});

test("deferred review issues close when their source is no longer deferred", async () => {
  const sourceKeys = ["review_comment:41"];
  const fingerprint = deferredReviewFingerprint("owner/repository", 7, sourceKeys);
  const marker = deferredReviewMarker(fingerprint);
  const updates = [];
  const github = {
    async listMaintenanceIssues() {
      return [{
        number: 51,
        state: "open",
        body: `## Origin

- Pull request: [#7](https://github.com/owner/repository/pull/7)

${marker}`,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      }];
    },
    async updateIssue(number, changes) { updates.push({ number, changes }); }
  };

  const published = await upsertDeferredReviewFeedback({
    github,
    context: {
      repository: "owner/repository",
      pullRequest: {
        number: 7,
        url: "https://github.com/owner/repository/pull/7",
        reviewFeedback: []
      }
    },
    result: { reviewFeedback: [] },
    config,
    automationIdentity: identity
  });

  assert.equal(updates[0].number, 51);
  assert.equal(updates[0].changes.state, "closed");
  assert.equal(updates[0].changes.state_reason, "completed");
  assert.match(updates[0].changes.body, /deferred-reconciled/);
  assert.ok(updates[0].changes.body.endsWith(marker));
  assert.deepEqual(published, [{ fingerprint, state: "closed", issueNumber: 51 }]);
});

test("owner-requested deferral does not reconcile unrelated deferred issues", async () => {
  const updates = [];
  const github = {
    async listMaintenanceIssues() {
      return [{
        number: 51,
        state: "open",
        body: `## Origin

- Pull request: [#7](https://github.com/owner/repository/pull/7)

${deferredReviewMarker("f".repeat(64))}`,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      }];
    },
    async updateIssue(number, changes) { updates.push({ number, changes }); }
  };

  assert.deepEqual(await upsertDeferredReviewFeedback({
    github,
    context: {
      repository: "owner/repository",
      pullRequest: {
        number: 7,
        url: "https://github.com/owner/repository/pull/7",
        reviewFeedback: []
      }
    },
    result: { reviewFeedback: [] },
    config,
    automationIdentity: identity,
    ownerRequested: true
  }), []);
  assert.deepEqual(updates, []);
});

test("automatically reconciled deferred issues reopen when the source is deferred again", async () => {
  const sourceKeys = ["review_comment:41"];
  const fingerprint = deferredReviewFingerprint("owner/repository", 7, sourceKeys);
  const marker = deferredReviewMarker(fingerprint);
  const updates = [];
  const github = {
    async listMaintenanceIssues() {
      return [{
        number: 51,
        state: "closed",
        body: `## Origin

- Pull request: [#7](https://github.com/owner/repository/pull/7)

<!-- codekeeper:deferred-reconciled -->
${marker}`,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      }];
    },
    async ensureLabels() {},
    async updateIssue(number, changes) {
      updates.push({ number, changes });
      return { number, html_url: "https://github.com/owner/repository/issues/51", ...changes };
    },
    async replaceManagedLabels() {},
    async upsertReviewReply() {}
  };
  const feedback = {
    problemKey: "defer-again",
    disposition: "defer",
    type: "testing",
    explanation: "The current source needs deferred work again.",
    validation: "The source is actionable again.",
    sourceKeys,
    threadIds: ["PRRT_thread"]
  };

  const published = await upsertDeferredReviewFeedback({
    github,
    context: {
      repository: "owner/repository",
      runUrl: "https://github.com/owner/repository/actions/runs/9",
      pullRequest: {
        number: 7,
        url: "https://github.com/owner/repository/pull/7",
        reviewFeedback: [{ sourceKey: "review_comment:41", rootCommentId: 41, author: "reviewer", url: "https://github.com/owner/repository/pull/7#discussion_r41" }]
      }
    },
    result: { reviewFeedback: [feedback] },
    config,
    automationIdentity: identity
  });

  assert.equal(updates[0].changes.state, "open");
  assert.equal(updates[0].changes.state_reason, null);
  assert.doesNotMatch(updates[0].changes.body, /deferred-reconciled/);
  assert.deepEqual(published, [{ fingerprint, state: "reopened", issueNumber: 51 }]);
});

test("maintenance issue fingerprints require the configured App author and marker comment", () => {
  const marker = findingMarker("b".repeat(64));
  const issue = {
    body: `Trusted maintenance finding\n${marker}`,
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  };
  const options = { marker, botLogin: identity.login, botId: identity.id };
  const comments = [{ body: marker, user: issue.user }];
  assert.equal(isTrustedMaintenanceFindingIssue(issue, comments, options), true);
  assert.equal(isTrustedMaintenanceFindingIssue(issue, [], options), false);
  assert.equal(isTrustedMaintenanceFindingIssue(issue, [{ ...comments[0], user: { login: "person", id: 123456, type: "User" } }], options), false);
  assert.equal(isTrustedMaintenanceFindingIssue({ ...issue, user: { login: "person", id: 123456, type: "User" } }, comments, options), false);
  assert.equal(isTrustedMaintenanceFindingIssue({ ...issue, body: `${issue.body}\nuntrusted suffix` }, comments, options), false);
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
    { commentId: 41, disposition: "ignore" },
    { commentId: 43, disposition: "fix_now" }
  ]);
  assert.match(replies[0].body, /^No action:/);
  assert.match(replies[1].body, /^No action:/);
  assert.match(replies[2].body, /^Fix now:/);
});

test("reclassified review-body feedback updates its PR-level deferred reply", async () => {
  const comments = [];
  const retired = [];
  const fingerprint = deferredReviewFingerprint("owner/repository", 7, "review:99");
  const context = {
    repository: "owner/repository",
    pullRequest: {
      number: 7,
      reviewFeedback: [
        { sourceKey: "review:99", kind: "review", author: "reviewer" }
      ]
    }
  };
  const result = { reviewFeedback: [{
    problemKey: "review-body-follow-up",
    disposition: "fix_now",
    explanation: "The current review-body finding is valid.",
    validation: "A regression test now covers it.",
    sourceKeys: ["review:99"]
  }] };

  const published = await replyToReviewFeedback({
    github: {
      async upsertMarkerComment(number, marker, body) {
        comments.push({ number, marker, body });
      },
      async retireReviewFeedbackReply(number, marker, body) {
        retired.push({ number, marker, body });
      }
    },
    context,
    result,
    automationIdentity: identity,
    retiredFingerprints: [fingerprint]
  });

  assert.equal(comments.length, 1);
  assert.equal(retired.length, 0);
  assert.match(comments[0].body, /^Fix now:/);
  assert.equal(published[0].commentId, null);
  assert.equal(published[0].disposition, "fix_now");
});

test("complete feedback publication retires disappeared PR-level replies", async () => {
  const fingerprint = deferredReviewFingerprint("owner/repository", 7, "review:99");
  const marker = reviewFeedbackReplyMarker(fingerprint);
  const updates = [];
  const published = await replyToReviewFeedback({
    github: {
      async retireReviewFeedbackReply(number, retiredMarker, body) {
        updates.push({ number, marker: retiredMarker, body });
      }
    },
    context: {
      repository: "owner/repository",
      pullRequest: { number: 7, reviewFeedback: [] }
    },
    result: { reviewFeedback: [] },
    automationIdentity: identity,
    retiredFingerprints: [fingerprint]
  });

  assert.equal(updates[0].number, 7);
  assert.match(updates[0].body, /^No longer current:/);
  assert.equal(updates[0].marker, marker);
  assert.equal(published[0].disposition, "retired");
});

test("review publication rejects feedback that changed after preparation", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-stale-feedback-test-"));
  const configSha256 = "f".repeat(64);
  const frozenFeedback = {
    sourceKey: "review_comment:41", kind: "review_comment", author: "reviewer",
    body: "Please add a timeout test.", bodySha256: sha256("Please add a timeout test."),
    url: "https://github.test/comment/41",
    state: "commented", threadId: "PRRT_thread", rootCommentId: 41,
    resolved: false, outdated: false, path: "README.md", line: 1
  };
  const context = {
    mode: "review", repository: "owner/repository", configSha256, runId: "7000",
    runUrl: "https://github.com/owner/repository/actions/runs/7000",
    pullRequest: {
      number: 7, headSha: "head", baseSha: "base",
      diff: { truncated: false, disabled: false }, reviewFeedbackFrozen: true,
      reviewFeedback: [frozenFeedback]
    }
  };
  const result = {
    mode: "review", summary: "Defer the valid follow-up.", risk: "low", labels: [],
    blockingFindings: [], nonBlockingFindings: [],
    reviewFeedback: [{
      problemKey: "timeout-test", disposition: "defer", type: "testing",
      explanation: "Add timeout coverage.", validation: "Coverage is still absent.",
      sourceKeys: [frozenFeedback.sourceKey], threadIds: [frozenFeedback.threadId]
    }],
    tests: { adequate: true, notes: "Covered." }, mergeRecommendation: "manual", noActionReason: null
  };
  const pull = {
    number: 7, state: "open", draft: false, labels: [],
    head: { sha: "head", ref: "feature", repo: { full_name: context.repository } },
    base: { sha: "base", ref: config.repository.defaultBranch, repo: { full_name: context.repository } }
  };
  const restoreGitHub = replaceGitHubMethods({
    async getPull() { return structuredClone(pull); },
    async listPullFiles() { return [{ filename: "README.md", additions: 1, deletions: 0 }]; },
    async listPullReviews() { return []; },
    async listPullReviewThreads() {
      return [{
        id: frozenFeedback.threadId, isResolved: true, isOutdated: false,
        comments: { nodes: [{
          databaseId: 41, body: frozenFeedback.body, url: frozenFeedback.url,
          path: frozenFeedback.path, line: frozenFeedback.line, originalLine: frozenFeedback.line,
          author: { login: frozenFeedback.author }
        }] }
      }];
    }
  });
  try {
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "review", context, result, configSha256 });
    await assert.rejects(
      publishReview({ artifactDirectory, config, configSha256, ...integrity, token: "unused", dryRun: true }),
      /review feedback changed after preparation/
    );

    context.pullRequest.reviewFeedback = [];
    result.reviewFeedback = [];
    const emptyIntegrity = await writeSealedArtifact(artifactDirectory, { mode: "review", context, result, configSha256 });
    await assert.rejects(
      publishReview({ artifactDirectory, config, configSha256, ...emptyIntegrity, token: "unused", dryRun: true }),
      /review feedback changed after preparation/
    );
  } finally {
    restoreGitHub();
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("frozen review feedback detects edits past the prompt body limit", async () => {
  const prefix = "x".repeat(7_000);
  const feedbackFor = (body) => completeReviewFeedback({
    async listPullReviews() { return []; },
    async listPullReviewThreads() {
      return [{
        id: "PRRT_thread", isResolved: false, isOutdated: false,
        comments: { nodes: [{
          databaseId: 41, body, url: "https://github.test/comment/41",
          path: "README.md", line: 1, originalLine: 1,
          author: { login: "reviewer" }
        }] }
      }];
    }
  }, 7, config);

  const frozen = await feedbackFor(`${prefix}a`);
  const edited = await feedbackFor(`${prefix}b`);
  assert.equal(frozen[0].body, edited[0].body);
  assert.notDeepEqual(frozen, edited);
});

test("review feedback inventory cannot be built without repository policy", async () => {
  await assert.rejects(
    completeReviewFeedback({
      async listPullReviews() { throw new Error("must reject before GitHub reads"); },
      async listPullReviewThreads() { throw new Error("must reject before GitHub reads"); }
    }, 7),
    /requires repository owner policy/
  );
});

test("conditional GitHub mutation blocks repair dispatch after feedback changes", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-repair-feedback-race-test-"));
  const configSha256 = "9".repeat(64);
  const reviewConfig = structuredClone(config);
  reviewConfig.review.autoRepair = true;
  const headSha = "a".repeat(40);
  const baseSha = "b".repeat(40);
  const frozenFeedback = {
    sourceKey: "review_comment:41", kind: "review_comment", author: "reviewer",
    body: "Repair this problem.", bodySha256: sha256("Repair this problem."),
    url: "https://github.test/comment/41", state: "commented", threadId: "PRRT_thread",
    rootCommentId: 41, resolved: false, outdated: false, path: "README.md", line: 1
  };
  const context = {
    mode: "review", repository: "owner/repository", configSha256, runId: "7009",
    runUrl: "https://github.com/owner/repository/actions/runs/7009",
    pullRequest: {
      number: 7, headSha, baseSha, diff: { truncated: false, disabled: false },
      reviewFeedbackFrozen: true, reviewFeedback: [frozenFeedback]
    }
  };
  const result = {
    mode: "review", summary: "Repair the current feedback.", risk: "low", labels: [],
    blockingFindings: [], nonBlockingFindings: [],
    reviewFeedback: [{
      problemKey: "repair-race", disposition: "fix_now", type: "bug",
      explanation: "Repair the current feedback.", validation: "The feedback is still active.",
      sourceKeys: [frozenFeedback.sourceKey], threadIds: [frozenFeedback.threadId]
    }],
    tests: { adequate: true, notes: "Covered." }, mergeRecommendation: "manual", noActionReason: null
  };
  const pull = {
    number: 7, node_id: "PR_7", state: "open", draft: false, auto_merge: null, labels: [],
    user: { login: "contributor", type: "User" },
    head: { sha: headSha, ref: "feature/repair", repo: { full_name: context.repository } },
    base: { sha: baseSha, ref: reviewConfig.repository.defaultBranch, repo: { full_name: context.repository } }
  };
  let resolved = false;
  let dispatches = 0;
  let dispatchAttempts = 0;
  const issueComments = [];
  const restoreGitHub = replaceGitHubMethods({
    async getPull() { return structuredClone(pull); },
    async listPullFiles() { return [{ filename: "README.md", additions: 1, deletions: 0 }]; },
    async listPullReviews() { return []; },
    async listPullReviewThreads() {
      return [{
        id: frozenFeedback.threadId, isResolved: resolved, isOutdated: false,
        comments: { nodes: [{
          databaseId: 41, body: frozenFeedback.body, url: frozenFeedback.url,
          path: frozenFeedback.path, line: frozenFeedback.line, originalLine: frozenFeedback.line,
          author: { login: frozenFeedback.author }
        }] }
      }];
    },
    async listMaintenanceIssues() { return []; },
    async listIssueComments() { return structuredClone(issueComments); },
    async createComment(_number, body) {
      await this.assertPullMutationCurrent();
      const comment = {
        id: 99 + issueComments.length,
        body,
        created_at: new Date().toISOString(),
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      };
      issueComments.push(comment);
      return structuredClone(comment);
    },
    async updateComment(commentId, body) {
      const comment = issueComments.find((item) => item.id === commentId);
      comment.body = body;
      comment.updated_at = new Date().toISOString();
      return structuredClone(comment);
    },
    async ensureLabels() {},
    async replaceManagedLabels() {},
    async upsertReviewReply() {},
    async addLabels(number, labels) {
      pull.labels.push(...labels.map((name) => ({ name })));
      this.advancePullMutationState("POST", this.repoPath(`/issues/${number}/labels`), { labels });
    },
    async removeLabel(_number, label) {
      pull.labels = pull.labels.filter((item) => item.name !== label);
    },
    async createRepositoryDispatch() {
      dispatchAttempts += 1;
      if (dispatchAttempts === 1) resolved = true;
      await this.assertPullMutationCurrent();
      dispatches += 1;
    },
    async rollbackPullLabel(_number, label) {
      pull.labels = pull.labels.filter((item) => item.name !== label);
    }
  });
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "review", context, result, configSha256, artifactConfig: reviewConfig
    });
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused" }),
      /review feedback changed after preparation/
    );
    assert.equal(dispatches, 0);
    assert.equal(pull.labels.some((label) => label.name === "auto repaired"), false);

    resolved = false;
    const retried = await publishReview({
      artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused"
    });
    assert.equal(retried.automaticRepair.dispatched, true);
    assert.equal(dispatches, 1);
    assert.equal(pull.labels.some((label) => label.name === "auto repaired"), true);
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("human-authored automation markers remain review feedback", async () => {
  const marker = "<!-- codekeeper:review-feedback-reply=" + "a".repeat(64) + " -->";
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = "codekeeper-app[bot]";
  try {
    const feedback = await completeReviewFeedback({
      async listPullReviews() { return []; },
      async listPullReviewThreads() {
        return [{
          id: "PRRT_thread", isResolved: false, isOutdated: false,
          comments: { nodes: [
            { databaseId: 41, body: `Human feedback\n\n${marker}`, author: { login: "reviewer" } },
            { databaseId: 42, body: `Automation reply\n\n${marker}`, author: { login: "codekeeper-app[bot]" } }
          ] }
        }];
      }
    }, 7, config);
    assert.deepEqual(feedback.map((item) => item.sourceKey), ["review_comment:41"]);
  } finally {
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
  }
});

test("fix-now feedback blocks auto-merge even when repair dispatch is disabled", () => {
  const reviewConfig = structuredClone(config);
  reviewConfig.merge.enabled = true;
  reviewConfig.review.autoRepair = false;
  const result = {
    risk: "low", labels: [], blockingFindings: [], nonBlockingFindings: [],
    reviewFeedback: [{ disposition: "fix_now" }],
    tests: { adequate: true, notes: "Covered." }, mergeRecommendation: "auto"
  };
  const decision = evaluateAutoMerge({
    config: reviewConfig,
    pullRequest: {
      number: 7, state: "open", draft: false, labels: [],
      user: { login: identity.login, type: "Bot" },
      head: { ref: "automation/codekeeper/fix-now", repo: { full_name: "owner/repository" } },
      base: { repo: { full_name: "owner/repository" } }
    },
    files: [{ filename: "README.md", additions: 1, deletions: 0 }],
    reviewResult: result, reviewContextComplete: true, automationBotLogin: identity.login
  });
  assert.equal(decision.eligible, false);
  assert.match(decision.reasons.join("\n"), /fix-now review feedback/);
  assert.ok(reviewLabels(result).includes("blocked"));
  assert.ok(!reviewLabels(result).includes("auto merge"));
});

test("a completed automatic repair consumes the pass after the pull request head changes", async () => {
  const fixture = await automaticRepairReviewFixture();
  const { artifactDirectory, configSha256, context, headSha, pull, repair, result, reviewConfig } = fixture;
  try {
    const publication = await fixture.publish();
    assert.equal(publication.autoMerge.eligible, false);
    assert.match(publication.autoMerge.reasons.join("\n"), /repair pass is already consumed/i);
    assert.equal(publication.automaticRepair.consumed, true);
    assert.equal(publication.automaticRepair.pending, false);

    pull.labels = [{ name: "auto repaired" }];
    const repeated = await fixture.publish();
    assert.equal(repeated.autoMerge.eligible, false);
    assert.match(repeated.autoMerge.reasons.join("\n"), /repair pass is already consumed/i);
    assert.equal(repeated.automaticRepair.consumed, true);
    assert.equal(repeated.automaticRepair.pending, false);

    pull.labels = [];
    repair.state = "Automatic repair dispatch is ambiguous.";
    const ambiguous = await fixture.publish();
    assert.equal(ambiguous.automaticRepair.consumed, true);
    assert.equal(ambiguous.automaticRepair.pending, false);
    assert.equal(ambiguous.automaticRepair.eligible, false);

    repair.state = "Automatic repair dispatch is pending.";
    repair.head = headSha;
    const pending = await fixture.publish();
    assert.equal(pending.automaticRepair.eligible, true);
    assert.equal(pending.automaticRepair.pending, true);

    repair.state = "Automatic repair dispatch is pending.";
    pull.labels = [];
    repair.comments = [{
      body: `<!-- codekeeper:repair-lease-expired=${"a".repeat(64)} -->\n<!-- codekeeper:repair-lease=${"b".repeat(64)} -->`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" }
    }];
    const crashed = await fixture.publish();
    assert.equal(crashed.automaticRepair.consumed, true);
    assert.equal(crashed.automaticRepair.eligible, false);

    repair.head = "0".repeat(40);
    const crashedRepairScope = sha256(JSON.stringify({
      repository: context.repository, pullNumber: pull.number, headSha: repair.head
    }));
    repair.comments = [{
      body: `<!-- codekeeper:repair-lease-active=${crashedRepairScope} -->\n<!-- codekeeper:repair-lease=${"b".repeat(64)} -->`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" }
    }];
    const crashedAfterDispatch = await fixture.publish();
    assert.equal(crashedAfterDispatch.automaticRepair.consumed, true);
    assert.equal(crashedAfterDispatch.automaticRepair.eligible, false);
    assert.equal(crashedAfterDispatch.automaticRepair.pending, false);

    repair.comments[0].body = `<!-- codekeeper:repair-lease-active=${"a".repeat(64)} -->\n<!-- codekeeper:repair-lease=${"b".repeat(64)} -->`;
    const unrelatedActiveLease = await fixture.publish();
    assert.equal(unrelatedActiveLease.automaticRepair.consumed, false);
    assert.equal(unrelatedActiveLease.automaticRepair.eligible, true);
    assert.equal(unrelatedActiveLease.automaticRepair.pending, false);

    repair.state = "Automatic repair dispatch failed.";
    const retryable = await fixture.publish();
    assert.equal(retryable.automaticRepair.consumed, false);
    assert.equal(retryable.automaticRepair.eligible, true);
    assert.equal(retryable.automaticRepair.pending, false);

    repair.state = "Automatic repair was dispatched.";
    repair.head = "0".repeat(40);
    const cleanIntegrity = await writeSealedArtifact(artifactDirectory, {
      mode: "review", context, result: { ...result, reviewFeedback: [] }, configSha256, artifactConfig: reviewConfig
    });
    const cleanReview = await fixture.publish(cleanIntegrity);
    assert.equal(cleanReview.autoMerge.eligible, true);
  } finally {
    await fixture.cleanup();
  }
});

test("a legacy pending repair marker consumes only its matching active lease", async () => {
  const fixture = await automaticRepairReviewFixture();
  const { context, headSha, pull, repair } = fixture;
  const repairScope = sha256(JSON.stringify({
    repository: context.repository, pullNumber: pull.number, headSha
  }));
  const leaseComment = (state) => ({
    body: `<!-- codekeeper:repair-lease-${state}=${repairScope} -->\n<!-- codekeeper:repair-lease=${"b".repeat(64)} -->`,
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  });
  try {
    repair.state = `Automatic repair is pending for head ${headSha}.`;
    repair.head = headSha;
    repair.comments = [leaseComment("active")];
    pull.labels = [{ name: "auto repaired" }];
    const legacyPending = await fixture.publish();
    assert.equal(legacyPending.automaticRepair.consumed, true);
    assert.equal(legacyPending.automaticRepair.eligible, false);
    assert.equal(legacyPending.automaticRepair.pending, true);
    assert.equal(legacyPending.automaticRepair.staleMarker, false);

    for (const leaseState of ["failed", "released"]) {
      repair.comments = [leaseComment(leaseState)];
      const retryable = await fixture.publish();
      assert.equal(retryable.automaticRepair.consumed, false);
      assert.equal(retryable.automaticRepair.eligible, true);
      assert.equal(retryable.automaticRepair.pending, true);
      assert.equal(retryable.automaticRepair.staleMarker, true);
    }

    repair.state = `Automatic repair is pending for head ${headSha}. Extra`;
    repair.comments = [leaseComment("active")];
    const inexactMarker = await fixture.publish();
    assert.equal(inexactMarker.automaticRepair.consumed, false);
    assert.equal(inexactMarker.automaticRepair.eligible, true);
    assert.equal(inexactMarker.automaticRepair.pending, false);
    assert.equal(inexactMarker.automaticRepair.staleMarker, true);
  } finally {
    await fixture.cleanup();
  }
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
  let refetches = 0;
  await assert.rejects(
    reconcileAutoMerge(
      {
        disableAutoMerge: async () => { throw new Error("forbidden"); },
        getPull: async () => { refetches += 1; }
      },
      { number: 7, node_id: "PR_7", auto_merge: { enabled_at: "now" } },
      config,
      { eligible: false, reasons: ["review is blocked"] }
    ),
    /Could not disable stale auto-merge/
  );
  assert.equal(refetches, 0);
});

test("ambiguous stale auto-merge disablement is accepted only after an inactive refetch", async () => {
  const ambiguous = Object.assign(new Error("response lost"), { githubMutationOutcome: "ambiguous" });
  const result = await reconcileAutoMerge(
    {
      disableAutoMerge: async () => { throw ambiguous; },
      getPull: async (number) => ({ number, auto_merge: null })
    },
    { number: 7, node_id: "PR_7", auto_merge: { enabled_at: "now" } },
    config,
    { eligible: false, reasons: ["review is blocked"] }
  );
  assert.deepEqual(result, {
    enabled: false,
    disabled: true,
    reason: "confirmed disabled after ambiguous disable request"
  });

  await assert.rejects(
    reconcileAutoMerge(
      {
        disableAutoMerge: async () => { throw ambiguous; },
        getPull: async (number) => ({ number, auto_merge: { enabled_at: "now" } })
      },
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
        if (pauseAfterEnable) pull.labels = [{ name: "paused" }];
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
    async listMaintenanceIssues() { return []; },
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
    assert.ok(provisioned.desiredLabels.includes("auto merge"));
    assert.ok(provisioned.desiredLabels.includes("manual review"));
    assert.ok(labelCalls[0].desiredLabels.includes("auto merge"));
    assert.ok(labels.desiredLabels.includes("manual review"));
    assert.ok(!labels.desiredLabels.includes("auto merge"));
    assert.match(comment.comment, /Ready for maintainer review/);
    assert.match(comment.comment, /Auto-merge is not active: GitHub rejected enablement/);
    assert.doesNotMatch(comment.comment, /Ready to merge/);
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

test("issue publication does not close a duplicate after a concurrent user comment", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-stale-test-"));
  const configSha256 = "a".repeat(64);
  const issueConfig = structuredClone(config);
  issueConfig.issues.closeExactDuplicates = true;
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7002", runUrl: "https://github.com/owner/repository/actions/runs/7002", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Exact duplicate.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: 9, duplicateConfidence: "high", implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks for the report."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let triageCommentPublished = false;
  let duplicateCommentPublished = false;
  let issueClosed = false;
  let updatedAt = context.issue.updatedAt;
  let labels = [];
  let comments = [];
  const restoreGitHub = replaceGitHubMethods({
    async getIssue(number) {
      if (number === 9) return { number, state: "open", updated_at: "2026-08-05T09:00:00Z" };
      return { number, title: "Report", state: "open", updated_at: updatedAt, labels };
    },
    async listIssueComments() { return structuredClone(comments); },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = desiredLabels.map((name) => ({ name }));
      updatedAt = "2026-08-05T10:00:30Z";
    },
    async upsertMarkerComment(_number, marker, body) {
      triageCommentPublished = true;
      const ownedUpdatedAt = "2026-08-05T10:01:00Z";
      updatedAt = "2026-08-05T10:01:30Z";
      const mutation = {
        id: 70,
        body: `${body}\n${marker}`,
        created_at: ownedUpdatedAt,
        updated_at: ownedUpdatedAt,
        user: { id: Number(identity.id), login: identity.login, type: "Bot" }
      };
      comments = [
        mutation,
        {
          id: 71,
          body: "One more detail from the reporter.",
          created_at: updatedAt,
          updated_at: updatedAt,
          user: { id: 1, login: "reporter", type: "User" }
        }
      ];
      return mutation;
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
      /comments changed while Codekeeper published/
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

test("issue publication rejects a concurrent comment sharing its mutation timestamp", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-comment-collision-test-"));
  const configSha256 = "b".repeat(64);
  const issueConfig = structuredClone(config);
  issueConfig.issues.closeExactDuplicates = true;
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7006", runUrl: "https://github.com/owner/repository/actions/runs/7006", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Exact duplicate.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: 9, duplicateConfidence: "high", implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks for the report."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let updatedAt = context.issue.updatedAt;
  let labels = [];
  let comments = [];
  let duplicateCommentPublished = false;
  let issueClosed = false;
  const restoreGitHub = replaceGitHubMethods({
    async getIssue(number) {
      if (number === 9) return { number, state: "open", updated_at: "2026-08-05T09:00:00Z" };
      return { number, title: "Report", state: "open", updated_at: updatedAt, labels };
    },
    async listIssueComments() { return structuredClone(comments); },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = desiredLabels.map((name) => ({ name }));
      updatedAt = "2026-08-05T10:00:30Z";
    },
    async upsertMarkerComment(_number, marker, body) {
      updatedAt = "2026-08-05T10:01:00Z";
      const mutation = {
        id: 70,
        body: `${body}\n${marker}`,
        created_at: updatedAt,
        updated_at: updatedAt,
        user: { id: Number(identity.id), login: identity.login, type: "Bot" }
      };
      comments = [
        mutation,
        {
          id: 71,
          body: "One more detail from the reporter.",
          created_at: updatedAt,
          updated_at: updatedAt,
          user: { id: 1, login: "reporter", type: "User" }
        }
      ];
      return mutation;
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
      /comments changed while Codekeeper published/
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

test("issue publication accepts its exact managed-label mutation and preserves a trusted deferred marker", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-label-revision-test-"));
  const configSha256 = "c".repeat(64);
  const issueConfig = structuredClone(config);
  issueConfig.issues.allowAiImplementation = true;
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7003", runUrl: "https://github.com/owner/repository/actions/runs/7003", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Ready for triage.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "ai-ready",
    decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks for the report."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let updatedAt = context.issue.updatedAt;
  let labels = [{ name: "external" }, { name: "priority p1" }, { name: "deferred" }];
  let markerPublished = false;
  const issue = () => ({
    number: 7, title: "Report", body: `Details\n${deferredReviewMarker("f".repeat(64))}`, state: "open", updated_at: updatedAt,
    html_url: "https://github.com/owner/repository/issues/7",
    user: { id: Number(identity.id), login: identity.login, type: "Bot" }, labels
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
    assert.deepEqual(labels.map((label) => label.name).sort(), ["deferred", "priority p3", "ready", "bug", "external"].sort());
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue publication closes a GitHub-linked merged pull request resolution as completed", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-resolved-test-"));
  const configSha256 = "9".repeat(64);
  const resolvedByPullRequest = {
    number: 12,
    url: "https://github.com/owner/repository/pull/12",
    mergedAt: "2026-08-13T10:00:00Z",
    repository: "owner/repository"
  };
  const context = {
    mode: "issue",
    repository: "owner/repository",
    configSha256,
    runId: "7012",
    runUrl: "https://github.com/owner/repository/actions/runs/7012",
    issue: { number: 7, title: "Report", updatedAt: "2026-08-13T11:00:00Z" },
    resolvedByPullRequest
  };
  const result = {
    mode: "issue", summary: "Resolved by pull request #12.", type: "bug", priority: "p3", labels: [], actionable: false,
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "no",
    decision: { required: false, question: "", rationale: "", options: [] }, comment: "This was resolved by pull request #12."
  };
  let closingComment = "";
  let update = null;
  const restoreGitHub = replaceGitHubMethods({
    async beginIssueMutation() { return { number: 7, title: "Report", body: "Details", labels: [] }; },
    async listMergedPullRequestsClosingIssue() { return [resolvedByPullRequest]; },
    async ensureLabels() {},
    async replaceManagedIssueLabels() {},
    async verifyIssueMutation() {},
    async upsertOwnedIssueMarker() {},
    async createOwnedIssueComment(_number, body) { closingComment = body; },
    async updateIssue(_number, changes) { update = changes; }
  });
  try {
    const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    try {
      const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256 });
      const published = await publishIssue({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
      assert.deepEqual(published.desiredLabels.sort(), ["bug", "priority p3"]);
      assert.match(closingComment, /merged pull request \[#12\]/);
      assert.deepEqual(update, { state: "closed", state_reason: "completed" });
    } finally {
      if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
      else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
      if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
      else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    }
  } finally {
    restoreGitHub();
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue publication rejects subject drift during its managed-label mutation", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-label-drift-test-"));
  const configSha256 = "d".repeat(64);
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7004", runUrl: "https://github.com/owner/repository/actions/runs/7004", issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" } };
  const result = {
    mode: "issue", summary: "Manual triage.", type: "bug", priority: "p3", labels: [], actionable: true,
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks."
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
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks."
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
      /changed while Codekeeper published/
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
        missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual",
        decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks."
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
    async getBranchTip() { return null; },
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

function pullRepairContext({ configSha256, headSha, baseSha = "b".repeat(40), runId = "7001", authorizationMode = "owner", reviewThreads = [] }) {
  const pull = {
    number: 42,
    title: "Repair this change",
    body: "The current repair evidence.",
    user: { login: "pull-author" },
    html_url: "https://example.test/pull/42"
  };
  const actor = authorizationMode === "policy" ? identity.login : "repository-owner";
  const evidencePolicy = { authorizationMode, actor, ownerLogins: [...config.repository.ownerLogins] };
  const comments = [{
    body: "Please repair this safely.",
    created_at: "2026-08-10T09:00:00Z",
    user: { login: "repository-owner" }
  }, ...(authorizationMode === "policy" ? [{
    body: "Repair this review.\n<!-- codekeeper:review -->",
    created_at: "2026-08-10T09:01:00Z",
    user: { login: actor, type: "Bot", id: Number(identity.id) }
  }, {
    body: `Automatic repair was dispatched.\n${automaticRepairMarker(headSha)}`,
    created_at: "2026-08-10T09:02:00Z",
    user: { login: actor, type: "Bot", id: Number(identity.id) }
  }] : [])];
  return {
    mode: "fix",
    repository: "owner/repository",
    configSha256,
    runId,
    authorizationMode,
    requestedBy: actor,
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
      reviewThreadIds: reviewThreads.map((thread) => thread.id),
      subjectSha256: frozenPullRepairSubjectSha256(pull, comments, reviewThreads, evidencePolicy)
    },
    pullRequest: {
      ...frozenPullRepairSubject(pull, comments, reviewThreads, evidencePolicy),
      reviewThreads
    }
  };
}

function frozenRepairReviewThread(body = "Please preserve this review evidence.", isResolved = false) {
  return {
    id: "PRRT_thread",
    isResolved,
    isOutdated: false,
    comments: [{
      id: "PRRC_node_41",
      databaseId: 41,
      author: "reviewer",
      body,
      bodySha256: sha256(body),
      url: "https://example.test/pull/42#discussion_r41",
      path: "README.md",
      line: 1,
      originalLine: 1
    }]
  };
}

test("frozen PR repair threads hash complete bodies beyond the prompt limit", () => {
  const prefix = "x".repeat(7000);
  const first = frozenPullRepairReviewThreads([liveRepairReviewThread(`${prefix}a`)], ["PRRT_thread"]);
  const second = frozenPullRepairReviewThreads([liveRepairReviewThread(`${prefix}b`)], ["PRRT_thread"]);
  assert.equal(first[0].comments[0].body, second[0].comments[0].body);
  assert.notEqual(first[0].comments[0].bodySha256, second[0].comments[0].bodySha256);
});

function liveRepairReviewThread(body, isResolved = false) {
  const frozen = frozenRepairReviewThread(body, isResolved);
  return { ...frozen, comments: { nodes: frozen.comments } };
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
  const comments = context.pullRequest.comments.map((comment) => ({
    body: comment.body,
    created_at: comment.createdAt,
    user: {
      login: comment.author,
      type: comment.author === context.requestedBy && context.authorizationMode === "policy" ? "Bot" : "User"
    }
  }));
  if (context.authorizationMode === "policy") {
    comments.push({
      body: `Automatic repair was dispatched.\n${automaticRepairMarker(context.target.headSha)}`,
      created_at: "2026-08-10T09:02:00Z",
      user: { login: context.requestedBy, type: "Bot" }
    });
  }
  return comments;
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
  let rejectThreadResolution = false;
  let ambiguousThreadResolution = false;
  let reviewThreadBody = "Please preserve this review evidence.";
  let reviewThreadResolved = false;
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
    const context = pullRepairContext({ configSha256, headSha, reviewThreads: [frozenRepairReviewThread()] });
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
      async resolveReviewThread(threadId) {
        assert.equal(threadId, "PRRT_thread");
        reviewThreadResolved = true;
        if (rejectThreadResolution) {
          const error = new Error("thread resolution unavailable");
          if (ambiguousThreadResolution) error.githubMutationOutcome = "ambiguous";
          else reviewThreadResolved = false;
          throw error;
        }
      },
      async listPullReviewThreads() { return [liveRepairReviewThread(reviewThreadBody, reviewThreadResolved)]; },
      async upsertMarkerComment(number, marker, body, authorIdentity) {
        if (!rejectPush) throw new Error("successful PR repair should not publish a failure comment");
        failureComments.push({ number, marker, body, authorIdentity });
      }
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      process.chdir(repository);
      reviewThreadBody = "This review evidence changed after preparation.";
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
            pushHeadToBranch() { throw new Error("thread mutation reached push"); }
          }
        }),
        /repair evidence changed/
      );
      assert.equal(pushes, 0);
      failureComments.length = 0;
      reviewThreadBody = "Please preserve this review evidence.";
      rejectPush = false;

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
      reviewThreadResolved = false;
      rejectThreadResolution = true;
      ambiguousThreadResolution = true;
      const reconciledRepair = await publishFix({
        artifactDirectory,
        config,
        configSha256,
        ...integrity,
        token: "token",
        prRepairGit: {
          configureAutomationIdentity() {},
          createCommitOnCurrentHead,
          pushHeadToBranch() {
            pushes += 1;
            liveHead = git(repository, ["rev-parse", "HEAD"]);
            return liveHead;
          }
        }
      });
      assert.deepEqual(reconciledRepair.resolvedReviewThreadIds, ["PRRT_thread"]);
      assert.equal(reconciledRepair.reviewThreadWarning, undefined);
      assert.equal(pushes, 2);

      git(repository, ["reset", "--hard", headSha]);
      liveHead = headSha;
      reviewThreadResolved = false;
      rejectThreadResolution = true;
      ambiguousThreadResolution = false;
      const partialRepair = await publishFix({
        artifactDirectory,
        config,
        configSha256,
        ...integrity,
        token: "token",
        prRepairGit: {
          configureAutomationIdentity() {},
          createCommitOnCurrentHead,
          pushHeadToBranch() {
            pushes += 1;
            liveHead = git(repository, ["rev-parse", "HEAD"]);
            return liveHead;
          }
        }
      });
      assert.equal(partialRepair.updated, true);
      assert.deepEqual(partialRepair.resolvedReviewThreadIds, []);
      assert.match(partialRepair.reviewThreadWarning, /thread resolution unavailable/);
      assert.equal(pushes, 3);
      assert.equal(failureComments.length, 0);

      git(repository, ["reset", "--hard", headSha]);
      liveHead = headSha;
      reviewThreadResolved = false;
      rejectThreadResolution = false;
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
      assert.equal(pushes, 3);
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
    ["paused owner repair", (pull) => ({ ...pull, labels: [{ name: "paused" }] }), /paused/, undefined, undefined, "owner", 0],
    ["paused automatic repair", (pull) => ({ ...pull, labels: [{ name: "paused" }] }), /paused/, undefined, undefined, "policy", 0],
    ["protected", (pull) => pull, /is protected/, { protected: true }],
    ["branch moved", (pull) => pull, /head branch moved/, { protected: false, commit: { sha: "e".repeat(40) } }]
  ];
  for (const [name, mutate, expected, branchOverride, commentsOverride, authorizationMode = "owner"] of cases) {
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
        assert.equal(comments.length, 0, "stale or ineligible repair targets must not be mutated");
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

test("maintenance publication adopts only the issue whose App marker survived response loss", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-retry-artifact-"));
  const configSha256 = "c".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const issues = [];
  const comments = [];
  let creates = 0;
  let markerAttempts = 0;
  let remoteBaseSha;
  const restoreGitHub = replaceGitHubMethods({
    async getBranch() { return { commit: { sha: remoteBaseSha } }; },
    async listMaintenanceIssues() { return issues; },
    async listIssueComments(number) { return comments.filter((comment) => comment.issueNumber === number); },
    async ensureLabels() {},
    async createIssue(input) {
      creates += 1;
      const issue = {
        number: creates,
        state: "open",
        body: input.body,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      };
      issues.push(issue);
      if (creates === 1) throw new Error("connection lost after issue creation");
      return issue;
    },
    async createComment(issueNumber, body) {
      markerAttempts += 1;
      comments.push({
        issueNumber,
        body,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      });
      if (markerAttempts === 1) throw new Error("connection lost after marker creation");
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
    remoteBaseSha = baseSha;
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
    await assert.rejects(
      publishAudit({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
      /connection lost after marker creation/
    );
    const retry = await publishAudit({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
    assert.equal(creates, 2);
    assert.equal(issues.length, 2);
    assert.equal(comments.length, 1);
    assert.deepEqual(retry.findings.map(({ state, issueNumber }) => ({ state, issueNumber })), [
      { state: "updated", issueNumber: 2 }
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
      async getBranch() { return { commit: { sha: context.baseSha } }; },
      async listMaintenanceIssues() { return [maintenanceIssue]; },
      async listIssueComments() {
        return [{
          body: findingMarker(repairFingerprint),
          user: { login: identity.login, id: Number(identity.id), type: "Bot" }
        }];
      },
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
      missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual",
      decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks."
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
    missingInformation: [], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] }, comment: "Thanks."
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
