import assert from "node:assert/strict";
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
      status: "modified",
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
    {
      filename: "src/two.mjs",
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
  let calls = 0;
  const snapshot = await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "secret-token",
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(
        url.href,
        `https://api.github.com/repos/owner/repository/compare/${BASE_SHA}...${HEAD_SHA}?per_page=1&page=1`,
      );
      assert.equal(options.headers.authorization, "Bearer secret-token");
      return new Response(JSON.stringify(comparison()), { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
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
  });
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
  await createReviewContext({
    event: event(),
    expectedRepository: "owner/repository",
    token: "secret-token",
    apiUrl: "https://github.example/api/v3",
    fetchImpl: async (url) => {
      assert.equal(
        url.href,
        `https://github.example/api/v3/repos/owner/repository/compare/${BASE_SHA}...${HEAD_SHA}?per_page=1&page=1`,
      );
      return new Response(JSON.stringify(comparison()), { status: 200 });
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
