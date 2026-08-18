import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedReadCache,
  GitHubRequestBudget,
  paginationPolicyFor,
  parsePaginationLinks,
} from "../src/lib/github-budget.mjs";

test("pagination policies assign finite endpoint-specific page budgets", () => {
  assert.deepEqual(paginationPolicyFor("/repos/o/r/pulls/7/files"), {
    name: "pull-files",
    pages: 30,
  });
  assert.deepEqual(paginationPolicyFor("/repos/o/r/issues/7/comments"), {
    name: "issue-comments",
    pages: 20,
  });
  assert.deepEqual(paginationPolicyFor("/repos/o/r/pulls/7/reviews"), {
    name: "pull-reviews",
    pages: 5,
  });
  assert.deepEqual(paginationPolicyFor("/repos/o/r/labels"), {
    name: "default",
    pages: 10,
  });
});

test("request budgets count REST, GraphQL, pages, and cache hits", () => {
  const budget = new GitHubRequestBudget({ maximumRequests: 3 });
  budget.consumeTransport("https://api.github.com/repos/o/r/issues", "GET");
  budget.consumeTransport("https://api.github.com/graphql", "POST");
  budget.recordPage("issue-inventory");
  budget.recordCacheHit();
  assert.deepEqual(budget.snapshot(), {
    maximumRequests: 3,
    requests: 2,
    restRequests: 1,
    graphqlRequests: 1,
    cacheHits: 1,
    paginationPages: { "issue-inventory": 1 },
  });
});

test("request budgets fail before issuing an excess transport request", () => {
  const budget = new GitHubRequestBudget({ maximumRequests: 1 });
  budget.consumeTransport("https://api.github.com/repos/o/r", "GET");
  assert.throws(
    () => budget.consumeTransport("https://api.github.com/repos/o/r/issues", "GET"),
    /request budget of 1 was exhausted/,
  );
});

test("bounded read cache clones values and never grows past its limit", async () => {
  let loads = 0;
  let hits = 0;
  const cache = new BoundedReadCache({ maximumEntries: 1, onHit: () => hits += 1 });
  const first = await cache.get("first", async () => ({ nested: { value: ++loads } }));
  first.nested.value = 99;
  assert.deepEqual(await cache.get("first", async () => ({ nested: { value: ++loads } })), {
    nested: { value: 1 },
  });
  assert.deepEqual(await cache.get("second", async () => ({ nested: { value: ++loads } })), {
    nested: { value: 2 },
  });
  assert.deepEqual(await cache.get("second", async () => ({ nested: { value: ++loads } })), {
    nested: { value: 3 },
  });
  assert.equal(hits, 1);
});

test("pagination link parsing retains only explicit relation URLs", () => {
  assert.deepEqual(
    parsePaginationLinks(
      '<https://api.github.com/items?page=2>; rel="next", <https://api.github.com/items?page=4>; rel="last"',
    ),
    {
      next: "https://api.github.com/items?page=2",
      last: "https://api.github.com/items?page=4",
    },
  );
});
