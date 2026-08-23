import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_PROFILE_PATHS } from "../src/lib/agent-profiles.mjs";
import { automaticRepairMarker, deferredReviewMarker, deferredReviewFingerprint, reviewFeedbackReplyMarker, sha256 } from "../src/lib/markers.mjs";
import { completeReviewFeedback } from "../src/lib/review-feedback.mjs";
import { evaluateAutoMerge, reviewLabels } from "../src/lib/policy.mjs";
import { LABELS } from "../src/lib/label-ownership.mjs";
import {
  publishIssue as publishIssueProduction,
  reconcileAutoMerge,
  replyToReviewFeedback,
  upsertDeferredReviewFeedback
} from "../src/lib/publish.mjs";
import {
  config,
  identity,
  profilePaths,
  publishAudit,
  publishIssue,
  publishReview,
  replaceGitHubMethods,
  writeSealedArtifact
} from "./helpers/publish-fixtures.mjs";

const secondaryIssueMutationStub = {
  async beginSecondaryIssueMutation() {},
  endSecondaryIssueMutation() {},
};

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
    tests: { adequate: true, notes: "Covered.", missingTest: null }, mergeRecommendation: "auto", noActionReason: null
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
    ...secondaryIssueMutationStub,
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
  assert.deepEqual(calls.created[0].labels, [LABELS.DEFERRED, LABELS.TESTING]);
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
    ...secondaryIssueMutationStub,
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
    ...secondaryIssueMutationStub,
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
    ...secondaryIssueMutationStub,
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
    ...secondaryIssueMutationStub,
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
    tests: { adequate: true, notes: "Covered.", missingTest: null }, mergeRecommendation: "manual", noActionReason: null
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
    tests: { adequate: true, notes: "Covered.", missingTest: null }, mergeRecommendation: "manual", noActionReason: null
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
    assert.equal(pull.labels.some((label) => label.name === "codekeeper:auto-repaired"), false);

    resolved = false;
    const retried = await publishReview({
      artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused"
    });
    assert.equal(retried.automaticRepair.dispatched, true);
    assert.equal(dispatches, 1);
    assert.equal(pull.labels.some((label) => label.name === "codekeeper:auto-repaired"), false);
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
    tests: { adequate: true, notes: "Covered.", missingTest: null }, mergeRecommendation: "auto"
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
  assert.ok(reviewLabels(result).includes(LABELS.CHANGES_REQUIRED));
  assert.ok(!reviewLabels(result).includes(LABELS.MERGE_READY));
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

    pull.labels = [];
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

test("a pending repair marker consumes only its matching active lease", async () => {
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
    const pendingRepair = await fixture.publish();
    assert.equal(pendingRepair.automaticRepair.consumed, true);
    assert.equal(pendingRepair.automaticRepair.eligible, false);
    assert.equal(pendingRepair.automaticRepair.pending, true);

    for (const leaseState of ["failed", "released"]) {
      repair.comments = [leaseComment(leaseState)];
      const retryable = await fixture.publish();
      assert.equal(retryable.automaticRepair.consumed, false);
      assert.equal(retryable.automaticRepair.eligible, true);
      assert.equal(retryable.automaticRepair.pending, true);
    }

    repair.state = `Automatic repair is pending for head ${headSha}. Extra`;
    repair.comments = [leaseComment("active")];
    const inexactMarker = await fixture.publish();
    assert.equal(inexactMarker.automaticRepair.consumed, false);
    assert.equal(inexactMarker.automaticRepair.eligible, true);
    assert.equal(inexactMarker.automaticRepair.pending, false);
  } finally {
    await fixture.cleanup();
  }
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
    nonBlockingFindings: [], tests: { adequate: true, notes: "Covered.", missingTest: null }, mergeRecommendation: "auto", noActionReason: null
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
    assert.ok(provisioned.desiredLabels.includes(LABELS.MERGE_READY));
    assert.ok(provisioned.desiredLabels.includes(LABELS.REVIEW_NEEDED));
    assert.ok(labelCalls[0].desiredLabels.includes(LABELS.MERGE_READY));
    assert.ok(labels.desiredLabels.includes(LABELS.REVIEW_NEEDED));
    assert.ok(!labels.desiredLabels.includes(LABELS.MERGE_READY));
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
  let mutationOptions = null;
  const restoreGitHub = replaceGitHubMethods({
    async beginIssueMutation(options) {
      mutationOptions = options;
      return { number: 7, title: "Report", body: "Details", labels: [] };
    },
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
      assert.deepEqual(published.desiredLabels.sort(), [LABELS.BUG].sort());
      assert.equal(mutationOptions.allowClosed, true);
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
    await rm(liveProfile);
    await assert.rejects(
      publishIssueProduction({
        artifactDirectory,
        config,
        configSha256,
        ...integrity,
        agentProfilePath: liveProfile,
        agentProfileSource: "repository",
        token: "token"
      }),
      /Trusted repository agent profile is missing/
    );
    assert.equal(githubAccessed, false);
  } finally {
    restoreGitHub();
    await rm(artifactDirectory, { recursive: true, force: true });
    await rm(liveRoot, { recursive: true, force: true });
  }
});

test("publication reloads the packaged default recorded during preparation", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-package-profile-artifact-"));
  const configSha256 = "5".repeat(64);
  const packagedProfile = await readFile(new URL("../agents/issue-triager.md", import.meta.url));
  const sourceSha = "b".repeat(40);
  const context = {
    mode: "issue",
    repository: "owner/repository",
    configSha256,
    runId: "7005",
    runUrl: "https://github.com/owner/repository/actions/runs/7005",
    issue: {
      number: 7,
      title: "Package profile",
      updatedAt: "2026-08-05T10:00:00Z"
    },
    existingOpenIssues: [],
    agentProfile: {
      source: "package",
      path: "runtime/agents/issue-triager.md",
      sha256: sha256(packagedProfile),
      sourceSha
    }
  };
  const result = {
    mode: "issue",
    summary: "Ready for triage.",
    type: "bug",
    priority: "p3",
    labels: [],
    actionable: true,
    missingInformation: [],
    duplicateOf: null,
    duplicateConfidence: "none",
    implementationRecommendation: "manual",
    decision: { required: false, question: "", rationale: "", options: [] },
    comment: "Thanks."
  };
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const restoreGitHub = replaceGitHubMethods({
    async beginIssueMutation() {
      return { ...context.issue, body: "", labels: [] };
    }
  });
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "issue",
      context,
      result,
      configSha256,
      agentProfile: packagedProfile
    });
    await assert.rejects(
      publishIssueProduction({
        artifactDirectory,
        config,
        configSha256,
        ...integrity,
        agentProfileSource: "repository",
        agentProfilePath: profilePaths.issue,
        token: "unused",
        dryRun: true
      }),
      /Agent profile changed after preparation/
    );
    await assert.rejects(
      publishIssueProduction({
        artifactDirectory,
        config,
        configSha256,
        ...integrity,
        agentProfileSource: "package",
        agentProfileSourceSha: "c".repeat(40),
        token: "unused",
        dryRun: true
      }),
      /Agent profile changed after preparation/
    );
    const published = await publishIssueProduction({
      artifactDirectory,
      config,
      configSha256,
      ...integrity,
      agentProfileSource: "package",
      agentProfileSourceSha: sourceSha,
      token: "unused",
      dryRun: true
    });
    assert.deepEqual(published, {
      issue: 7,
      desiredLabels: [LABELS.BUG],
      dryRun: true
    });
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
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
