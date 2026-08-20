import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deferredReviewMarker } from "../src/lib/markers.mjs";
import {
  config,
  identity,
  publishIssue,
  replaceGitHubMethods,
  writeSealedArtifact
} from "./publish-test-helpers.mjs";

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
        body: `${body}
${marker}`,
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
  let labels = [{ name: "external" }, { name: "priority p1" }, { name: "deferred" }, { name: "codekeeper:needs-information" }];
  let markerPublished = false;
  const issue = () => ({
    number: 7, title: "Report", body: `Details
${deferredReviewMarker("f".repeat(64))}`, state: "open", updated_at: updatedAt,
    html_url: "https://github.com/owner/repository/issues/7",
    user: { id: Number(identity.id), login: identity.login, type: "Bot" }, labels
  });
  const restoreGitHub = replaceGitHubMethods({
    async getIssue() { return issue(); },
    async ensureLabels() {},
    async replaceManagedLabels(_number, desiredLabels) {
      labels = [
        ...labels.filter((label) => !label.name.startsWith("codekeeper:")),
        ...desiredLabels.map((name) => ({ name })),
      ];
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
    assert.deepEqual(labels.map((label) => label.name).sort(), [
      "external",
      "priority p1",
      "deferred",
      "codekeeper:type-bug",
      "codekeeper:priority-p3",
      "codekeeper:ready",
    ].sort());
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("issue publication adds the managed needs-information label from triage", async () => {
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-needs-information-test-"));
  const configSha256 = "b".repeat(64);
  const context = { mode: "issue", repository: "owner/repository", configSha256, runId: "7013", runUrl: "https://github.com/owner/repository/actions/runs/7013", issue: { number: 7, title: "Report", updatedAt: "2026-08-13T11:00:00Z" } };
  const result = {
    mode: "issue", summary: "More information is needed.", type: "bug", priority: "p3", labels: [], actionable: false,
    missingInformation: ["Which version contains this behavior?"], duplicateOf: null, duplicateConfidence: "none", implementationRecommendation: "manual",
    decision: {
      required: true,
      question: "Which version contains this behavior?",
      rationale: "Version is required to reproduce the report.",
      options: [{
        label: "Provide the version",
        description: "Reply with the version where the behavior occurs.",
        recommended: true,
      }],
    },
    comment: "Please provide the version."
  };
  const restoreGitHub = replaceGitHubMethods({
    async beginIssueMutation() { return { number: 7, title: "Report", state: "open", labels: [] }; },
  });
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  try {
    process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
    process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "issue", context, result, configSha256 });
    const published = await publishIssue({ artifactDirectory, config, configSha256, ...integrity, token: "token", dryRun: true });
    assert.ok(published.desiredLabels.includes("codekeeper:needs-information"));
  } finally {
    restoreGitHub();
    if (previousLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = previousLogin;
    if (previousId === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_ID;
    else process.env.CODEKEEPER_AUTOMATION_BOT_ID = previousId;
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});
