import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";
import { parseLinkHeader } from "../src/lib/github/pagination.mjs";

function client(transport = {}) {
  return new GitHubClient({ token: "token", repository: "owner/repository", transport });
}

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

test("issue comment windows walk from the oldest REST page through the triggering comment without unsupported sort parameters", async () => {
  const urls = [];
  const github = client({
    fetch: async (url) => {
      const href = String(url);
      urls.push(href);
      if (href.endsWith("/issues/7/comments?per_page=40&page=1")) {
        return new Response(JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ id: index + 1 }))), {
          headers: {
            link: '<https://api.github.com/repos/owner/repository/issues/7/comments?per_page=40&page=2>; rel="next", <https://api.github.com/repos/owner/repository/issues/7/comments?per_page=40&page=2>; rel="last"'
          }
        });
      }
      return new Response(JSON.stringify([{ id: 41 }]), {
        headers: {
          link: '<https://api.github.com/repos/owner/repository/issues/7/comments?per_page=40&page=1>; rel="prev"'
        }
      });
    }
  });

  const recent = await github.listIssueCommentWindow(7, 41, 40);
  assert.deepEqual(recent.comments.map((comment) => comment.id).sort((left, right) => left - right), Array.from({ length: 41 }, (_, index) => index + 1));
  assert.equal(recent.truncatedBefore, false);
  assert.deepEqual(urls, [
    "https://api.github.com/repos/owner/repository/issues/7/comments?per_page=40&page=1",
    "https://api.github.com/repos/owner/repository/issues/7/comments?per_page=40&page=2"
  ]);
  assert.equal(urls.some((url) => url.includes("sort=") || url.includes("direction=")), false);
});

test("pagination never follows an external next link with the GitHub bearer token", async () => {
  const calls = [];
  const github = new GitHubClient({
    token: "audit-bearer-canary",
    repository: "owner/repository",
    transport: {
      fetch: async (url, options) => {
        calls.push({ url: String(url), authorization: options.headers.Authorization });
        if (calls.length === 1) {
          return new Response("[]", {
            headers: { link: '<https://attacker.example/collect?page=2>; rel="next"' }
          });
        }
        return new Response("[]");
      }
    }
  });
  let error;
  try {
    await github.listIssueComments(7);
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual({
    error: error?.message,
    requestCount: calls.length,
    secondRequest: calls[1]
  }, {
    error: "GitHub pagination returned an untrusted next URL",
    requestCount: 1,
    secondRequest: undefined
  });
});

test("GHES pagination rejects a same-origin next URL outside the REST API prefix", async () => {
  const calls = [];
  const github = new GitHubClient({
    token: "token",
    repository: "owner/repository",
    apiUrl: "https://ghe.example/api/v3",
    transport: {
      fetch: async (url, options) => {
        calls.push({ url: String(url), authorization: options.headers.Authorization });
        return new Response("[]", {
          headers: { link: '<https://ghe.example/repos/owner/repository/issues/7/comments?page=2>; rel="next"' }
        });
      }
    }
  });

  await assert.rejects(github.listIssueComments(7), /untrusted next URL/);
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://ghe.example/api/v3/repos/owner/repository/issues/7/comments?per_page=100"
  ]);
});

test("pagination fails closed on a repeated next URL", async () => {
  const github = client({
    sleep: async () => {},
    fetch: async () => new Response("[]", {
      headers: { link: '<https://api.github.com/repos/owner/repository/issues/7/comments?page=1>; rel="next"' }
    })
  });

  await assert.rejects(github.listIssueComments(7), /repeated next URL/);
});

test("pagination rejects a non-positive limit", async () => {
  const github = client({
    fetch: async () => {
      throw new Error("invalid pagination limits must not request GitHub");
    }
  });

  await assert.rejects(github.paginate("/repos/owner/repository/issues", { limit: 0 }), /Pagination limit must be a positive integer/);
  await assert.rejects(github.paginate("/repos/owner/repository/issues", { limit: -1 }), /Pagination limit must be a positive integer/);
  await assert.rejects(github.paginate("/repos/owner/repository/issues", { limit: 1.5 }), /Pagination limit must be a positive integer/);
});

test("issue-comment windows reject untrusted last links without following them", async () => {
  const calls = [];
  const github = client({
    fetch: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization });
      return new Response(JSON.stringify([{ id: 1 }]), {
        headers: {
          link: '<https://attacker.example/collect?page=9>; rel="last"'
        }
      });
    }
  });

  await assert.rejects(github.listIssueCommentWindow(7, 99, 40), /untrusted URL/);
  assert.equal(calls.length, 1);
});

test("issue-comment windows fail closed on a repeated page URL", async () => {
  const github = client({
    fetch: async (url) => {
      const href = String(url);
      if (href.endsWith("/issues/7/comments?per_page=40&page=1")) {
        return new Response(JSON.stringify([{ id: 1 }]), {
          headers: {
            link: '<https://api.github.com/repos/owner/repository/issues/7/comments?per_page=40&page=2>; rel="last"'
          }
        });
      }
      return new Response(JSON.stringify([{ id: 41 }]), {
        headers: {
          link: '<https://api.github.com/repos/owner/repository/issues/7/comments?per_page=40&page=2>; rel="prev"'
        }
      });
    }
  });

  await assert.rejects(github.listIssueCommentWindow(7, 99, 40), /repeated URL/);
});

test("GraphQL review-thread pagination follows endCursor until the connection ends", async () => {
  const afterValues = [];
  const github = client({
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      afterValues.push(body.variables.after);
      const page = afterValues.length;
      return new Response(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{
                  id: `thread-${page}`,
                  comments: { pageInfo: { hasNextPage: false } }
                }],
                pageInfo: {
                  hasNextPage: page === 1,
                  endCursor: page === 1 ? "cursor-1" : null
                }
              }
            }
          }
        }
      }));
    }
  });

  const threads = await github.listPullReviewThreads(7);
  assert.deepEqual(threads.map((thread) => thread.id), ["thread-1", "thread-2"]);
  assert.deepEqual(afterValues, [null, "cursor-1"]);
});

test("GraphQL review-thread pagination fails closed when a thread comment page is truncated", async () => {
  const github = client({
    fetch: async () => new Response(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: "thread-1", comments: { pageInfo: { hasNextPage: true } } }],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      }
    }))
  });

  await assert.rejects(github.listPullReviewThreads(7), /more than 100 comments/);
});

test("GraphQL review-thread pagination fails closed when the thread budget is exceeded", async () => {
  const github = client({
    fetch: async () => new Response(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: "thread-1", comments: { pageInfo: { hasNextPage: false } } }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" }
            }
          }
        }
      }
    }))
  });

  await assert.rejects(github.listPullReviewThreads(7, 1), /more than 1 review threads/);
});

test("REST Link parsing extracts rel targets and ignores malformed parts", () => {
  assert.deepEqual(parseLinkHeader(
    '<https://api.github.com/page/2>; rel="next", <https://api.github.com/page/9>; rel="last"'
  ), {
    next: "https://api.github.com/page/2",
    last: "https://api.github.com/page/9"
  });
  assert.deepEqual(parseLinkHeader(""), {});
  assert.deepEqual(parseLinkHeader(null), {});
  assert.deepEqual(parseLinkHeader("not-a-link"), {});
});
