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
