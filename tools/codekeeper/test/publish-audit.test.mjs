import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findingFingerprint, findingMarker, repairMarker, repairNotificationMarker, sha256 } from "../src/lib/markers.mjs";
import {
  isTrustedMaintenanceFindingIssue,
  isTrustedRepairPull,
  repairBranch
} from "../src/lib/publish.mjs";
import {
  config,
  git,
  identity,
  publishAudit,
  replaceGitHubMethods,
  writeSealedArtifact
} from "./helpers/publish-fixtures.mjs";

const fingerprint = "a".repeat(64);
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
    async getIssue(number) { return issues.find((issue) => issue.number === number); },
    async listMaintenanceIssues() { return issues; },
    async listIssueComments(number) { return comments.filter((comment) => comment.issueNumber === number); },
    async ensureLabels() {},
    async createIssue(input) {
      creates += 1;
      const issue = {
        number: creates,
        state: "open",
        updated_at: "2026-08-05T10:00:00Z",
        labels: [],
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
        id: markerAttempts,
        issueNumber,
        body,
        created_at: "2026-08-05T10:00:00Z",
        updated_at: "2026-08-05T10:00:00Z",
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
    await writeFile(path.join(repository, "README.md"), "# Example\n\nRepair.\n", "utf8");
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", "HEAD"], { cwd: repository });
    await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
    const integrity = await writeSealedArtifact(artifactDirectory, {
      mode: "audit",
      context,
      result,
      configSha256,
      artifactConfig: auditConfig,
      patch: { valid: true, fileName: "patch.diff", sha256: sha256(patch), files: ["README.md"] }
    });
    const branch = repairBranch(auditConfig, "audit", repairFingerprint);
    git(repository, ["checkout", "-b", "seed-repair"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "seed repair"]);
    const remoteHeadSha = git(repository, ["rev-parse", "HEAD"]);
    const remoteTreeSha = git(repository, ["rev-parse", "HEAD^{tree}"]);
    git(repository, ["checkout", "main"]);
    git(repository, ["branch", "-D", "seed-repair"]);
    const maintenanceIssue = {
      number: 1,
      state: "open",
      updated_at: "2026-08-05T10:00:00Z",
      labels: [],
      body: `Existing maintenance finding\n${findingMarker(repairFingerprint)}`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" }
    };
    const repairPull = {
      number: 12,
      html_url: "https://example.test/pull/12",
      body: `Repair\n${repairMarker(repairFingerprint)}`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" },
      state: "open",
      head: { sha: remoteHeadSha, ref: branch, repo: { full_name: context.repository } },
      base: { sha: baseSha, ref: auditConfig.repository.defaultBranch, repo: { full_name: context.repository } }
    };
    const restoreGitHub = replaceGitHubMethods({
      async getBranch() { return { commit: { sha: context.baseSha } }; },
      async getBranchTip(requestedBranch) {
        assert.equal(requestedBranch, branch);
        return { headSha: remoteHeadSha, treeSha: remoteTreeSha, parentShas: [baseSha] };
      },
      async getPull() { return structuredClone(repairPull); },
      async getIssue(number) { return number === maintenanceIssue.number ? maintenanceIssue : null; },
      async listMaintenanceIssues() { return [maintenanceIssue]; },
      async listIssueComments() {
        return [{
          id: 1,
          body: findingMarker(repairFingerprint),
          created_at: "2026-08-05T10:00:00Z",
          updated_at: "2026-08-05T10:00:00Z",
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
      git(repository, ["checkout", "main"]);
      git(repository, ["branch", "-D", branch]);
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
