import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../src/lib/markers.mjs";
import {
  config,
  identity,
  publishReview,
  replaceGitHubMethods,
  writeSealedArtifact
} from "./helpers/publish-fixtures.mjs";

test("automatic repair dispatch carries the exact repository dispatch payload", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-repair-dispatch-payload-test-"));
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
  const secondFrozenFeedback = {
    sourceKey: "review_comment:42", kind: "review_comment", author: "reviewer",
    body: "Keep the related repair in scope.", bodySha256: sha256("Keep the related repair in scope."),
    url: "https://github.test/comment/42", state: "commented", threadId: frozenFeedback.threadId,
    rootCommentId: 41, resolved: false, outdated: false, path: "README.md", line: 2
  };
  const context = {
    mode: "review", repository: "owner/repository", configSha256, runId: "7010",
    runUrl: "https://github.com/owner/repository/actions/runs/7010",
    pullRequest: {
      number: 7, headSha, baseSha, diff: { truncated: false, disabled: false },
      reviewFeedbackFrozen: true, reviewFeedback: [frozenFeedback, secondFrozenFeedback]
    }
  };
  const result = {
    mode: "review", summary: "Repair the current feedback.", risk: "low", labels: [],
    blockingFindings: [], nonBlockingFindings: [],
    reviewFeedback: [{
      problemKey: "repair-dispatch", disposition: "fix_now", type: "bug",
      explanation: "Repair the current feedback.", validation: "The feedback is still active.",
      sourceKeys: [frozenFeedback.sourceKey], threadIds: [frozenFeedback.threadId]
    }, {
      problemKey: "repair-dispatch-shared-thread", disposition: "fix_if_cheap", type: "bug",
      explanation: "A second objective shares the same review thread.", validation: "The feedback is still active.",
      sourceKeys: [secondFrozenFeedback.sourceKey], threadIds: [frozenFeedback.threadId]
    }],
    tests: { adequate: true, notes: "Covered.", missingTest: null }, mergeRecommendation: "manual", noActionReason: null
  };
  const pull = {
    number: 7, node_id: "PR_7", state: "open", draft: false, auto_merge: null, labels: [],
    user: { login: "contributor", type: "User" },
    head: { sha: headSha, ref: "feature/repair", repo: { full_name: context.repository } },
    base: { sha: baseSha, ref: reviewConfig.repository.defaultBranch, repo: { full_name: context.repository } }
  };
  const issueComments = [];
  const dispatchCalls = [];
  const restoreGitHub = replaceGitHubMethods({
    async getPull() { return structuredClone(pull); },
    async listPullFiles() { return [{ filename: "README.md", additions: 1, deletions: 0 }]; },
    async listPullReviews() { return []; },
    async listPullReviewThreads() {
      return [{
        id: frozenFeedback.threadId, isResolved: false, isOutdated: false,
        comments: { nodes: [
          {
            databaseId: 41, body: frozenFeedback.body, url: frozenFeedback.url,
            path: frozenFeedback.path, line: frozenFeedback.line, originalLine: frozenFeedback.line,
            author: { login: frozenFeedback.author }
          }, {
            databaseId: 42, body: secondFrozenFeedback.body, url: secondFrozenFeedback.url,
            path: secondFrozenFeedback.path, line: secondFrozenFeedback.line, originalLine: secondFrozenFeedback.line,
            author: { login: secondFrozenFeedback.author }
          }
        ] }
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
    async createRepositoryDispatch(eventType, payload) {
      dispatchCalls.push({ eventType, payload: structuredClone(payload) });
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
    const published = await publishReview({
      artifactDirectory, config: reviewConfig, configSha256, ...integrity, token: "unused"
    });
    assert.equal(published.automaticRepair.dispatched, true);
    assert.deepEqual(dispatchCalls, [{
      eventType: "codekeeper_fix",
      payload: {
        number: pull.number,
        head_sha: headSha,
        authorization_mode: "policy",
        requested_by: identity.login,
        review_thread_ids: [frozenFeedback.threadId]
      }
    }]);
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});
