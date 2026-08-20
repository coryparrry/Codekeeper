import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient, resolveGraphqlUrl } from "../src/lib/github.mjs";

function client(transport = {}) {
  return new GitHubClient({ token: "token", repository: "owner/repository", transport });
}

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

test("GitHub retries a pull read until a newly pushed head is visible", async () => {
  const expectedHeadSha = "c".repeat(40);
  let attempts = 0;
  const github = client({
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(pullState({
        headSha: attempts === 1 ? "a".repeat(40) : expectedHeadSha
      })));
    }
  });

  const pull = await github.getPull(7, { expectedHeadSha });

  assert.equal(pull.head.sha, expectedHeadSha);
  assert.equal(attempts, 2);
});

test("GitHub does not retry a rejected pull read while waiting for a pushed head", async () => {
  let attempts = 0;
  const github = client({
    sleep: async () => { throw new Error("permission errors must not sleep"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ message: "Resource not accessible by integration" }), { status: 403 });
    }
  });

  await assert.rejects(
    github.getPull(7, { expectedHeadSha: "c".repeat(40) }),
    (error) => error.status === 403
  );
  assert.equal(attempts, 1);
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
    (error) => {
      assert.match(error.message, /timed out after 5ms/);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
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

test("GraphQL marks mutation transport failures ambiguous without retrying", async () => {
  let attempts = 0;
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      throw new TypeError("connection lost");
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.match(error.message, /connection lost/);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL marks mutation response-body timeouts ambiguous without retrying", async () => {
  let attempts = 0;
  const github = client({
    timeoutMs: 5,
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "content-type": "application/json" }
      });
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.match(error.message, /timed out after 5ms/);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL marks mutation errors with partial data ambiguous without retrying", async () => {
  let attempts = 0;
  const payload = {
    data: { updateIssue: { clientMutationId: "applied" } },
    errors: [{ type: "FORBIDDEN", message: "follow-up field failed" }]
  };
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(payload));
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.equal(error.status, 200);
      assert.deepEqual(error.payload, payload);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL marks mutation errors with execution paths ambiguous without retrying", async () => {
  let attempts = 0;
  const payload = {
    data: null,
    errors: [{ type: "INTERNAL", message: "mutation failed", path: ["updateIssue"] }]
  };
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(payload));
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.equal(error.status, 200);
      assert.deepEqual(error.payload, payload);
      assert.equal(error.githubMutationOutcome, "ambiguous");
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL keeps pathless data-null mutation errors deterministic without retrying", async () => {
  let attempts = 0;
  const payload = {
    data: null,
    errors: [{ type: "RATE_LIMITED", message: "rate limited" }]
  };
  const github = client({
    sleep: async () => { throw new Error("mutations must not be retried"); },
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify(payload));
    }
  });

  await assert.rejects(
    github.graphql("mutation Update { updateIssue(input: {}) { clientMutationId } }"),
    (error) => {
      assert.equal(error.status, 200);
      assert.deepEqual(error.payload, payload);
      assert.equal(error.githubMutationOutcome, undefined);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test("GraphQL does not attach mutation outcomes to partial query errors", async () => {
  const payload = {
    data: { viewer: { login: "codekeeper" } },
    errors: [{ type: "FORBIDDEN", message: "email unavailable", path: ["viewer", "email"] }]
  };
  const github = client({
    fetch: async () => new Response(JSON.stringify(payload))
  });

  await assert.rejects(github.graphql("query { viewer { login email } }"), (error) => {
    assert.equal(error.status, 200);
    assert.deepEqual(error.payload, payload);
    assert.equal(error.githubMutationOutcome, undefined);
    return true;
  });
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

test("GraphQL follows GitHub.com and GHES API origins and requires a configured URL otherwise", () => {
  assert.equal(resolveGraphqlUrl("https://api.github.com"), "https://api.github.com/graphql");
  assert.equal(resolveGraphqlUrl("https://api.github.com/"), "https://api.github.com/graphql");
  assert.equal(resolveGraphqlUrl("https://github.example/api/v3"), "https://github.example/api/graphql");
  assert.equal(resolveGraphqlUrl("https://github.example/api/v3/"), "https://github.example/api/graphql");
  assert.equal(
    resolveGraphqlUrl("https://github.example/api", "https://github.example/api/graphql/"),
    "https://github.example/api/graphql"
  );
  assert.throws(
    () => resolveGraphqlUrl("https://github.example/api"),
    /GITHUB_GRAPHQL_URL is required when GITHUB_API_URL is not github.com or a GHES \/api\/v3 endpoint/
  );
});

test("REST requests send bearer authentication and parse JSON bodies", async () => {
  let headers;
  const github = client({
    retries: 0,
    fetch: async (_url, options) => {
      headers = options.headers;
      return new Response(JSON.stringify({ number: 1 }), {
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.deepEqual(await github.getIssue(1), { number: 1 });
  assert.equal(headers.Authorization, "Bearer token");
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.equal(headers["User-Agent"], "codekeeper");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("REST requests preserve non-JSON error bodies and truncate nothing from GitHub messages", async () => {
  const github = client({
    retries: 0,
    fetch: async () => new Response("plain failure text", { status: 500, statusText: "Internal Server Error" })
  });

  await assert.rejects(github.getIssue(1), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.payload, "plain failure text");
    assert.equal(error.message, "GitHub GET /repos/owner/repository/issues/1 failed (500): plain failure text");
    return true;
  });
});

test("GraphQL follows the configured GitHub API host", () => {
  assert.equal(resolveGraphqlUrl("https://api.github.com"), "https://api.github.com/graphql");
  assert.equal(resolveGraphqlUrl("https://github.example/api/v3"), "https://github.example/api/graphql");
});
