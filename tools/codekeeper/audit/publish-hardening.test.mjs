import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { AGENT_PROFILE_BUNDLE_FILE, AGENT_PROFILE_PATHS } from "../src/lib/agent-profiles.mjs";
import { sha256 } from "../src/lib/markers.mjs";
import { acquireAutomaticRepairLease, publishIssue, publishReview } from "../src/lib/publish.mjs";

const config = JSON.parse(await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8"));
const profileFixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-publish-hardening-profiles-"));
const profilePaths = {};
const profileBytes = {};
for (const [mode, relativePath] of Object.entries(AGENT_PROFILE_PATHS)) {
  const filePath = path.join(profileFixtureRoot, relativePath);
  const bytes = Buffer.from(`# Audit ${mode} profile\n\nUse frozen evidence only.\n`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  profilePaths[mode] = filePath;
  profileBytes[mode] = bytes;
}
test.after(() => rm(profileFixtureRoot, { recursive: true, force: true }));

const ambientGitHubEnvironment = ["GITHUB_REPOSITORY", "GITHUB_GRAPHQL_URL"]
  .map((name) => [name, process.env[name]]);
for (const [name] of ambientGitHubEnvironment) delete process.env[name];
test.after(() => {
  for (const [name, value] of ambientGitHubEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const identity = { login: "codekeeper[bot]", id: "123456" };

test("an expired automatic-repair lease cannot block a later run", async () => {
  const context = { repository: "owner/repository", runId: "new-run" };
  const pull = { number: 7, head: { sha: "h".repeat(40) } };
  const scope = sha256(JSON.stringify({
    repository: context.repository,
    pullNumber: pull.number,
    headSha: pull.head.sha
  }));
  const oldMarker = `<!-- codekeeper:repair-lease=${sha256(JSON.stringify({ scope, runId: "old-run" }))} -->`;
  const comments = [{
    id: 1,
    body: `<!-- codekeeper:repair-lease-active=${scope} -->\n${oldMarker}`,
    created_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  }];
  const github = {
    async createComment(_number, body) {
      const comment = {
        id: 2,
        body,
        created_at: new Date().toISOString(),
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      };
      comments.push(comment);
      return structuredClone(comment);
    },
    async listIssueComments() { return structuredClone(comments); },
    async updateComment(id, body) {
      comments.find((comment) => comment.id === id).body = body;
    }
  };

  const lease = await acquireAutomaticRepairLease({ github, context, pull, automationIdentity: identity });

  assert.equal(lease.acquired, true);
  assert.match(comments[0].body, /repair-lease-expired=/);
});

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

function replaceGitHubMethods(methods) {
  const originals = Object.fromEntries(Object.keys(methods).map((name) => [name, GitHubClient.prototype[name]]));
  Object.assign(GitHubClient.prototype, methods);
  return () => Object.assign(GitHubClient.prototype, originals);
}

function setIdentityEnvironment() {
  const previous = ["CODEKEEPER_AUTOMATION_BOT_LOGIN", "CODEKEEPER_AUTOMATION_BOT_ID"]
    .map((name) => [name, process.env[name]]);
  process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
  process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("issue duplicate closure accepts owned comments and rejects post-inventory user comments", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-marker-hardening-"));
  const configSha256 = "a".repeat(64);
  const issueConfig = structuredClone(config);
  issueConfig.issues.closeExactDuplicates = true;
  const context = {
    mode: "issue",
    repository: "owner/repository",
    configSha256,
    runId: "7007",
    runUrl: "https://github.com/owner/repository/actions/runs/7007",
    issue: { number: 7, title: "Report", updatedAt: "2026-08-05T10:00:00Z" }
  };
  const result = {
    mode: "issue",
    summary: "Exact duplicate.",
    type: "bug",
    priority: "p3",
    labels: [],
    actionable: true,
    missingInformation: [],
    duplicateOf: 9,
    duplicateConfidence: "high",
    implementationRecommendation: "manual",
    comment: "Thanks for the report."
  };
  let updatedAt = context.issue.updatedAt;
  let labels = [];
  let comments = [];
  let injectPostInventoryComment = false;
  let duplicateInventoryAccepted = false;
  const calls = [];
  const issue = () => ({
    number: 7,
    title: "Report",
    body: "Details",
    state: "open",
    updated_at: updatedAt,
    html_url: "https://github.com/owner/repository/issues/7",
    user: { id: 1, login: "reporter", type: "User" },
    labels
  });
  const restoreGitHub = replaceGitHubMethods({
    async getIssue(number) {
      if (number === 9) return { number, state: "open" };
      if (injectPostInventoryComment && duplicateInventoryAccepted) {
        injectPostInventoryComment = false;
        comments.push({
          id: 72,
          body: "One more detail from the reporter.",
          created_at: updatedAt,
          updated_at: updatedAt,
          user: { id: 1, login: "reporter", type: "User" }
        });
      }
      return issue();
    },
    async listIssueComments() {
      if (comments.some((comment) => comment.id === 71)) duplicateInventoryAccepted = true;
      return structuredClone(comments);
    },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = desiredLabels.map((name) => ({ name }));
      updatedAt = "2026-08-05T10:00:30Z";
    },
    async upsertMarkerComment(_number, marker, body) {
      calls.push("marker");
      updatedAt = "2026-08-05T10:01:00Z";
      const mutation = {
        id: 70,
        body: `${body}\n${marker}`,
        created_at: updatedAt,
        updated_at: updatedAt,
        user: { id: Number(identity.id), login: identity.login, type: "Bot" }
      };
      comments = [mutation];
      return mutation;
    },
    async createComment(_number, body) {
      calls.push("duplicate-comment");
      updatedAt = "2026-08-05T10:01:30Z";
      const mutation = {
        id: 71,
        body,
        created_at: updatedAt,
        updated_at: updatedAt,
        user: { id: Number(identity.id), login: identity.login, type: "Bot" }
      };
      comments.push(mutation);
      return mutation;
    },
    async updateIssue() { calls.push("close"); }
  });
  const restoreEnvironment = setIdentityEnvironment();
  try {
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "issue", context, result, configSha256, artifactConfig: issueConfig
    });
    await publishIssue({
      artifactDirectory,
      config: issueConfig,
      configSha256,
      agentProfilePath: profilePaths.issue,
      ...integrity,
      token: "unused"
    });
    assert.deepEqual(calls, ["marker", "duplicate-comment", "close"]);

    updatedAt = context.issue.updatedAt;
    labels = [];
    comments = [];
    calls.length = 0;
    duplicateInventoryAccepted = false;
    injectPostInventoryComment = true;
    await assert.rejects(
      publishIssue({
        artifactDirectory,
        config: issueConfig,
        configSha256,
        agentProfilePath: profilePaths.issue,
        ...integrity,
        token: "unused"
      }),
      /changed while Codekeeper reconciled comments/
    );
    assert.deepEqual(calls, ["marker", "duplicate-comment"]);
  } finally {
    restoreEnvironment();
    restoreGitHub();
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("a failed automatic repair dispatch does not consume its retry marker", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-review-repair-hardening-"));
  const configSha256 = "b".repeat(64);
  const reviewConfig = structuredClone(config);
  reviewConfig.review.autoRepair = true;
  const context = {
    mode: "review",
    repository: "owner/repository",
    configSha256,
    runId: "7008",
    runUrl: "https://github.com/owner/repository/actions/runs/7008",
    pullRequest: {
      number: 7,
      headSha: "h".repeat(40),
      baseSha: "b".repeat(40),
      diff: { truncated: false, disabled: false },
      reviewFeedback: []
    }
  };
  const result = {
    mode: "review",
    summary: "A current review comment needs a repair.",
    risk: "low",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    reviewFeedback: [{
      problemKey: "dispatch-retry",
      disposition: "fix_now",
      type: "bug",
      explanation: "The current head needs a repair.",
      validation: "The failure is reproducible on the current head.",
      sourceKeys: ["review_comment:1"],
      threadIds: ["thread-1"]
    }],
    tests: { adequate: true, notes: "The failing behavior is covered." },
    diagram: null,
    mergeRecommendation: "manual",
    noActionReason: null
  };
  const pull = {
    number: 7,
    state: "open",
    draft: false,
    auto_merge: null,
    labels: [],
    user: { login: "person", type: "User" },
    head: { sha: context.pullRequest.headSha, ref: "feature/repair", repo: { full_name: context.repository } },
    base: { sha: context.pullRequest.baseSha, ref: reviewConfig.repository.defaultBranch, repo: { full_name: context.repository } }
  };
  let dispatchAttempts = 0;
  let markerPresentAfterFirstAttempt = false;
  let concurrentMode = false;
  let concurrentAdds = 0;
  let releaseConcurrentAdd;
  let failAddAfterMutation = false;
  let failLeaseCompletion = false;
  let removalAttempts = 0;
  let nextLeaseCommentId = 1;
  const leaseComments = [];
  const restoreGitHub = replaceGitHubMethods({
    async getPull() {
      return structuredClone(pull);
    },
    async listPullFiles() { return [{ filename: "README.md", additions: 1, deletions: 0 }]; },
    async listMaintenanceIssues() { return []; },
    async createComment(_number, body) {
      const comment = {
        id: nextLeaseCommentId,
        body,
        created_at: new Date().toISOString(),
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      };
      nextLeaseCommentId += 1;
      leaseComments.push(comment);
      return structuredClone(comment);
    },
    async listIssueComments() { return structuredClone(leaseComments); },
    async updateComment(id, body) {
      if (failLeaseCompletion && body.includes("repair-lease-completed=")) {
        throw new Error("lease completion unavailable");
      }
      const comment = leaseComments.find((candidate) => candidate.id === id);
      comment.body = body;
      return structuredClone(comment);
    },
    async ensureLabels() {},
    async replaceManagedLabels() {},
    async upsertMarkerComment() {},
    async addLabels(_number, labelsToAdd) {
      if (concurrentMode) {
        concurrentAdds += 1;
        if (concurrentAdds === 1) {
          await Promise.race([
            new Promise((resolve) => { releaseConcurrentAdd = resolve; }),
            new Promise((resolve) => setTimeout(resolve, 25))
          ]);
        } else {
          releaseConcurrentAdd?.();
        }
      }
      pull.labels = [...pull.labels, ...labelsToAdd.map((name) => ({ name }))];
      if (failAddAfterMutation) throw new Error("label response unavailable");
    },
    async removeLabel(_number, label) {
      removalAttempts += 1;
      pull.labels = pull.labels.filter((item) => item.name !== label);
    },
    async createRepositoryDispatch() {
      dispatchAttempts += 1;
      if (concurrentMode && dispatchAttempts > 3) throw new Error("concurrent dispatch failed");
      if (dispatchAttempts === 1) throw new Error("dispatch unavailable");
    }
  });
  const restoreEnvironment = setIdentityEnvironment();
  try {
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "review", context, result, configSha256, artifactConfig: reviewConfig
    });
    let firstError;
    try {
      await publishReview({ artifactDirectory, config: reviewConfig, configSha256, agentProfilePath: profilePaths.review, ...integrity, token: "unused" });
    } catch (error) {
      firstError = error;
    }
    markerPresentAfterFirstAttempt = pull.labels.some((label) => label.name === "codekeeper:auto-repaired");
    const retry = await publishReview({ artifactDirectory, config: reviewConfig, configSha256, agentProfilePath: profilePaths.review, ...integrity, token: "unused" });
    assert.deepEqual({
      firstError: firstError?.message,
      markerPresentAfterFirstAttempt,
      dispatchAttempts,
      retryDispatched: retry.automaticRepair.dispatched
    }, {
      firstError: "dispatch unavailable",
      markerPresentAfterFirstAttempt: false,
      dispatchAttempts: 2,
      retryDispatched: true
    });

    pull.labels = [];
    concurrentMode = true;
    concurrentAdds = 0;
    const dispatchesBeforeConcurrentRun = dispatchAttempts;
    const removalsBeforeConcurrentRun = removalAttempts;
    const concurrent = await Promise.allSettled([
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, agentProfilePath: profilePaths.review, ...integrity, token: "unused" }),
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, agentProfilePath: profilePaths.review, ...integrity, token: "unused" })
    ]);
    assert.deepEqual({
      markerPresent: pull.labels.some((label) => label.name === "codekeeper:auto-repaired"),
      dispatches: dispatchAttempts - dispatchesBeforeConcurrentRun,
      removals: removalAttempts - removalsBeforeConcurrentRun,
      fulfilled: concurrent.filter((outcome) => outcome.status === "fulfilled").length
    }, {
      markerPresent: true,
      dispatches: 1,
      removals: 0,
      fulfilled: 2
    });

    pull.labels = [];
    concurrentMode = false;
    failLeaseCompletion = true;
    const removalsBeforeCompletionFailure = removalAttempts;
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, agentProfilePath: profilePaths.review, ...integrity, token: "unused" }),
      /lease completion unavailable/
    );
    assert.deepEqual({
      markerPresent: pull.labels.some((label) => label.name === "codekeeper:auto-repaired"),
      removals: removalAttempts - removalsBeforeCompletionFailure
    }, {
      markerPresent: true,
      removals: 0
    });

    leaseComments.at(-1).created_at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    pull.labels = [];
    failLeaseCompletion = false;
    failAddAfterMutation = true;
    const dispatchesBeforeAmbiguousAdd = dispatchAttempts;
    await assert.rejects(
      publishReview({ artifactDirectory, config: reviewConfig, configSha256, agentProfilePath: profilePaths.review, ...integrity, token: "unused" }),
      /label response unavailable/
    );
    assert.deepEqual({
      markerPresent: pull.labels.some((label) => label.name === "codekeeper:auto-repaired"),
      dispatches: dispatchAttempts - dispatchesBeforeAmbiguousAdd
    }, {
      markerPresent: false,
      dispatches: 0
    });
  } finally {
    restoreEnvironment();
    restoreGitHub();
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});
