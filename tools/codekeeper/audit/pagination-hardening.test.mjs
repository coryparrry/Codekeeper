import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";

test("pagination never follows an external next link with the GitHub bearer token", async () => {
  const calls = [];
  const client = new GitHubClient({
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
    await client.listIssueComments(7);
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

test("issue-comment pagination terminates on a cyclic next link", async () => {
  const githubModuleUrl = new URL("../src/lib/github.mjs", import.meta.url).href;
  const script = `
    import { GitHubClient } from ${JSON.stringify(githubModuleUrl)};
    const client = new GitHubClient({
      token: "audit-token",
      repository: "owner/repository",
      transport: {
        sleep: async () => {},
        fetch: async () => new Response("[]", {
          headers: { link: '<https://api.github.com/repos/owner/repository/issues/7/comments?page=1>; rel="next"' }
        })
      }
    });
    await client.listIssueComments(7);
  `;
  const child = spawn("node", ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "ignore"]
  });
  const outcome = await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 750);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  assert.equal(outcome.timedOut, false, "pagination followed a repeated next URL beyond its budget");
  assert.equal(outcome.signal, null);
  assert.notEqual(outcome.code, null, "pagination did not fail closed after detecting the cycle");
});
