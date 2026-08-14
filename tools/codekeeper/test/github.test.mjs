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

test("GitHub requests carry a finite abort deadline", async () => {
  let signal;
  const github = client({
    timeoutMs: 5,
    retries: 0,
    fetch: async (_url, options) => new Promise((_, reject) => {
      signal = options.signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });

  await assert.rejects(github.getIssue(1), /timed out after 5ms/);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);
});

test("GitHub keeps REST deadlines active while response bodies are read", async () => {
  const github = client({
    timeoutMs: 5,
    retries: 0,
    fetch: async () => new Response(new ReadableStream({ start() {} }))
  });

  await assert.rejects(github.getIssue(1), /timed out after 5ms/);
});

test("GitHub retries a REST response-body timeout within the capped budget", async () => {
  let attempts = 0;
  const github = client({
    timeoutMs: 5,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(new ReadableStream({ start() {} }))
        : new Response(JSON.stringify({ number: 1 }));
    }
  });

  assert.deepEqual(await github.getIssue(1), { number: 1 });
  assert.equal(attempts, 2);
});

test("GitHub retries a pull read until a newly pushed head is visible", async () => {
  const expectedHeadSha = "c".repeat(40);
  let attempts = 0;
  const github = client({
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(pullState({
        headSha: attempts === 1 ? "a".repeat(40) : expectedHeadSha
      })));
    }
  });

  const pull = await github.getPull(7, { expectedHeadSha });

  assert.equal(pull.head.sha, expectedHeadSha);
  assert.equal(attempts, 2);
});

test("GitHub does not retry a rejected pull read while waiting for a pushed head", async () => {
  let attempts = 0;
  const github = client({
    sleep: async () => { throw new Error("permission errors must not sleep"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
    }
  });

  await assert.rejects(
    github.getPull(7, { expectedHeadSha: "c".repeat(40) }),
    (error) => error.status === 403
  );
  assert.equal(attempts, 1);
});

test("GitHub does not retry an ambiguous mutation response-body timeout", async () => {
  let attempts = 0;
  const github = client({
    timeoutMs: 5,
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(new ReadableStream({ start() {} }), { status: 201 });
    }
  });

  await assert.rejects(
    github.createIssue({ title: "Finding", body: "Details" }),
    (error) => {
      assert.match(error.message, /timed out after 5ms/);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GHES pagination preserves the REST API path prefix", async () => {
  const urls = [];
  const github = new GitHubClient({
    token: "token",
    repository: "owner/repository",
    apiUrl: "https://ghe.example/api/v3",
    transport: {
      fetch: async (url) => {
        urls.push(String(url));
        const page = urls.length;
        return new Response(JSON.stringify(page === 1 ? [{ id: 1 }] : [{ id: 2 }]), {
          headers: page === 1
            ? { link: '<https://ghe.example/api/v3/repos/owner/repository/issues/7/comments?page=2>; rel="next"' }
            : {}
        });
      }
    }
  });

  assert.deepEqual(await github.listIssueComments(7), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(urls, [
    "https://ghe.example/api/v3/repos/owner/repository/issues/7/comments?per_page=100",
    "https://ghe.example/api/v3/repos/owner/repository/issues/7/comments?page=2"
  ]);
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

test("GitHub keeps GraphQL deadlines active while response bodies are read", async () => {
  const github = client({
    timeoutMs: 5,
    retries: 0,
    fetch: async () => new Response(new ReadableStream({ start() {} }), {
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(github.graphql("query { viewer { login } }"), /timed out after 5ms/);
});

test("GitHub retries transient network failures with a bounded budget", async () => {
  let attempts = 0;
  const delays = [];
  const github = client({
    sleep: async (delay) => { delays.push(delay); },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ number: 1 }));
    }
  });

  assert.deepEqual(await github.getIssue(1), { number: 1 });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});

test("GitHub caps Retry-After delays", async () => {
  let attempts = 0;
  const delays = [];
  const github = client({
    sleep: async (delay) => { delays.push(delay); },
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({ message: "slow down" }), { status: 429, headers: { "retry-after": "120" } })
        : new Response(JSON.stringify({ number: 1 }));
    }
  });

  await github.getIssue(1);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [5_000]);
});

test("GitHub caps rate-limit reset delays", async () => {
  let attempts = 0;
  const delays = [];
  const github = client({
    now: () => 1_000,
    sleep: async (delay) => { delays.push(delay); },
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "121" }
        })
        : new Response(JSON.stringify({ number: 1 }));
    }
  });

  await github.getIssue(1);
  assert.deepEqual(delays, [5_000]);
});

test("GitHub retries rate-limited 403 responses but not permission 403 responses", async () => {
  let rateLimitedAttempts = 0;
  const rateLimited = client({
    sleep: async () => {},
    fetch: async () => {
      rateLimitedAttempts += 1;
      return rateLimitedAttempts === 1
        ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0" } })
        : new Response(JSON.stringify({ number: 1 }));
    }
  });
  await rateLimited.getIssue(1);
  assert.equal(rateLimitedAttempts, 2);

  let permissionAttempts = 0;
  const permissionDenied = client({
    sleep: async () => { throw new Error("permission errors must not sleep"); },
    fetch: async () => {
      permissionAttempts += 1;
      return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
    }
  });
  await assert.rejects(permissionDenied.getIssue(1), (error) => {
    assert.equal(error.status, 403);
    assert.deepEqual(error.payload, { message: "Resource not accessible by integration" });
    return true;
  });
  assert.equal(permissionAttempts, 1);
});

test("GraphQL uses the same retrying transport", async () => {
  let attempts = 0;
  const signals = [];
  const github = client({
    sleep: async () => {},
    fetch: async (url, options) => {
      attempts += 1;
      signals.push(options.signal);
      assert.equal(url, "https://api.github.com/graphql");
      return attempts === 1
        ? new Response(JSON.stringify({ message: "temporarily unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ data: { viewer: { login: "codekeeper" } } }));
    }
  });

  assert.deepEqual(await github.graphql("query { viewer { login } }"), { viewer: { login: "codekeeper" } });
  assert.equal(attempts, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
});

test("GraphQL retries HTTP 200 rate-limit errors", async () => {
  let attempts = 0;
  const delays = [];
  const github = client({
    sleep: async (delay) => { delays.push(delay); },
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "rate limited" }] }))
        : new Response(JSON.stringify({ data: { viewer: { login: "codekeeper" } } }));
    }
  });

  assert.deepEqual(await github.graphql("query { viewer { login } }"), { viewer: { login: "codekeeper" } });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});

test("GraphQL marks mutation transport failures ambiguous without retrying", async () => {
  let attempts = 0;
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      throw new TypeError("connection lost");
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.match(error.message, /connection lost/);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL marks mutation response-body timeouts ambiguous without retrying", async () => {
  let attempts = 0;
  const github = client({
    timeoutMs: 5,
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" }
      });
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.match(error.message, /timed out after 5ms/);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL marks mutation errors with partial data ambiguous without retrying", async () => {
  let attempts = 0;
  const payload = {
    data: { updateIssue: { clientMutationId: "applied" } },
    errors: [{ type: "FORBIDDEN", message: "follow-up field failed" }]
  };
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(payload));
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.equal(error.status, 200);
      assert.deepEqual(error.payload, payload);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL marks mutation errors with execution paths ambiguous without retrying", async () => {
  let attempts = 0;
  const payload = {
    data: null,
    errors: [{ type: "INTERNAL", message: "mutation failed", path: ["updateIssue"] }]
  };
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(payload));
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.equal(error.status, 200);
      assert.deepEqual(error.payload, payload);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL keeps pathless data-null mutation errors deterministic without retrying", async () => {
  let attempts = 0;
  const payload = {
    data: null,
    errors: [{ type: "RATE_LIMITED", message: "rate limited" }]
  };
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(payload));
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.equal(error.status, 200);
      assert.deepEqual(error.payload, payload);
      assert.equal(error.githubMutationOutcome, undefined);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL does not attach mutation outcomes to partial query errors", async () => {
  const payload = {
    data: { viewer: { login: "codekeeper" } },
    errors: [{ type: "FORBIDDEN", message: "email unavailable", path: ["viewer", "email"] }]
  };
  const github = client({
    fetch: async () => new Response(JSON.stringify(payload))
  });

  await assert.rejects(github.graphql("query { viewer { login email } }"), (error) => {
    assert.equal(error.status, 200);
    assert.deepEqual(error.payload, payload);
    assert.equal(error.githubMutationOutcome, undefined);
    return true;
  });
});

test("GraphQL preserves exhausted HTTP 200 rate-limit errors", async () => {
  let attempts = 0;
  const delays = [];
  const github = client({
    sleep: async (delay) => { delays.push(delay); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "rate limited" }] }));
    }
  });

  await assert.rejects(github.graphql("query { viewer { login } }"), (error) => {
    assert.equal(error.status, 200);
    assert.deepEqual(error.payload, { errors: [{ type: "RATE_LIMITED", message: "rate limited" }] });
    return true;
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1_000]);
});

test("GraphQL does not retry deterministic HTTP 200 errors", async () => {
  let attempts = 0;
  const github = client({
    sleep: async () => { throw new Error("deterministic errors must not sleep"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "not permitted" }] }));
    }
  });

  await assert.rejects(github.graphql("query { viewer { login } }"), (error) => {
    assert.equal(error.status, 200);
    assert.deepEqual(error.payload, { errors: [{ type: "FORBIDDEN", message: "not permitted" }] });
    return true;
  });
  assert.equal(attempts, 1);
});

test("GitHub stops retrying after the capped budget", async () => {
  let attempts = 0;
  const delays = [];
  const github = client({
    retries: 99,
    sleep: async (delay) => { delays.push(delay); },
    fetch: async () => {
      attempts += 1;
      throw new TypeError("network unavailable");
    }
  });

  await assert.rejects(github.getIssue(1), /network unavailable/);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1_000]);
});
