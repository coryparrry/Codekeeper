import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  createReviewContext,
  runPrepareReviewContextAction,
} from "../assets/review/.github/rivet/actions/prepare-review-context/index.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ACTION_ROOT = path.join(
  PACKAGE_ROOT,
  "assets/review/.github/rivet/actions/prepare-review-context",
);
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const ONE_CONTENT = "export const one = 1;\n";
const TWO_CONTENT = "export const two = 2;\n";

function gitBlobSha(content) {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function blob(content, sha = gitBlobSha(content)) {
  return {
    sha,
    size: Buffer.byteLength(content),
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
  };
}

function event(changedFiles = 2) {
  return {
    repository: { full_name: "owner/repository" },
    pull_request: {
      number: 7,
      changed_files: changedFiles,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    },
  };
}

function changedFiles() {
  return [
    {
      filename: "src/one.mjs",
      sha: gitBlobSha(ONE_CONTENT),
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
    {
      filename: "src/two.mjs",
      sha: gitBlobSha(TWO_CONTENT),
      previous_filename: "src/old-two.mjs",
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
    },
  ];
}

function comparison(files = changedFiles()) {
  return { files };
}

function githubFetch({
  files = changedFiles(),
  reviews = [],
  comments = [],
  responseHeaders = {},
} = {}) {
  const contents = new Map([
    [gitBlobSha(ONE_CONTENT), ONE_CONTENT],
    [gitBlobSha(TWO_CONTENT), TWO_CONTENT],
  ]);
  return async (url, options) => {
    assert.equal(options.headers.authorization, "Bearer secret-token");
    if (url.pathname.includes("/compare/"))
      return new Response(JSON.stringify(comparison(files)), { status: 200 });
    if (url.pathname.endsWith("/reviews"))
      return new Response(JSON.stringify(reviews), {
        status: 200,
        headers: responseHeaders.reviews,
      });
    if (url.pathname.endsWith("/comments"))
      return new Response(JSON.stringify(comments), {
        status: 200,
        headers: responseHeaders.comments,
      });
    const sha = url.pathname.split("/").at(-1);
    if (url.pathname.includes("/git/blobs/") && contents.has(sha))
      return new Response(JSON.stringify(blob(contents.get(sha))), {
        status: 200,
      });
    return new Response("not found", { status: 404 });
  };
}

test("declares one dependency-free bounded review-context action", async () => {
  const [actionSource, fixtureAction, implementation, fixtureImplementation] =
    await Promise.all([
      readFile(path.join(ACTION_ROOT, "action.yml"), "utf8"),
      readFile(
        path.join(
          PACKAGE_ROOT,
          "test/fixtures/review/.github/rivet/actions/prepare-review-context/action.yml",
        ),
        "utf8",
      ),
      readFile(path.join(ACTION_ROOT, "index.mjs"), "utf8"),
      readFile(
        path.join(
          PACKAGE_ROOT,
          "test/fixtures/review/.github/rivet/actions/prepare-review-context/index.mjs",
        ),
        "utf8",
      ),
    ]);
  assert.equal(actionSource, fixtureAction);
  assert.equal(implementation, fixtureImplementation);
  const action = parse(actionSource);
  assert.deepEqual(action.runs, { using: "node24", main: "index.mjs" });
  assert.deepEqual(Object.keys(action.outputs), ["snapshot"]);
  assert.equal(action.inputs, undefined);
});

test("fetches and projects one exact pull request comparison", async () => {
  const requests = [];
  const fetchImpl = githubFetch();
  const snapshot = await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "secret-token",
    fetchImpl: async (url, options) => {
      requests.push(url.href);
      return fetchImpl(url, options);
    },
  });
  assert.deepEqual(
    requests.sort(),
    [
      `https://api.github.com/repos/owner/repository/compare/${BASE_SHA}...${HEAD_SHA}?per_page=1&page=1`,
      `https://api.github.com/repos/owner/repository/git/blobs/${gitBlobSha(ONE_CONTENT)}`,
      `https://api.github.com/repos/owner/repository/git/blobs/${gitBlobSha(TWO_CONTENT)}`,
      "https://api.github.com/repos/owner/repository/pulls/7/comments?per_page=100&page=1",
      "https://api.github.com/repos/owner/repository/pulls/7/reviews?per_page=100&page=1",
    ].sort(),
  );
  assert.deepEqual(snapshot, {
    schemaVersion: 2,
    complete: true,
    repository: "owner/repository",
    pullNumber: 7,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    files: [
      {
        path: "src/one.mjs",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      {
        path: "src/two.mjs",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: null,
        previousPath: "src/old-two.mjs",
      },
    ],
    repositoryContext: {
      complete: true,
      refSha: HEAD_SHA,
      files: [
        {
          path: "src/one.mjs",
          blobSha: gitBlobSha(ONE_CONTENT),
          content: ONE_CONTENT,
        },
        {
          path: "src/two.mjs",
          blobSha: gitBlobSha(TWO_CONTENT),
          content: TWO_CONTENT,
        },
      ],
    },
    priorReviewContext: { complete: true, reviews: [], comments: [] },
  });
});

test("projects bounded prior review memory with exact commit identities", async () => {
  const snapshot = await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "secret-token",
    fetchImpl: githubFetch({
      reviews: [
        {
          id: 11,
          user: { id: 101, login: "rivet[bot]", type: "Bot" },
          state: "COMMENTED",
          commit_id: BASE_SHA,
          submitted_at: "2026-09-01T10:00:00Z",
          body: "Earlier general review.",
        },
        { id: 99, state: "PENDING", submitted_at: null },
      ],
      comments: [
        {
          id: 12,
          pull_request_review_id: 11,
          user: { id: 101, login: "rivet[bot]", type: "Bot" },
          path: "src/one.mjs",
          line: 1,
          original_line: 1,
          side: "RIGHT",
          commit_id: HEAD_SHA,
          original_commit_id: BASE_SHA,
          created_at: "2026-09-01T10:01:00Z",
          body: "This finding is already reported.",
        },
        { id: 100, pull_request_review_id: 99 },
      ],
    }),
  });
  assert.deepEqual(snapshot.priorReviewContext, {
    complete: true,
    reviews: [
      {
        id: 11,
        author: { id: 101, login: "rivet[bot]", type: "Bot" },
        state: "COMMENTED",
        commitSha: BASE_SHA,
        submittedAt: "2026-09-01T10:00:00Z",
        body: "Earlier general review.",
      },
    ],
    comments: [
      {
        id: 12,
        reviewId: 11,
        author: { id: 101, login: "rivet[bot]", type: "Bot" },
        inReplyToId: null,
        path: "src/one.mjs",
        line: 1,
        originalLine: 1,
        side: "RIGHT",
        commitSha: HEAD_SHA,
        originalCommitSha: BASE_SHA,
        createdAt: "2026-09-01T10:01:00Z",
        body: "This finding is already reported.",
      },
    ],
  });
});

test("keeps a valid comparison when optional context is invalid or paginated", async () => {
  const fetchImpl = githubFetch({
    responseHeaders: {
      reviews: {
        link: '<https://api.github.com/reviews?page=2>; rel="next"',
      },
    },
  });
  const snapshot = await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "secret-token",
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith(`/git/blobs/${gitBlobSha(ONE_CONTENT)}`)) {
        return new Response(
          JSON.stringify(blob("tampered", gitBlobSha(ONE_CONTENT))),
          { status: 200 },
        );
      }
      return fetchImpl(url, options);
    },
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.repositoryContext, {
    complete: false,
    reason: "GitHub repository context blob is invalid",
    refSha: HEAD_SHA,
    files: [],
  });
  assert.deepEqual(snapshot.priorReviewContext, {
    complete: false,
    reason: "prior review history requires pagination",
    reviews: [],
    comments: [],
  });

  const budgeted = await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "secret-token",
    maxRepositoryContextBytes: 220,
    fetchImpl: githubFetch(),
  });
  assert.equal(budgeted.complete, true);
  assert.deepEqual(budgeted.repositoryContext.files, []);
  assert.match(budgeted.repositoryContext.reason, /220-byte budget/u);
  assert.ok(
    Buffer.byteLength(JSON.stringify(budgeted.repositoryContext), "utf8") <=
      220,
  );
});

test("requires patches for changed files except source-backed locks", async () => {
  const incomplete = await createReviewContext({
    event: event(1),
    expectedRepository: "owner/repository",
    token: "secret-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          comparison([
            {
              filename: "src/missing.mjs",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ]),
        ),
        { status: 200 },
      ),
  });
  assert.equal(incomplete.complete, false);
  assert.equal(
    incomplete.reason,
    "GitHub comparison omits a complete changed-file patch",
  );

  const complete = await createReviewContext({
    event: event(2),
    expectedRepository: "owner/repository",
    token: "secret-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          comparison([
            {
              filename: ".github/workflows/rivet-review.lock.yml",
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
              patch: null,
            },
            {
              filename: ".github/workflows/rivet-review.md",
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
              patch: "@@ -1 +1 @@\n-old\n+new",
            },
          ]),
        ),
        { status: 200 },
      ),
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.files[0].patch, null);
});

test("uses the trusted GitHub Enterprise API origin", async () => {
  const fetchImpl = githubFetch();
  await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "secret-token",
    apiUrl: "https://github.example/api/v3",
    fetchImpl: async (url, options) => {
      assert.match(url.href, /^https:\/\/github\.example\/api\/v3\/repos\//u);
      return fetchImpl(url, options);
    },
  });
});

test("fails closed before model execution when the comparison is unbounded", async () => {
  let fetched = false;
  const tooManyFiles = await createReviewContext({
    event: event(51),
    expectedRepository: "owner/repository",
    token: "token",
    fetchImpl: async () => {
      fetched = true;
    },
  });
  assert.equal(fetched, false);
  assert.equal(tooManyFiles.complete, false);
  assert.match(tooManyFiles.reason, /50-file review budget/);
  assert.deepEqual(tooManyFiles.files, []);

  const tooManyBytes = await createReviewContext({
    event: event(1),
    expectedRepository: "owner/repository",
    token: "token",
    maxSnapshotBytes: 128,
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          comparison([
            {
              filename: "src/large.mjs",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
              patch: "x".repeat(512),
            },
          ]),
        ),
        { status: 200 },
      ),
  });
  assert.equal(tooManyBytes.complete, false);
  assert.match(tooManyBytes.reason, /128-byte review budget/);
  assert.deepEqual(tooManyBytes.files, []);

  const oversizedResponse = await createReviewContext({
    event: event(1),
    expectedRepository: "owner/repository",
    token: "token",
    maxResponseBytes: 32,
    fetchImpl: async () => new Response(JSON.stringify(comparison())),
  });
  assert.equal(oversizedResponse.complete, false);
  assert.equal(
    oversizedResponse.reason,
    "GitHub comparison response is too large",
  );
});

test("rejects mismatched identities and malformed GitHub responses", async () => {
  await assert.rejects(
    createReviewContext({
      event: event(),
      expectedRepository: "other/repository",
      token: "token",
    }),
    /repository identity is invalid/,
  );
  const incomplete = await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "token",
    fetchImpl: async () => new Response(JSON.stringify(comparison([]))),
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.reason, "GitHub changed-file response is incomplete");
  await assert.rejects(
    createReviewContext({
      event: event(1),
      expectedRepository: "owner/repository",
      token: "token",
      fetchImpl: async () =>
        new Response(
          JSON.stringify(
            comparison([
              {
                filename: "../escape.mjs",
                status: "modified",
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: "@@ -1 +1 @@",
              },
            ]),
          ),
          { status: 200 },
        ),
    }),
    /file 1 path is invalid/,
  );
});

test("writes one newline-free bounded snapshot to GitHub output", async () => {
  const writes = [];
  const snapshot = await runPrepareReviewContextAction({
    env: {
      GITHUB_EVENT_PATH: "/github/event.json",
      GITHUB_OUTPUT: "/github/output",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_TOKEN: "secret-token",
    },
    statImpl: async () => ({ isFile: () => true, size: 512 }),
    readFileImpl: async () => JSON.stringify(event()),
    appendFileImpl: async (...args) => writes.push(args),
    fetchImpl: async () =>
      new Response(JSON.stringify(comparison()), { status: 200 }),
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(writes, [
    ["/github/output", `snapshot=${JSON.stringify(snapshot)}\n`, "utf8"],
  ]);
  assert.doesNotMatch(writes[0][1], /secret-token/);
  assert.equal(writes[0][1].split("\n").length, 2);
});

test("escapes untrusted gh-aw placeholders only in prompt transport", async () => {
  const writes = [];
  const placeholderContent = "__GH_AW_REPOSITORY_CONTEXT__\n";
  const placeholderComparison = comparison([
    {
      filename: "src/placeholder.mjs",
      sha: gitBlobSha(placeholderContent),
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -0,0 +1,2 @@\n+__GH_AW_UNTRUSTED__\n+__GH_AW_SECOND__",
    },
  ]);
  const snapshot = await runPrepareReviewContextAction({
    env: {
      GITHUB_EVENT_PATH: "/github/event.json",
      GITHUB_OUTPUT: "/github/output",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_TOKEN: "secret-token",
    },
    statImpl: async () => ({ isFile: () => true, size: 512 }),
    readFileImpl: async () => JSON.stringify(event(1)),
    appendFileImpl: async (...args) => writes.push(args),
    fetchImpl: async (url) => {
      if (url.pathname.includes("/compare/"))
        return new Response(JSON.stringify(placeholderComparison), {
          status: 200,
        });
      if (url.pathname.includes("/git/blobs/"))
        return new Response(JSON.stringify(blob(placeholderContent)), {
          status: 200,
        });
      if (url.pathname.endsWith("/reviews"))
        return new Response(
          JSON.stringify([
            {
              id: 13,
              user: { id: 101, login: "rivet[bot]", type: "Bot" },
              state: "COMMENTED",
              commit_id: HEAD_SHA,
              submitted_at: "2026-09-01T10:00:00Z",
              body: "__GH_AW_PRIOR_REVIEW__",
            },
          ]),
          { status: 200 },
        );
      return new Response("[]", { status: 200 });
    },
  });
  const encoded = writes[0][1].slice("snapshot=".length, -1);
  assert.doesNotMatch(encoded, /__GH_AW_/);
  assert.match(encoded, /\\u005f_GH_AW_UNTRUSTED__/);
  assert.match(encoded, /\\u005f_GH_AW_SECOND__/);
  assert.match(encoded, /\\u005f_GH_AW_REPOSITORY_CONTEXT__/);
  assert.match(encoded, /\\u005f_GH_AW_PRIOR_REVIEW__/);
  assert.deepEqual(JSON.parse(encoded), snapshot);
  assert.match(snapshot.files[0].patch, /__GH_AW_UNTRUSTED__/);
  assert.match(
    snapshot.repositoryContext.files[0].content,
    /__GH_AW_REPOSITORY_CONTEXT__/,
  );
  assert.match(
    snapshot.priorReviewContext.reviews[0].body,
    /__GH_AW_PRIOR_REVIEW__/,
  );
});

test("does not start the model when bounded context is incomplete", async () => {
  let wroteOutput = false;
  await assert.rejects(
    runPrepareReviewContextAction({
      env: {
        GITHUB_EVENT_PATH: "/github/event.json",
        GITHUB_OUTPUT: "/github/output",
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_REPOSITORY: "owner/repository",
        GITHUB_TOKEN: "secret-token",
      },
      statImpl: async () => ({ isFile: () => true, size: 512 }),
      readFileImpl: async () => JSON.stringify(event(51)),
      appendFileImpl: async () => {
        wroteOutput = true;
      },
    }),
    /50-file review budget/,
  );
  assert.equal(wroteOutput, false);
});
