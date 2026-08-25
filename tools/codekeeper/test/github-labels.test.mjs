import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { LABELS } from "../src/lib/label-ownership.mjs";
import { labelMethods } from "../src/lib/github/labels.mjs";
import { managedLifecycleLabels } from "../src/lib/publish/common.mjs";

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

test("conditional pull label removal reconciles an applied mutation after response loss", async () => {
  const endpoint =
    "/repos/owner/repository/issues/7/labels/codekeeper%3Apaused";
  let advanced = null;
  const github = {
    pullMutation: { number: 7, labels: ["codekeeper:paused"] },
    repoPath(value) {
      return `/repos/owner/repository${value}`;
    },
    async request(method, actualEndpoint) {
      assert.equal(method, "DELETE");
      assert.equal(actualEndpoint, endpoint);
      const error = new Error("label removal response lost");
      error.githubMutationOutcome = "ambiguous";
      throw error;
    },
    async getPull(number) {
      assert.equal(number, 7);
      return pullState({ labels: [] });
    },
    assertPullMutationIdentity(pull) {
      assert.equal(pull.number, 7);
    },
    advancePullMutationState(method, actualEndpoint) {
      advanced = [method, actualEndpoint];
    },
  };
  await labelMethods.removeLabel.call(github, 7, "codekeeper:paused", "lifecycle");
  assert.deepEqual(advanced, ["DELETE", endpoint]);
});

test("Codekeeper label management preserves existing metadata and unrelated labels", async () => {
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
      if (target.endsWith("/issues/7") && method === "GET") return json({ labels: [{ name: "external" }, { name: "codekeeper:risk-high" }] });
      if (target.endsWith("/issues/7/labels") && method === "POST") return json({});
      if (target.endsWith("/issues/7/labels/codekeeper%3Arisk-high") && method === "DELETE") return new Response(null, { status: 204 });
      if (target.endsWith("/labels") && method === "POST") return json({ message: "already exists" }, 422);
      throw new Error(`Unexpected request ${method} ${target}`);
    };
    const github = new GitHubClient({ token: "token", repository: "owner/repository" });
    await github.ensureLabel("existing", { color: "000000", description: "must not overwrite" });
    await github.ensureLabel("race", { color: "000000", description: "create race" });
    await github.replaceManagedLabels(7, ["codekeeper:reviewed"], ["codekeeper:reviewed", "codekeeper:risk-high"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.some((call) => call.method === "PATCH"), false);
  assert.equal(calls.some((call) => call.target.endsWith("/issues/7") && call.method === "PATCH"), false);
  const add = calls.find((call) => call.target.endsWith("/issues/7/labels") && call.method === "POST");
  assert.deepEqual(JSON.parse(add.body), { labels: ["codekeeper:reviewed"] });
  assert.ok(calls.some((call) => call.target.endsWith("/issues/7/labels/codekeeper%3Arisk-high") && call.method === "DELETE"));
});

test("mode-specific reconciliation fails closed, preserves cross-mode labels, and is idempotent", async () => {
  const labels = ["human-owned", LABELS.BUG, LABELS.CHANGES_REQUIRED];
  const calls = [];
  const github = {
    repoPath(value) {
      return `/repos/owner/repository${value}`;
    },
    async getIssue() {
      return { number: 7, labels: labels.map((name) => ({ name })) };
    },
    async request(method, endpoint) {
      calls.push({ method, endpoint });
      if (method === "DELETE") labels.splice(labels.indexOf(decodeURIComponent(endpoint.split("/").at(-1))), 1);
      return { data: {} };
    }
  };

  await assert.rejects(
    labelMethods.replaceManagedLabels.call(github, 7, [LABELS.BUG], [LABELS.BUG], "pull-request"),
    /outside Codekeeper ownership: bug \(mode: pull-request\)/
  );
  await assert.rejects(
    labelMethods.replaceManagedLabels.call(github, 7, [LABELS.CHANGES_REQUIRED], [LABELS.CHANGES_REQUIRED], "issue"),
    /outside Codekeeper ownership: changes required \(mode: issue\)/
  );

  await labelMethods.replaceManagedLabels.call(github, 7, [], [LABELS.CHANGES_REQUIRED], "pull-request");
  assert.deepEqual(labels, ["human-owned", LABELS.BUG]);
  const mutationCount = calls.length;
  await labelMethods.replaceManagedLabels.call(github, 7, [], [LABELS.CHANGES_REQUIRED], "pull-request");
  assert.equal(calls.length, mutationCount);
  await labelMethods.replaceManagedLabels.call(github, 7, [], [LABELS.BUG], "issue");
  assert.deepEqual(labels, ["human-owned"]);
});

test("real adapter reconciles a narrow lifecycle set and issue-specific needs-tests", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const state = {
    labels: [
      { name: "human-owned" },
      { name: LABELS.REVIEW_NEEDED },
    ],
  };
  try {
    globalThis.fetch = async (url, options = {}) => {
      const method = options.method ?? "GET";
      const pathname = new URL(url).pathname;
      calls.push({ method, pathname, body: options.body });
      if (method === "GET" && pathname.endsWith("/issues/7")) {
        return new Response(JSON.stringify({ number: 7, labels: state.labels }), { status: 200 });
      }
      if (method === "DELETE" && pathname.endsWith(`/labels/${encodeURIComponent(LABELS.REVIEW_NEEDED)}`)) {
        state.labels = state.labels.filter(({ name }) => name !== LABELS.REVIEW_NEEDED);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && pathname.endsWith("/issues/7/labels")) {
        const { labels } = JSON.parse(options.body);
        state.labels = [
          ...state.labels,
          ...labels.filter((name) => !state.labels.some(({ name: current }) => current === name)).map((name) => ({ name })),
        ];
        return new Response(JSON.stringify(state.labels), { status: 200 });
      }
      throw new Error(`Unexpected ${method} ${pathname}`);
    };
    const github = new GitHubClient({ token: "token", repository: "owner/repository" });
    await github.replaceManagedLabels(
      7,
      [],
      managedLifecycleLabels([LABELS.REVIEW_NEEDED]),
      "lifecycle",
    );
    await github.replaceManagedLabels(
      7,
      [LABELS.ISSUE_NEEDS_TESTS],
      [LABELS.ISSUE_NEEDS_TESTS],
      "issue",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(state.labels.map(({ name }) => name).sort(), ["human-owned", LABELS.ISSUE_NEEDS_TESTS].sort());
  assert.ok(calls.some(({ method, pathname }) => method === "DELETE" && pathname.endsWith(`/labels/${encodeURIComponent(LABELS.REVIEW_NEEDED)}`)));
  assert.ok(calls.some(({ method, pathname }) => method === "POST" && pathname.endsWith("/issues/7/labels")));
});

test("direct label removal requires explicit authority and cannot cross modes", async () => {
  const calls = [];
  const github = {
    repoPath(value) {
      return `/repos/owner/repository${value}`;
    },
    async request(method, endpoint) {
      calls.push({ method, endpoint });
      return { data: {} };
    }
  };

  await assert.rejects(
    labelMethods.removeLabel.call(github, 7, LABELS.PAUSED),
    /Unknown label removal authority: undefined/
  );
  await assert.rejects(
    labelMethods.removeLabel.call(github, 7, LABELS.READY_FOR_FIX, "pull-request"),
    /outside pull-request ownership: ready for fix/
  );
  await labelMethods.removeLabel.call(github, 7, LABELS.PAUSED, "lifecycle");
  assert.deepEqual(calls, [{
    method: "DELETE",
    endpoint: "/repos/owner/repository/issues/7/labels/paused"
  }]);
});
