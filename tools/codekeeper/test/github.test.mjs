import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";

function client(transport = {}) {
  return new GitHubClient({ token: "token", repository: "owner/repository", transport });
}

const reviewPolicy = {
  repository: {
    defaultBranch: "main",
    ownerLogins: ["owner"]
  }
};

function pullState({ headSha = "a".repeat(40), baseSha = "b".repeat(40), labels = [] } = {}) {
  return {
    number: 7,
    state: "open",
    draft: false,
    head: { sha: headSha, repo: { full_name: "owner/repository" } },
    base: { sha: baseSha, ref: "main", repo: { full_name: "owner/repository" } },
    labels: labels.map((name) => ({ name }))
  };
}

function emptyReviewThreads() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }
    }
  };
}

function conditionalMutationClient(state, requests) {
  return client({
    retries: 0,
    fetch: async (url, options) => {
      const href = String(url);
      const method = options.method;
      requests.push({ href, method, body: options.body });
      if (href === "https://api.github.com/graphql") {
        return new Response(JSON.stringify(emptyReviewThreads()), {
          headers: { "content-type": "application/json" }
        });
      }
      if (method === "GET" && /\/pulls\/7$/.test(href)) {
        return new Response(JSON.stringify(pullState(state)));
      }
      if (method === "GET" && /\/pulls\/7\/reviews\?/.test(href)) {
        return new Response(JSON.stringify(state.reviews ?? []));
      }
      if (method === "POST" && /\/issues\/7\/labels$/.test(href)) {
        state.labels = [...new Set([...(state.labels ?? []), ...JSON.parse(options.body).labels])];
        if (state.loseLabelResponseOnce) {
          state.loseLabelResponseOnce = false;
          throw new TypeError("label response lost");
        }
        return new Response(JSON.stringify(state.labels.map((name) => ({ name }))), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }
  });
}

test("conditional pull mutations reject stale heads inside the GitHub adapter", async () => {
  const state = {};
  const requests = [];
  const github = conditionalMutationClient(state, requests);
  await github.beginPullMutation({
    repository: "owner/repository",
    pullRequest: {
      number: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      reviewFeedbackFrozen: true,
      reviewFeedback: []
    },
    policy: reviewPolicy
  });

  state.headSha = "c".repeat(40);
  await assert.rejects(
    github.createRepositoryDispatch("codekeeper_fix", { number: 7 }),
    /head SHA changed/
  );
  assert.equal(requests.some(({ href, method }) => method === "POST" && href.endsWith("/dispatches")), false);
});

test("canonical and legacy pause labels fail closed at pull and issue mutation guards", async () => {
  for (const pauseLabel of ["codekeeper:paused", "paused"]) {
    const state = { labels: [pauseLabel] };
    await assert.rejects(
      conditionalMutationClient(state, []).beginPullMutation({
        repository: "owner/repository",
        pullRequest: {
          number: 7,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          baseRef: "main",
          reviewFeedback: [],
        },
        policy: reviewPolicy,
      }),
      /is paused/,
    );

    const updatedAt = "2026-08-17T10:00:00Z";
    const issueClient = client({
      retries: 0,
      fetch: async () => new Response(JSON.stringify({
        number: 30,
        title: "Paused report",
        body: "Details",
        state: "open",
        updated_at: updatedAt,
        labels: [{ name: pauseLabel }],
      })),
    });
    await assert.rejects(
      issueClient.beginIssueMutation({
        issue: { number: 30, updatedAt },
        rejectPaused: true,
      }),
      /is paused/,
    );
  }
});

test("closing issue references include only merged pull requests", async () => {
  let requestBody;
  const github = client({
    retries: 0,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        data: {
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                nodes: [
                  { number: 3, url: "https://github.com/owner/repository/pull/3", merged: false, mergedAt: null, repository: { nameWithOwner: "owner/repository" } },
                  { number: 4, url: "https://github.com/owner/repository/pull/4", merged: true, mergedAt: "2026-08-12T10:00:00Z", repository: { nameWithOwner: "owner/repository" } },
                  { number: 5, url: "https://github.com/other/repository/pull/5", merged: true, mergedAt: "2026-08-13T10:00:00Z", repository: { nameWithOwner: "other/repository" } }
                ],
                pageInfo: { hasNextPage: false }
              }
            }
          }
        }
      }));
    }
  });

  assert.deepEqual(await github.listMergedPullRequestsClosingIssue(7), [
    { number: 5, url: "https://github.com/other/repository/pull/5", mergedAt: "2026-08-13T10:00:00Z", repository: "other/repository" },
    { number: 4, url: "https://github.com/owner/repository/pull/4", mergedAt: "2026-08-12T10:00:00Z", repository: "owner/repository" }
  ]);
  assert.match(requestBody.query, /closedByPullRequestsReferences/);
  assert.deepEqual(requestBody.variables, { owner: "owner", repo: "repository", number: 7, first: 100 });
});

test("conditional pull mutations reject changed labels and feedback inside the GitHub adapter", async () => {
  const state = {};
  const github = conditionalMutationClient(state, []);
  await github.beginPullMutation({
    repository: "owner/repository",
    pullRequest: {
      number: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      reviewFeedbackFrozen: true,
      reviewFeedback: []
    },
    policy: reviewPolicy
  });

  state.labels = ["human-label"];
  await assert.rejects(github.createComment(7, "stale"), /labels changed/);
  state.labels = [];
  state.reviews = [{ id: 91, body: "Fresh review feedback", user: { login: "reviewer" } }];
  await assert.rejects(github.createComment(7, "stale"), /review feedback changed/);
});

test("conditional pull mutations advance their own expected label state", async () => {
  const state = {};
  const requests = [];
  const github = conditionalMutationClient(state, requests);
  await github.beginPullMutation({
    repository: "owner/repository",
    pullRequest: {
      number: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      reviewFeedbackFrozen: true,
      reviewFeedback: []
    },
    policy: reviewPolicy
  });

  await github.addLabels(7, ["reviewed"]);
  await github.createRepositoryDispatch("codekeeper_review", { number: 7 });
  assert.equal(requests.some(({ href, method }) => method === "POST" && href.endsWith("/dispatches")), true);
});

test("conditional pull labels reconcile an applied mutation after response loss", async () => {
  const state = { loseLabelResponseOnce: true };
  const requests = [];
  const github = conditionalMutationClient(state, requests);
  await github.beginPullMutation({
    repository: "owner/repository",
    pullRequest: {
      number: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      reviewFeedbackFrozen: true,
      reviewFeedback: []
    },
    policy: reviewPolicy
  });

  await github.addLabels(7, ["auto repaired"]);
  await github.createRepositoryDispatch("codekeeper_fix", { number: 7 });
  assert.deepEqual(state.labels, ["auto repaired"]);
  assert.equal(requests.filter(({ method, href }) => method === "POST" && href.endsWith("/labels")).length, 1);
});

test("conditional issue comments rebase from the live issue timestamp", async () => {
  const marker = "<!-- codekeeper:issue-triage -->";
  const author = { login: "codekeeper[bot]", id: "123" };
  const commentUpdatedAt = "2026-08-05T10:01:00Z";
  let issueUpdatedAt = "2026-08-05T10:00:00Z";
  let comments = [];
  const issue = () => ({
    number: 7,
    title: "Report",
    body: "Details",
    state: "open",
    updated_at: issueUpdatedAt,
    labels: []
  });
  const github = client({
    retries: 0,
    fetch: async (url, options) => {
      const href = String(url);
      if (options.method === "GET" && /\/issues\/7\/comments\?/.test(href)) {
        return new Response(JSON.stringify(comments));
      }
      if (options.method === "POST" && /\/issues\/7\/comments$/.test(href)) {
        issueUpdatedAt = "2026-08-05T10:01:30Z";
        const comment = {
          id: 70,
          body: JSON.parse(options.body).body,
          created_at: commentUpdatedAt,
          updated_at: commentUpdatedAt,
          user: { login: author.login, id: Number(author.id), type: "Bot" }
        };
        comments = [comment];
        return new Response(JSON.stringify(comment), { status: 201 });
      }
      if (options.method === "GET" && /\/issues\/7$/.test(href)) {
        return new Response(JSON.stringify(issue()));
      }
      return new Response(null, { status: 204 });
    }
  });

  await github.beginIssueMutation({
    issue: { number: 7, updatedAt: issueUpdatedAt },
    trackSubject: true,
    trackComments: true
  });
  await github.upsertOwnedIssueMarker(7, marker, "Triage result", author);

  assert.notEqual(commentUpdatedAt, issueUpdatedAt);
  await github.verifyIssueMutation();
});

test("conditional issue mutations allow closed issues only for resolution reconciliation", async () => {
  const updatedAt = "2026-08-14T19:36:22Z";
  const github = client({
    retries: 0,
    fetch: async () => new Response(JSON.stringify({
      number: 30,
      title: "Resolved report",
      body: "Details",
      state: "closed",
      updated_at: updatedAt,
      labels: [],
    })),
  });

  await assert.rejects(
    github.beginIssueMutation({ issue: { number: 30, updatedAt } }),
    /no longer eligible/
  );
  await github.beginIssueMutation({
    issue: { number: 30, updatedAt },
    allowClosed: true,
  });
  await github.verifyIssueMutation();
});

test("secondary issue mutations reject inventory drift and advance after their own update", async () => {
  const state = {
    issue: {
      number: 9,
      title: "Deferred report",
      body: "Original body",
      state: "open",
      state_reason: null,
      updated_at: "2026-08-16T10:00:00Z",
      labels: [{ name: "codekeeper:deferred" }],
      user: { login: "codekeeper[bot]", id: 123, type: "Bot" }
    },
    comments: []
  };
  const writes = [];
  const github = client({
    retries: 0,
    fetch: async (url, options) => {
      const href = String(url);
      const changes = options.body ? JSON.parse(options.body) : null;
      if (options.method === "GET" && /\/issues\/9\/comments\?/.test(href)) {
        return new Response(JSON.stringify(state.comments));
      }
      if (options.method === "GET" && /\/issues\/9$/.test(href)) {
        return new Response(JSON.stringify(state.issue));
      }
      if (options.method === "PATCH" && /\/issues\/9$/.test(href)) {
        writes.push({ method: options.method, changes });
        Object.assign(state.issue, changes, { updated_at: "2026-08-16T10:01:00Z" });
        return new Response(JSON.stringify(state.issue));
      }
      if (options.method === "POST" && /\/issues\/9\/labels$/.test(href)) {
        writes.push({ method: options.method, changes });
        state.issue.labels = [...state.issue.labels, ...changes.labels.map((name) => ({ name }))];
        state.issue.updated_at = "2026-08-16T10:02:00Z";
        return new Response(JSON.stringify(state.issue.labels));
      }
      return new Response(null, { status: 204 });
    }
  });

  const inventory = structuredClone(state.issue);
  for (const { name, mutate, expected } of [
    { name: "title", mutate: (issue) => { issue.title = "Human edit"; }, expected: /changed after inventory/ },
    { name: "state", mutate: (issue) => { issue.state = "closed"; }, expected: /no longer eligible/ },
    { name: "labels", mutate: (issue) => { issue.labels = [{ name: "human-label" }]; }, expected: /labels changed after inventory/ },
    { name: "timestamp", mutate: (issue) => { issue.updated_at = "2026-08-16T10:00:30Z"; }, expected: /changed after inventory/ }
  ]) {
    state.issue = structuredClone(inventory);
    writes.length = 0;
    await github.beginSecondaryIssueMutation({ issue: structuredClone(state.issue) });
    mutate(state.issue);
    await assert.rejects(github.updateIssue(9, { body: "Codekeeper update" }), expected, name);
    assert.deepEqual(writes, [], `${name} drift must not issue a write`);
    github.endSecondaryIssueMutation();
  }

  state.issue = structuredClone(inventory);
  await github.beginSecondaryIssueMutation({ issue: structuredClone(state.issue) });
  await github.updateIssue(9, { body: "Codekeeper update" });
  await github.replaceManagedLabels(
    9,
    ["codekeeper:deferred", "codekeeper:type-testing"],
    ["codekeeper:deferred", "codekeeper:type-testing"],
  );
  assert.deepEqual(writes.map(({ method }) => method), ["PATCH", "POST"]);
  assert.deepEqual(state.issue.labels.map(({ name }) => name), [
    "codekeeper:deferred",
    "codekeeper:type-testing",
  ]);
  await github.endSecondaryIssueMutation();
});

test("secondary issue mutations reject comment drift before reconciliation", async () => {
  const issue = {
    number: 10, title: "Maintenance report", body: "Original", state: "open",
    updated_at: "2026-08-16T10:00:00Z", labels: [], user: { login: "codekeeper[bot]", id: 123, type: "Bot" }
  };
  let comments = [];
  let writes = 0;
  const github = client({
    retries: 0,
    fetch: async (url, options) => {
      const href = String(url);
      if (options.method === "GET" && /\/issues\/10\/comments\?/.test(href)) return new Response(JSON.stringify(comments));
      if (options.method === "GET" && /\/issues\/10$/.test(href)) return new Response(JSON.stringify(issue));
      if (options.method === "PATCH" && /\/issues\/10$/.test(href)) {
        writes += 1;
        return new Response(JSON.stringify(issue));
      }
      return new Response(null, { status: 204 });
    }
  });
  await github.beginSecondaryIssueMutation({ issue: structuredClone(issue) });
  comments = [{
    id: 41, body: "Human note", created_at: "2026-08-16T10:00:30Z", updated_at: "2026-08-16T10:00:30Z",
    user: { login: "maintainer", id: 456, type: "User" }
  }];
  await assert.rejects(github.updateIssue(10, { body: "Codekeeper update" }), /comments changed after inventory/);
  assert.equal(writes, 0);
  await github.endSecondaryIssueMutation();
});

test("review replies update the App-owned marker in the originating thread", async () => {
  const marker = "<!-- codekeeper:deferred-reply=test -->";
  const requests = [];
  const github = client({
    fetch: async (url, options) => {
      requests.push({ url: String(url), method: options.method, body: options.body });
      if (options.method === "GET") {
        return new Response(JSON.stringify([{
          id: 99,
          in_reply_to_id: 41,
          body: `Old reply\n${marker}`,
          user: { login: "codekeeper[bot]", id: 123, type: "Bot" }
        }]));
      }
      return new Response(JSON.stringify({ id: 99 }), { status: 200 });
    }
  });

  await github.upsertReviewReply(7, 41, marker, "Updated reply", { login: "codekeeper[bot]", id: "123" });
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "PATCH"]);
  assert.match(requests[1].url, /\/pulls\/comments\/99$/);
  assert.equal(JSON.parse(requests[1].body).body, `Updated reply\n${marker}`);
});

test("retiring feedback updates only App-owned top-level and inline markers", async () => {
  const marker = "<!-- codekeeper:review-feedback-reply=" + "a".repeat(64) + " -->";
  const requests = [];
  const github = client({
    fetch: async (url, options) => {
      const href = String(url);
      requests.push({ url: href, method: options.method, body: options.body });
      if (options.method === "GET" && href.includes("/issues/7/comments")) {
        return new Response(JSON.stringify([
          { id: 11, body: `Old top-level reply\n${marker}`, user: { login: "codekeeper[bot]", id: 123, type: "Bot" } },
          { id: 12, body: `Spoofed reply\n${marker}`, user: { login: "person", id: 456, type: "User" } }
        ]));
      }
      if (options.method === "GET" && href.includes("/pulls/7/comments")) {
        return new Response(JSON.stringify([
          { id: 21, body: `Old inline reply\n${marker}`, user: { login: "codekeeper[bot]", id: 123, type: "Bot" } },
          { id: 22, body: `Other bot reply\n${marker}`, user: { login: "other[bot]", id: 789, type: "Bot" } }
        ]));
      }
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }
  });

  const updated = await github.retireReviewFeedbackReply(
    7,
    marker,
    "No longer current.",
    { login: "codekeeper[bot]", id: "123" }
  );

  assert.equal(updated, 2);
  const patches = requests.filter(({ method }) => method === "PATCH");
  assert.deepEqual(patches.map(({ url }) => url).sort(), [
    "https://api.github.com/repos/owner/repository/issues/comments/11",
    "https://api.github.com/repos/owner/repository/pulls/comments/21"
  ]);
  assert.ok(patches.every(({ body }) => JSON.parse(body).body === `No longer current.\n${marker}`));
});
