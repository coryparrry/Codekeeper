import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";

function client(transport = {}) {
  return new GitHubClient({ token: "token", repository: "owner/repository", transport });
}

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
