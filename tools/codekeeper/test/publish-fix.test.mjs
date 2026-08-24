import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommitOnCurrentHead } from "../src/lib/git.mjs";
import { automaticRepairMarker, fixRunMarker, repairMarker, repairNotificationMarker, sha256 } from "../src/lib/markers.mjs";
import { frozenPullRepairReviewThreads, frozenPullRepairSubject, frozenPullRepairSubjectSha256 } from "../src/lib/pr-repair.mjs";
import { repairBranch } from "../src/lib/publish.mjs";
import {
  config,
  git,
  identity,
  publishFix,
  replaceGitHubMethods,
  writeSealedArtifact
} from "./helpers/publish-fixtures.mjs";

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

test("frozen PR repair threads hash complete bodies beyond the prompt limit", () => {
  const prefix = "x".repeat(7000);
  const first = frozenPullRepairReviewThreads([liveRepairReviewThread(`${prefix}a`)], ["PRRT_thread"]);
  const second = frozenPullRepairReviewThreads([liveRepairReviewThread(`${prefix}b`)], ["PRRT_thread"]);
  assert.equal(first[0].comments[0].body, second[0].comments[0].body);
  assert.notEqual(first[0].comments[0].bodySha256, second[0].comments[0].bodySha256);
});

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
  const appliedComments = [];
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
        if (body.startsWith("Codekeeper applied automatic repair")) {
          appliedComments.push({ number, marker, body, authorIdentity });
          return;
        }
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
      assert.equal(appliedComments.length, 1);
      assert.match(appliedComments[0].body, new RegExp(`Codekeeper applied automatic repair \`${liveHead}\``));
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
  cases.push([
    "stale paused direct owner repair",
    (pull) => ({
      ...pull,
      labels: [{ name: "codekeeper:paused" }],
      head: { ...pull.head, sha: "f".repeat(40) },
    }),
    /head SHA changed/,
    undefined,
    undefined,
    "owner",
    true,
  ]);
  for (const [name, mutate, expected, branchOverride, commentsOverride, authorizationMode = "owner", directOwner = false] of cases) {
    await t.test(name, async () => {
      const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-pr-repair-negative-"));
      const configSha256 = "3".repeat(64);
      const context = pullRepairContext({ configSha256, headSha: "a".repeat(40), runId: `negative-${name}`, authorizationMode });
      if (directOwner) {
        context.ownerCommandContext = {
          executionKind: "mode",
          canonicalCommand: "repair",
        };
      }
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
      let removeLabelCalls = 0;
      const restoreGitHub = replaceGitHubMethods({
        async getPull() { return mutate(liveRepairPull(context)); },
        async listIssueComments() { return liveRepairComments(context, commentsOverride); },
        async getBranch() { return branchOverride ?? { protected: false, commit: { sha: context.target.headSha } }; },
        async createPull() { createPullCalls += 1; },
        async removeLabel() { removeLabelCalls += 1; },
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
        assert.equal(removeLabelCalls, 0, "stale direct repairs must remain paused");
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

test("fix repair notification remains singular after response loss", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-repair-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-repair-retry-artifact-"));
  const configSha256 = "f".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const notification = [];
  let notificationAttempts = 0;
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
    const repairFingerprint = sha256("issue|owner/repository|7");
    const branch = repairBranch(config, "fix", repairFingerprint);
    git(repository, ["checkout", "-b", "seed-repair"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "seed repair"]);
    const remoteHeadSha = git(repository, ["rev-parse", "HEAD"]);
    const remoteTreeSha = git(repository, ["rev-parse", "HEAD^{tree}"]);
    git(repository, ["checkout", "main"]);
    git(repository, ["branch", "-D", "seed-repair"]);
    const repairPull = {
      number: 12,
      html_url: "https://example.test/pull/12",
      body: `Repair\n${repairMarker(repairFingerprint)}`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" },
      state: "open",
      head: { sha: remoteHeadSha, ref: branch, repo: { full_name: context.repository } },
      base: { sha: baseSha, ref: config.repository.defaultBranch, repo: { full_name: context.repository } }
    };
    let liveRemoteTreeSha = remoteTreeSha;
    const resetCheckout = () => {
      git(repository, ["checkout", "main"]);
      git(repository, ["branch", "-D", branch]);
    };
    const restoreGitHub = replaceGitHubMethods({
      async getIssue(number) { return { number, title: context.issue.title, state: "open", updated_at: context.issue.updatedAt, labels: [] }; },
      async getBranchTip(requestedBranch) {
        assert.equal(requestedBranch, branch);
        return { headSha: remoteHeadSha, treeSha: liveRemoteTreeSha, parentShas: [baseSha] };
      },
      async getPull() { return structuredClone(repairPull); },
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
      process.chdir(repository);
      const unexpectedPath = path.join(repository, "unexpected.txt");
      await writeFile(unexpectedPath, "not part of the sealed repair\n", "utf8");
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /Expected a clean worktree/
      );
      await rm(unexpectedPath);
      assert.equal(labelReconciliations, 0);
      assert.equal(notificationAttempts, 0);

      liveRemoteTreeSha = "0".repeat(40);
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /sealed repair tree/
      );
      assert.equal(labelReconciliations, 0);
      assert.equal(notificationAttempts, 0);
      resetCheckout();
      liveRemoteTreeSha = remoteTreeSha;

      repairPull.head.sha = "f".repeat(40);
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /sealed repair target/
      );
      assert.equal(labelReconciliations, 0);
      assert.equal(notificationAttempts, 0);
      resetCheckout();
      repairPull.head.sha = remoteHeadSha;

      repairPull.base.ref = "release";
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /sealed repair target/
      );
      assert.equal(labelReconciliations, 0);
      assert.equal(notificationAttempts, 0);
      resetCheckout();
      repairPull.base.ref = config.repository.defaultBranch;

      repairPull.base.sha = "e".repeat(40);
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /sealed repair target/
      );
      assert.equal(labelReconciliations, 0);
      assert.equal(notificationAttempts, 0);
      resetCheckout();
      repairPull.base.sha = baseSha;

      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /connection lost after repair notification/
      );
      resetCheckout();
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
    process.chdir(originalDirectory);
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(repository, { recursive: true, force: true });
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
