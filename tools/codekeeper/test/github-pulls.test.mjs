import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";

function client(transport = {}) {
  return new GitHubClient({ token: "token", repository: "owner/repository", transport });
}

function graphqlClient(handler) {
  return client({
    retries: 0,
    fetch: async (url, options) => {
      assert.equal(String(url), "https://api.github.com/graphql");
      assert.equal(options.method, "POST");
      return handler(JSON.parse(options.body));
    }
  });
}

test("enableAutoMerge sends the pull request node id and merge method as GraphQL variables", async () => {
  let requestBody;
  const github = graphqlClient((body) => {
    requestBody = body;
    return new Response(JSON.stringify({
      data: {
        enablePullRequestAutoMerge: {
          pullRequest: { number: 7, autoMergeRequest: { enabledAt: "2026-08-19T10:00:00Z", mergeMethod: "SQUASH" } }
        }
      }
    }));
  });

  await github.enableAutoMerge("PR_7");
  assert.match(requestBody.query, /mutation EnableAutoMerge/);
  assert.match(requestBody.query, /enablePullRequestAutoMerge/);
  assert.deepEqual(requestBody.variables, { pullRequestId: "PR_7", mergeMethod: "SQUASH" });
});

test("disableAutoMerge sends the pull request node id as the GraphQL variable", async () => {
  let requestBody;
  const github = graphqlClient((body) => {
    requestBody = body;
    return new Response(JSON.stringify({
      data: {
        disablePullRequestAutoMerge: {
          pullRequest: { number: 7, autoMergeRequest: { enabledAt: null, mergeMethod: null } }
        }
      }
    }));
  });

  await github.disableAutoMerge("PR_7");
  assert.match(requestBody.query, /mutation DisableAutoMerge/);
  assert.match(requestBody.query, /disablePullRequestAutoMerge/);
  assert.deepEqual(requestBody.variables, { pullRequestId: "PR_7" });
});

test("branch tips normalize GitHub branch data and treat a missing branch as absent", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/branches/existing")) {
        return new Response(JSON.stringify({
          commit: { sha: "head", commit: { tree: { sha: "tree" } }, parents: [{ sha: "base" }] }
        }));
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    };
    const github = new GitHubClient({ token: "token", repository: "owner/repository" });
    assert.deepEqual(await github.getBranchTip("existing"), { headSha: "head", treeSha: "tree", parentShas: ["base"] });
    assert.equal(await github.getBranchTip("missing"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
