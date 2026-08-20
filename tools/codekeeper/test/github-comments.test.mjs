import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient, isOwnedMarkerComment } from "../src/lib/github.mjs";

const identity = { login: "codekeeper[bot]", id: "123456" };

function client(transport = {}) {
  return new GitHubClient({ token: "token", repository: "owner/repository", transport });
}

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

test("sticky marker comments ignore human and unrelated-bot spoofing", () => {
  const marker = "<!-- codekeeper:review -->";
  const trusted = {
    body: `Trusted review\n${marker}`,
    user: { login: identity.login, id: Number(identity.id), type: "Bot" }
  };
  assert.equal(isOwnedMarkerComment(trusted, marker, identity), true);
  assert.equal(isOwnedMarkerComment({ ...trusted, user: { login: "person", id: 123456, type: "User" } }, marker, identity), false);
  assert.equal(isOwnedMarkerComment({ ...trusted, user: { login: "other-app[bot]", id: 123456, type: "Bot" } }, marker, identity), false);
  assert.equal(isOwnedMarkerComment({ ...trusted, user: { ...trusted.user, id: 999 } }, marker, identity), false);
  assert.equal(isOwnedMarkerComment({ ...trusted, body: `${trusted.body}\nuntrusted suffix` }, marker, identity), false);
});
