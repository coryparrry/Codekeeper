import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/lib/github.mjs";

function client(transport = {}) {
  return new GitHubClient({ token: "token", repository: "owner/repository", transport });
}

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
    /timed out after 5ms/
  );
  assert.equal(attempts, 1);
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

test("GraphQL does not retry ambiguous mutation failures", async () => {
  let attempts = 0;
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "rate limited" }] }));
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.equal(error.status, 200);
      assert.deepEqual(error.payload, { errors: [{ type: "RATE_LIMITED", message: "rate limited" }] });
      return true;
    }
  );
  assert.equal(attempts, 1);
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
