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
