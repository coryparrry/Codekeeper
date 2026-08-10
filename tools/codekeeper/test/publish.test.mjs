import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient, isOwnedMarkerComment, resolveGraphqlUrl } from "../src/lib/github.mjs";
import { findingFingerprint, findingMarker, sha256 } from "../src/lib/markers.mjs";
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
  body: `A maintainer may edit this description without affecting deduplication.\n<!-- codekeeper:repair=${fingerprint} -->`,
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

test("maintenance issue fingerprints require the configured App author and marker comment", () => {
  const marker = findingMarker("b".repeat(64));
  const issue = {
    body: `Trusted maintenance finding\n${marker}`,
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  };
  const options = { marker, botLogin: identity.login, botId: identity.id };
  const comments = [{ body: marker, user: issue.user }];
  assert.equal(isTrustedMaintenanceIssue(issue, comments, options), true);
  assert.equal(isTrustedMaintenanceIssue(issue, [], options), false);
  assert.equal(isTrustedMaintenanceIssue(issue, [{ ...comments[0], user: { login: "person", id: 123456, type: "User" } }], options), false);
  assert.equal(isTrustedMaintenanceIssue({ ...issue, user: { login: "person", id: 123456, type: "User" } }, comments, options), false);
  assert.equal(isTrustedMaintenanceIssue({ ...issue, body: `${issue.body}\nuntrusted suffix` }, comments, options), false);
});

test("GraphQL follows the configured GitHub API host", () => {
  assert.equal(resolveGraphqlUrl("https://api.github.com"), "https://api.github.com/graphql");
  assert.equal(resolveGraphqlUrl("https://github.example/api/v3"), "https://github.example/api/graphql");
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

test("maintenance publication adopts an App-created issue only after its marker comment exists", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-retry-artifact-"));
  const configSha256 = "c".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const issues = [];
  const comments = [];
  let creates = 0;
  const restoreGitHub = replaceGitHubMethods({
    async listMaintenanceIssues() { return issues; },
    async listIssueComments() { return comments; },
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
      return issue;
    },
    async createComment(_number, body) {
      comments.push({ body, user: { login: identity.login, id: Number(identity.id), type: "Bot" } });
      throw new Error("connection lost after marker creation");
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
      /connection lost after marker creation/
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

test("maintenance publication does not adopt an App-created issue without marker evidence", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-pre-marker-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-pre-marker-retry-artifact-"));
  const configSha256 = "f".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const issues = [];
  const comments = [];
  let creates = 0;
  const restoreGitHub = replaceGitHubMethods({
    async listMaintenanceIssues() { return issues; },
    async listIssueComments() { return comments; },
    async ensureLabels() {},
    async createIssue(input) {
      creates += 1;
      const issue = {
        number: creates,
        state: "open",
        body: input.body,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      };
      if (creates === 1) {
        issues.push(issue);
        throw new Error("connection lost after issue creation");
      }
      return issue;
    },
    async createComment(number, body) {
      assert.equal(number, 2);
      comments.push({ body, user: { login: identity.login, id: Number(identity.id), type: "Bot" } });
    },
    async updateIssue() { throw new Error("unmarked issue must not be adopted"); },
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
    const finding = {
      title: "Missing guide", evidence: "The guide is missing.", proposedAction: "Add the guide.",
      owningPath: "README.md", category: "docs", priority: "p2", problemKey: "missing-guide", labels: []
    };
    const result = {
      mode: "audit", summary: "One maintenance finding.", findings: [finding],
      repair: { requested: false, findingIndex: null, title: "", body: "", risk: "low", validationSummary: "" },
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
    assert.equal(creates, 2);
    assert.equal(issues.length, 2);
    assert.deepEqual(comments, [{
      body: findingMarker(findingFingerprint(finding)),
      user: { login: identity.login, id: Number(identity.id), type: "Bot" }
    }]);
    assert.deepEqual(retry.findings.map(({ state, issueNumber }) => ({ state, issueNumber })), [
      { state: "created", issueNumber: 2 }
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

test("maintenance publication creates a fresh issue when unmarked App candidates match", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-ambiguous-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-audit-ambiguous-retry-artifact-"));
  const configSha256 = "1".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const createdIssues = [];
  const markerComments = [];
  try {
    await writeFile(path.join(repository, "README.md"), "# Example\n", "utf8");
    git(repository, ["init", "-q", "-b", "main"]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "initial"]);
    const baseSha = git(repository, ["rev-parse", "HEAD"]);
    const context = { mode: "audit", repository: "owner/repository", configSha256, baseSha, runUrl: "https://example.test/run" };
    const finding = {
      title: "Missing guide", evidence: "The guide is missing.", proposedAction: "Add the guide.",
      owningPath: "README.md", category: "docs", priority: "p2", problemKey: "missing-guide", labels: []
    };
    const result = {
      mode: "audit", summary: "One maintenance finding.", findings: [finding],
      repair: { requested: false, findingIndex: null, title: "", body: "", risk: "low", validationSummary: "" },
      noActionReason: null
    };
    const integrity = await writeSealedArtifact(artifactDirectory, { mode: "audit", context, result, configSha256 });
    const marker = findingMarker(findingFingerprint(finding));
    const issues = [
      {
        number: 99,
        state: "open",
        body: `Untrusted maintenance publication\n${marker}`,
        user: { login: "person", id: 123456, type: "User" }
      },
      ...[1, 2].map((number) => ({
        number,
        state: "open",
        body: `Interrupted maintenance publication\n${marker}`,
        user: { login: identity.login, id: Number(identity.id), type: "Bot" }
      }))
    ];
    const restoreGitHub = replaceGitHubMethods({
      async listMaintenanceIssues() { return issues; },
      async listIssueComments() { return []; },
      async ensureLabels() {},
      async createIssue(input) {
        const issue = {
          number: 3,
          state: "open",
          body: input.body,
          user: { login: identity.login, id: Number(identity.id), type: "Bot" }
        };
        createdIssues.push(issue);
        return issue;
      },
      async createComment(number, body) { markerComments.push({ number, body }); },
      async updateIssue() { throw new Error("unmarked issue must not be updated"); },
      async replaceManagedLabels() {}
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      process.chdir(repository);
      const publication = await publishAudit({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
      assert.deepEqual(publication.findings.map(({ state, issueNumber }) => ({ state, issueNumber })), [
        { state: "created", issueNumber: 3 }
      ]);
      assert.equal(createdIssues.length, 1);
      assert.deepEqual(markerComments, [{ number: 3, body: marker }]);
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
      body: `Repair\n<!-- codekeeper:repair=${repairFingerprint} -->`,
      user: { login: identity.login, id: Number(identity.id), type: "Bot" },
      head: { ref: repairBranch(config, "audit", repairFingerprint), repo: { full_name: context.repository } },
      base: { repo: { full_name: context.repository } }
    };
    const restoreGitHub = replaceGitHubMethods({
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
        assert.equal(marker, `<!-- codekeeper:repair-notification=${repairFingerprint} -->`);
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
        `A repair pull request was opened: ${repairPull.html_url}\n<!-- codekeeper:repair-notification=${repairFingerprint} -->`
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

test("fix publication adopts an exact orphan repair branch", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-retry-test-"));
  const artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-fix-retry-artifact-"));
  const configSha256 = "d".repeat(64);
  const originalDirectory = process.cwd();
  const previousLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const previousId = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  let pullsCreated = 0;
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
      async request(method, endpoint) {
        assert.equal(method, "GET");
        assert.ok(endpoint.endsWith(`/branches/${encodeURIComponent(branch)}`));
        return {
          data: {
            name: branch,
            commit: { commit: { tree: { sha: remoteTreeSha } }, parents: [{ sha: baseSha }] }
          }
        };
      },
      async createPull(input) {
        pullsCreated += 1;
        assert.equal(input.head, branch);
        return { number: 12, html_url: "https://example.test/pull/12" };
      },
      async ensureLabels() {},
      async replaceManagedLabels() {},
      async createComment() {}
    });
    try {
      process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = identity.login;
      process.env.CODEKEEPER_AUTOMATION_BOT_ID = identity.id;
      process.chdir(repository);
      const repair = await publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" });
      assert.equal(repair.created, true);
      assert.equal(repair.pullRequest, 12);
      assert.equal(pullsCreated, 1);
      git(repository, ["checkout", "main"]);
      git(repository, ["branch", "-D", branch]);
      remoteTreeSha = "0".repeat(40);
      await assert.rejects(
        publishFix({ artifactDirectory, config, configSha256, ...integrity, token: "token" }),
        /already exists with unexpected content/
      );
      assert.equal(pullsCreated, 1);
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
