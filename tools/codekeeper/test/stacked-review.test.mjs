import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { prepareReview } from "../src/lib/prepare.mjs";
import { evaluateAutoMerge } from "../src/lib/policy.mjs";
import { reviewPublicationDisposition } from "../src/lib/publish.mjs";

const config = JSON.parse(
  await readFile(new URL("../../../.github/codekeeper.json", import.meta.url), "utf8"),
);
const repository = "owner/repository";
const reviewPolicy = {
  repository: {
    defaultBranch: "main",
    ownerLogins: ["owner"],
  },
};

function currentSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function pullState({ baseRef = "stack/base", autoMerge = null, draft = false, headRepository = repository } = {}) {
  return {
    number: 7,
    node_id: "PR_7",
    state: "open",
    draft,
    auto_merge: autoMerge,
    labels: [],
    user: { login: "codekeeper[bot]", type: "Bot" },
    head: {
      sha: "a".repeat(40),
      ref: "automation/codekeeper/review",
      repo: { full_name: headRepository },
    },
    base: {
      sha: "b".repeat(40),
      ref: baseRef,
      repo: { full_name: repository },
    },
  };
}

function githubFor(pull) {
  return new GitHubClient({
    token: "token",
    repository,
    transport: {
      retries: 0,
      fetch: async (url, options) => {
        if (options.method === "GET" && String(url).endsWith("/pulls/7")) {
          return new Response(JSON.stringify(pull), { status: 200 });
        }
        throw new Error(`Unexpected GitHub request: ${options.method} ${url}`);
      },
    },
  });
}

async function reviewEvent(root, pullRequest) {
  const eventPath = path.join(root, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      action: "opened",
      repository: { full_name: "acme/example" },
      pull_request: pullRequest,
    }),
  );
  return eventPath;
}

function eventPull({
  headRepository = "acme/example",
  baseRepository = "acme/example",
  draft = false,
  baseRef = "stack/base",
} = {}) {
  const sha = currentSha();
  return {
    number: 7,
    title: "Stacked review",
    body: "",
    draft,
    html_url: "https://github.com/acme/example/pull/7",
    user: { login: "contributor" },
    base: { ref: baseRef, sha, repo: { full_name: baseRepository } },
    head: { ref: "feature/stacked", sha, repo: { full_name: headRepository } },
  };
}

test("review publication admits same-repository stacked bases while repair retains the default-base guard", async () => {
  const pull = pullState();
  const admitted = await githubFor(pull).beginPullMutation({
    repository,
    pullRequest: {
      number: pull.number,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      baseRef: pull.base.ref,
      reviewFeedback: [],
    },
    policy: reviewPolicy,
    reviewPublication: true,
  });
  assert.equal(admitted.base.ref, "stack/base");

  await assert.rejects(
    githubFor(pull).beginPullMutation({
      repository,
      pullRequest: {
        number: pull.number,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
        baseRef: pull.base.ref,
        reviewFeedback: [],
      },
      policy: reviewPolicy,
    }),
    /base branch changed/,
  );
  await assert.rejects(
    githubFor(pull).beginPullRepairMutation({
      repository,
      target: {
        number: pull.number,
        headSha: pull.head.sha,
        headRef: pull.head.ref,
        baseSha: pull.base.sha,
        baseRef: pull.base.ref,
        subjectSha256: "c".repeat(64),
        reviewThreadIds: [],
      },
      policy: reviewPolicy,
      repairEvidencePolicy: { authorizationMode: "owner", actor: "owner" },
    }),
    /matching repository policy/,
  );
});

test("live publication disposition wins over stale sealed draft state", () => {
  const context = {
    repository,
    pullRequest: { number: 7, headSha: "a".repeat(40), baseSha: "b".repeat(40), baseRef: "main", draft: false },
  };
  assert.equal(reviewPublicationDisposition(context, pullState({ baseRef: "main", draft: true })).disposition, "manual");
  assert.equal(
    reviewPublicationDisposition(
      { ...context, pullRequest: { ...context.pullRequest, draft: true } },
      pullState({ baseRef: "main" }),
    ).disposition,
    "eligible",
  );
  assert.equal(
    reviewPublicationDisposition(context, pullState({ baseRef: "main", headRepository: "fork/repository" })).disposition,
    "unsupported",
  );
});

test("stacked review policy cannot enable auto-merge even for a trusted automation branch", () => {
  const decision = evaluateAutoMerge({
    config: { ...config, merge: { ...config.merge, enabled: true } },
    pullRequest: pullState(),
    files: [{ filename: "README.md", additions: 1, deletions: 0 }],
    reviewResult: {
      risk: "low",
      blockingFindings: [],
      nonBlockingFindings: [],
      reviewFeedback: [],
      tests: { adequate: true, missingTest: null },
      mergeRecommendation: "auto",
    },
    reviewContextComplete: true,
    automationBotLogin: "codekeeper[bot]",
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => reason.includes("configured default branch")));
});

test("same-repository stacked and draft reviews prepare, while forks remain unsupported", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-stacked-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = {
    config: { ...config, automation: { ...config.automation, automaticPrReview: true } },
    token: "read-token",
    toolingSha: "d".repeat(40),
    configSha256: "e".repeat(64),
    agentProfileSource: "package",
    agentProfileSourceSha: "f".repeat(40),
  };
  const stacked = await prepareReview({
    ...common,
    eventPath: await reviewEvent(root, eventPull()),
    directory: path.join(root, "stacked"),
  });
  assert.equal(stacked.pullRequest.baseRef, "stack/base");
  assert.equal(stacked.pullRequest.headRef, "feature/stacked");

  await assert.rejects(
    prepareReview({
      ...common,
      eventPath: await reviewEvent(root, eventPull({ headRepository: "fork/example" })),
      directory: path.join(root, "fork"),
    }),
    /Fork pull requests are unsupported; manual review is required/,
  );
  const draft = await prepareReview({
    ...common,
    eventPath: await reviewEvent(root, eventPull({ draft: true })),
    directory: path.join(root, "draft"),
  });
  assert.equal(draft.pullRequest.eligibility.readOnlyReview.eligible, true);
  assert.equal(draft.pullRequest.eligibility.reportPublication.eligible, false);
});

test("review workflows admit stacked publication but keep forks, drafts, and merge queues manual", async () => {
  const reusable = await readFile(
    new URL("../../../.github/workflows/codekeeper-review.yml", import.meta.url),
    "utf8",
  );
  const caller = await readFile(
    new URL("../../../examples/workflows/codekeeper-review.yml.example", import.meta.url),
    "utf8",
  );
  assert.match(
    reusable,
    /const sameRepository = event\.pull_request\?\.head\?\.repo\?\.full_name === repository\n\s+&& event\.pull_request\?\.base\?\.repo\?\.full_name === repository;/,
  );
  assert.doesNotMatch(reusable, /github\.event\.pull_request\.base\.ref == github\.event\.repository\.default_branch/);
  assert.match(reusable, /Stacked pull request target \$BASE_REF is review-publication-only/);
  assert.match(reusable, /Fork pull requests are unsupported; manual review is required/);
  assert.match(reusable, /PUBLISH_DISPOSITION/);
  assert.doesNotMatch(reusable, /PUBLISH_RESULT:|IS_DRAFT:|github-actions%5Bbot%5D/);
  assert.match(reusable, /merge_group does not provide/);
  assert.doesNotMatch(reusable, /merge_group:/);
  assert.match(caller, /stacked PRs receive review publication/);
  assert.doesNotMatch(caller, /merge_group:/);
});
