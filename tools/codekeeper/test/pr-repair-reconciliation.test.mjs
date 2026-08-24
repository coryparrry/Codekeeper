import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCommitOnCurrentHead,
  createValidationReceipt,
} from "../src/lib/git.mjs";
import { fixRunMarker, sha256 } from "../src/lib/markers.mjs";
import { publishPullRequestRepair } from "../src/lib/pr-repair.mjs";

const config = JSON.parse(
  await readFile(
    new URL("../../../.github/codekeeper.json", import.meta.url),
    "utf8",
  ),
);
const automationIdentity = { login: "codekeeper[bot]", id: "123456" };

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...options,
  }).trim();
}

function livePull(context, headSha) {
  return {
    number: context.target.number,
    state: "open",
    draft: false,
    html_url: "https://example.test/pull/42",
    head: {
      ref: context.target.headRef,
      sha: headSha,
      repo: { full_name: context.repository },
    },
    base: {
      ref: context.target.baseRef,
      sha: context.target.baseSha,
      repo: { full_name: context.repository },
    },
  };
}

async function repairFixture() {
  const repository = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-pr-reconciliation-"),
  );
  const artifactDirectory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-pr-reconciliation-artifact-"),
  );
  await writeFile(path.join(repository, "README.md"), "# Example\n", "utf8");
  git(repository, ["init", "-q", "-b", "feature/repair"]);
  git(repository, ["config", "user.name", "Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-qm", "initial PR head"]);
  const headSha = git(repository, ["rev-parse", "HEAD"]);
  await writeFile(
    path.join(repository, "README.md"),
    "# Example\n\nRegression covered.\n",
    "utf8",
  );
  const patch = execFileSync(
    "git",
    ["diff", "--binary", "--full-index", "HEAD"],
    { cwd: repository },
  );
  await writeFile(path.join(artifactDirectory, "patch.diff"), patch);
  git(repository, ["checkout", "--", "README.md"]);

  const configSha256 = "2".repeat(64);
  const candidateSha256 = "3".repeat(64);
  const patchSha256 = sha256(patch);
  const context = {
    mode: "fix",
    repository: "owner/repository",
    configSha256,
    runId: "7001",
    authorizationMode: "owner",
    requestedBy: "repository-owner",
    baseSha: headSha,
    defaultBranch: config.repository.defaultBranch,
    target: {
      kind: "pull_request",
      number: 42,
      headRef: "feature/repair",
      headSha,
      headRepository: "owner/repository",
      baseRef: config.repository.defaultBranch,
      baseSha: "b".repeat(40),
      baseRepository: "owner/repository",
      subjectSha256: "4".repeat(64),
      reviewThreadIds: [],
    },
  };
  const commands = config.audit.repair.validationCommands.map((command) => ({
    command,
    exitCode: 0,
    durationMs: 1,
    stdoutDigest: sha256(`output for ${command}`),
    startedAt: "2026-08-17T00:00:00.000Z",
  }));
  const manifest = {
    candidateSha256,
    configSha256,
    patch: {
      valid: true,
      fileName: "patch.diff",
      sha256: patchSha256,
      files: ["README.md"],
    },
    validation: {
      receipt: createValidationReceipt({
        candidateSha256,
        configSha256,
        patchSha256,
        baseSha: headSha,
        commands,
        patchUnchanged: true,
      }),
    },
  };
  return {
    repository,
    artifactDirectory,
    context,
    manifest,
    result: { resolvedReviewThreadIds: [] },
  };
}

async function withRepairFixture(run) {
  const fixture = await repairFixture();
  const originalDirectory = process.cwd();
  try {
    process.chdir(fixture.repository);
    await run(fixture);
  } finally {
    process.chdir(originalDirectory);
    await rm(fixture.repository, { recursive: true, force: true });
    await rm(fixture.artifactDirectory, { recursive: true, force: true });
  }
}

test("confirmed repair push reports incomplete final reconciliation with the remote commit", async () => {
  await withRepairFixture(
    async ({ artifactDirectory, context, manifest, result }) => {
      let remoteHead = context.target.headSha;
      let pullReads = 0;
      const events = [];
      const comments = [];
      const github = {
        token: "token",
        async beginPullRepairMutation() {
          return livePull(context, remoteHead);
        },
        async mutatePullHeadIfCurrent(commitSha, operation) {
          assert.equal(await operation(), commitSha);
        },
        async getPull() {
          pullReads += 1;
          events.push(`pull-read-${pullReads}`);
          if (pullReads === 1) throw new Error("post-push PR read failed");
          return livePull(context, remoteHead);
        },
        async getBranch() {
          events.push("branch-read");
          return { commit: { sha: remoteHead } };
        },
        async upsertMarkerComment(number, marker, body, identity) {
          events.push("comment");
          comments.push({ number, marker, body, identity });
        },
      };

    let pushedCommitSha;
    await assert.rejects(
      publishPullRequestRepair({
          github,
          artifactDirectory,
          manifest,
          context,
          result,
          config,
          automationIdentity,
          gitOperations: {
          configureAutomationIdentity() {},
          createCommitOnCurrentHead,
          pushHeadToBranch() {
            remoteHead = git(process.cwd(), ["rev-parse", "HEAD"]);
            pushedCommitSha = remoteHead;
            return remoteHead;
          },
        },
      }),
      (error) => {
        assert.equal(error.code, "CODEKEEPER_PR_REPAIR_RECONCILIATION_INCOMPLETE");
        assert.match(error.message, /was pushed, but final GitHub reconciliation is incomplete/);
        assert.match(error.message, /post-push PR read failed/);
        assert.ok(error.message.includes(pushedCommitSha));
        return true;
      },
    );

      assert.deepEqual(events, [
        "pull-read-1",
        "pull-read-2",
        "branch-read",
        "comment",
      ]);
      assert.equal(comments.length, 1);
      assert.equal(comments[0].number, context.target.number);
      assert.equal(comments[0].marker, fixRunMarker(context.runId));
      assert.deepEqual(comments[0].identity, automationIdentity);
      assert.ok(
        comments[0].body.includes(
          `The repair commit \`${remoteHead}\` was pushed, but final GitHub reconciliation is incomplete.`,
        ),
      );
      assert.ok(comments[0].body.includes(`PR head is \`${remoteHead}\``));
      assert.ok(comments[0].body.includes(`branch head is \`${remoteHead}\``));
      assert.doesNotMatch(comments[0].body, /did not update this pull request/);
    },
  );
});

test("success-comment failure after a push still reports post-push reconciliation", async () => {
  await withRepairFixture(
    async ({ artifactDirectory, context, manifest, result }) => {
      let remoteHead = context.target.headSha;
      const comments = [];
      let successCommentAttempted = false;
      const github = {
        token: "token",
        async beginPullRepairMutation() {
          return livePull(context, remoteHead);
        },
        async mutatePullHeadIfCurrent(commitSha, operation) {
          assert.equal(await operation(), commitSha);
        },
        async getPull() {
          return livePull(context, remoteHead);
        },
        async getBranch() {
          return { commit: { sha: remoteHead } };
        },
        async upsertMarkerComment(number, marker, body, identity) {
          if (body.startsWith("Codekeeper applied automatic repair")) {
            successCommentAttempted = true;
            throw new Error("success comment transport failed");
          }
          comments.push({ number, marker, body, identity });
        },
      };

      await assert.rejects(
        publishPullRequestRepair({
          github,
          artifactDirectory,
          manifest,
          context,
          result,
          config,
          automationIdentity,
          gitOperations: {
            configureAutomationIdentity() {},
            createCommitOnCurrentHead,
            pushHeadToBranch() {
              remoteHead = git(process.cwd(), ["rev-parse", "HEAD"]);
              return remoteHead;
            },
          },
        }),
        (error) => {
          assert.equal(error.code, "CODEKEEPER_PR_REPAIR_RECONCILIATION_INCOMPLETE");
          assert.match(error.message, /success comment transport failed/);
          return true;
        },
      );

      assert.equal(successCommentAttempted, true);
      assert.equal(comments.length, 1);
      assert.match(comments[0].body, /The repair commit `.*` was pushed/);
      assert.doesNotMatch(comments[0].body, /did not update this pull request/);
    },
  );
});

test("repair push rejection retains the pre-push failure message without remote reconciliation reads", async () => {
  await withRepairFixture(
    async ({ artifactDirectory, context, manifest, result }) => {
      const comments = [];
      let remoteReads = 0;
      const github = {
        token: "token",
        async beginPullRepairMutation() {
          return livePull(context, context.target.headSha);
        },
        async mutatePullHeadIfCurrent(_commitSha, operation) {
          return operation();
        },
        async getPull() {
          remoteReads += 1;
          throw new Error("unexpected PR reconciliation read");
        },
        async getBranch() {
          remoteReads += 1;
          throw new Error("unexpected branch reconciliation read");
        },
        async upsertMarkerComment(number, marker, body, identity) {
          comments.push({ number, marker, body, identity });
        },
      };

      await assert.rejects(
        publishPullRequestRepair({
          github,
          artifactDirectory,
          manifest,
          context,
          result,
          config,
          automationIdentity,
          gitOperations: {
            configureAutomationIdentity() {},
            createCommitOnCurrentHead,
            pushHeadToBranch() {
              throw new Error("non-fast-forward update rejected");
            },
          },
        }),
        /non-fast-forward update rejected/,
      );

      assert.equal(remoteReads, 0);
      assert.equal(comments.length, 1);
      assert.match(
        comments[0].body,
        /^Codekeeper did not update this pull request\./,
      );
      assert.match(comments[0].body, /non-fast-forward update rejected/);
      assert.doesNotMatch(comments[0].body, /was pushed/);
    },
  );
});
