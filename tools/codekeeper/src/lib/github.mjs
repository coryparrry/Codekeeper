const API_VERSION = "2022-11-28";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 429]);
const TRANSIENT_GRAPHQL_ERROR_TYPES = new Set(["INTERNAL", "INTERNAL_ERROR", "RATE_LIMITED", "SERVICE_UNAVAILABLE"]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveFiniteNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function retryAttempts(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_RETRY_ATTEMPTS)
    : fallback;
}

function retryAfterMilliseconds(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}

function rateLimitResetMilliseconds(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000 - now()) : null;
}

function isRateLimited(response) {
  return response.status === 403 && (
    response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
  );
}

function isRetryableResponse(response) {
  return RETRYABLE_STATUS.has(response.status) || response.status >= 500 || isRateLimited(response);
}

function cappedDelay(milliseconds) {
  return Math.min(Math.max(0, milliseconds), MAX_RETRY_DELAY_MS);
}

function isTransientFailure(error, signal) {
  return signal.aborted || error instanceof TypeError;
}

function awaitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => finish(reject, signal.reason ?? new Error("GitHub request aborted"));
    const finish = (settle, value) => {
      signal.removeEventListener("abort", abort);
      settle(value);
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function isRetryableGraphqlPayload(payload) {
  return payload?.errors?.some((error) =>
    TRANSIENT_GRAPHQL_ERROR_TYPES.has(String(error?.type ?? error?.extensions?.code ?? "").toUpperCase())
  );
}

function isRetrySafeMethod(method) {
  return ["GET", "HEAD"].includes(String(method).toUpperCase());
}

function isGraphqlMutation(query) {
  return /^\s*mutation\b/i.test(String(query));
}


function normalizeLogin(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeAutomationIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const login = normalizeLogin(identity.login);
  const id = String(identity.id ?? "").trim();
  if (!login.endsWith("[bot]") || !/^[1-9]\d*$/.test(id)) return null;
  return { login, id };
}

export function isOwnedMarkerComment(comment, marker, authorIdentity) {
  const expectedAuthor = normalizeAutomationIdentity(authorIdentity);
  return Boolean(
    expectedAuthor &&
    comment?.user?.type === "Bot" &&
    normalizeLogin(comment.user?.login) === expectedAuthor.login &&
    String(comment.user?.id ?? "") === expectedAuthor.id &&
    typeof comment?.body === "string" &&
    comment.body.endsWith(marker)
  );
}

export function resolveGraphqlUrl(apiUrl, configuredUrl = process.env.GITHUB_GRAPHQL_URL ?? "") {
  if (configuredUrl) return new URL(configuredUrl).toString().replace(/\/$/, "");
  const rest = new URL(apiUrl);
  if (rest.origin === "https://api.github.com" && rest.pathname === "/") {
    return "https://api.github.com/graphql";
  }
  if (/\/api\/v3\/?$/.test(rest.pathname)) {
    return `${rest.origin}/api/graphql`;
  }
  throw new Error("GITHUB_GRAPHQL_URL is required when GITHUB_API_URL is not github.com or a GHES /api/v3 endpoint");
}

function parseLinkHeader(value) {
  const links = {};
  for (const part of String(value ?? "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

export class GitHubClient {
  constructor({
    token,
    repository = process.env.GITHUB_REPOSITORY,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    graphqlUrl,
    transport = {}
  }) {
    if (!token) throw new Error("GitHub token is required");
    if (!repository || !repository.includes("/")) throw new Error("Repository must be owner/name");
    const [owner, repo] = repository.split("/", 2);
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.graphqlUrl = resolveGraphqlUrl(this.apiUrl, graphqlUrl);
    this.fetch = typeof transport.fetch === "function" ? transport.fetch : globalThis.fetch;
    this.requestTimeoutMs = positiveFiniteNumber(transport.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.retryAttempts = retryAttempts(transport.retries, DEFAULT_RETRY_ATTEMPTS);
    this.sleep = typeof transport.sleep === "function" ? transport.sleep : sleep;
    this.now = typeof transport.now === "function" ? transport.now : Date.now;
  }

  retryDelay(response, attempt) {
    const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"), this.now);
    if (retryAfter !== null) return cappedDelay(retryAfter);
    const reset = rateLimitResetMilliseconds(response.headers.get("x-ratelimit-reset"), this.now);
    if (reset !== null) return cappedDelay(reset);
    return cappedDelay(500 * 2 ** attempt);
  }

  async fetchWithRetry(url, options, { retries = this.retryAttempts, consume, retryPayload = () => false } = {}) {
    const retryBudget = retryAttempts(retries, this.retryAttempts);
    for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error(`GitHub request timed out after ${this.requestTimeoutMs}ms`)),
        this.requestTimeoutMs
      );
      let delay = null;
      try {
        const response = await this.fetch(url, { ...options, signal: controller.signal });
        if (isRetryableResponse(response) && attempt < retryBudget) {
          delay = this.retryDelay(response, attempt);
        } else {
          const value = await consume(response, controller.signal);
          if (!retryPayload(value) || attempt === retryBudget) return value;
          delay = this.retryDelay(response, attempt);
        }
      } catch (error) {
        if (!isTransientFailure(error, controller.signal) || attempt === retryBudget) throw error;
        delay = cappedDelay(500 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
      await this.sleep(delay);
    }
    throw new Error("GitHub retry budget exhausted");
  }

  async request(method, endpoint, { body, headers = {}, retries } = {}) {
    const url = endpoint.startsWith("http") ? endpoint : `${this.apiUrl}${endpoint}`;
    const retryBudget = retries ?? (isRetrySafeMethod(method) ? this.retryAttempts : 0);
    const { response, text, payload } = await this.fetchWithRetry(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "codekeeper",
        "Content-Type": "application/json",
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, {
      retries: retryBudget,
      consume: async (response, signal) => {
        const text = await awaitWithSignal(response.text(), signal);
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = text;
          }
        }
        return { response, text, payload };
      }
    });
    if (!response.ok) {
      const message = typeof payload === "object" && payload?.message ? payload.message : text || response.statusText;
      const error = new Error(`GitHub ${method} ${endpoint} failed (${response.status}): ${message}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return { data: payload, headers: response.headers, status: response.status };
  }

  async paginate(endpoint, { limit = Number.POSITIVE_INFINITY, predicate = () => true } = {}) {
    if (!(limit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(limit) && limit > 0))) {
      throw new Error("Pagination limit must be a positive integer");
    }
    const results = [];
    let url = endpoint.includes("?") ? `${endpoint}&per_page=100` : `${endpoint}?per_page=100`;
    while (url && results.length < limit) {
      const response = await this.request("GET", url);
      if (!Array.isArray(response.data)) throw new Error(`Expected array from ${url}`);
      for (const item of response.data) {
        if (!predicate(item)) continue;
        results.push(item);
        if (results.length === limit) break;
      }
      const links = parseLinkHeader(response.headers.get("link"));
      url = links.next ?? "";
    }
    return results;
  }

  repoPath(suffix) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
  }

  async getPull(number) {
    return (await this.request("GET", this.repoPath(`/pulls/${number}`))).data;
  }

  async getIssue(number) {
    return (await this.request("GET", this.repoPath(`/issues/${number}`))).data;
  }

  async listPullFiles(number, limit) {
    return this.paginate(this.repoPath(`/pulls/${number}/files`), { limit });
  }

  async listIssueComments(number) {
    return this.paginate(this.repoPath(`/issues/${number}/comments`));
  }

  async listOpenPulls() {
    return this.paginate(this.repoPath("/pulls?state=open&sort=updated&direction=desc"));
  }

  async listMaintenanceIssues(label = "codekeeper:maintenance") {
    const encoded = encodeURIComponent(label);
    const items = await this.paginate(this.repoPath(`/issues?state=all&labels=${encoded}&sort=updated&direction=desc`));
    return items.filter((item) => !item.pull_request);
  }

  async listOpenIssues(limit = 50) {
    return this.paginate(this.repoPath("/issues?state=open&sort=updated&direction=desc"), {
      limit,
      predicate: (item) => !item.pull_request
    });
  }

  async createIssue({ title, body, labels = [] }) {
    return (await this.request("POST", this.repoPath("/issues"), { body: { title, body, labels } })).data;
  }

  async updateIssue(number, changes) {
    return (await this.request("PATCH", this.repoPath(`/issues/${number}`), { body: changes })).data;
  }

  async createComment(number, body) {
    return (await this.request("POST", this.repoPath(`/issues/${number}/comments`), { body: { body } })).data;
  }

  async updateComment(commentId, body) {
    return (await this.request("PATCH", this.repoPath(`/issues/comments/${commentId}`), { body: { body } })).data;
  }

  async upsertMarkerComment(number, marker, body, authorIdentity) {
    const expectedAuthor = normalizeAutomationIdentity(authorIdentity);
    if (!expectedAuthor) {
      throw new Error("A configured GitHub App bot identity is required for marker comments");
    }
    const comments = await this.listIssueComments(number);
    const existing = comments.find((comment) =>
      isOwnedMarkerComment(comment, marker, expectedAuthor)
    );
    const content = `${body}\n${marker}`;
    return existing ? this.updateComment(existing.id, content) : this.createComment(number, content);
  }

  async ensureLabel(name, definition) {
    const endpoint = this.repoPath(`/labels/${encodeURIComponent(name)}`);
    try {
      await this.request("GET", endpoint);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await this.request("POST", this.repoPath("/labels"), {
          body: { name, color: definition.color, description: definition.description ?? "" }
        });
      } catch (createError) {
        if (createError.status !== 422) throw createError;
        await this.request("GET", endpoint);
      }
    }
  }

  async ensureLabels(definitions, names) {
    for (const name of [...new Set(names)]) {
      const definition = definitions[name];
      if (!definition) throw new Error(`No label definition for ${name}`);
      await this.ensureLabel(name, definition);
    }
  }

  async replaceManagedLabels(number, desired, managed) {
    const managedSet = new Set(managed);
    const desiredSet = new Set(desired);
    const unmanaged = [...desiredSet].filter((label) => !managedSet.has(label));
    if (unmanaged.length > 0) {
      throw new Error(`Attempted to mutate labels outside configured ownership: ${unmanaged.join(", ")}`);
    }
    const issue = await this.getIssue(number);
    const existing = (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
    const additions = [...desiredSet].filter((label) => !existing.includes(label));
    if (additions.length > 0) {
      await this.request("POST", this.repoPath(`/issues/${number}/labels`), { body: { labels: additions } });
    }
    for (const label of existing) {
      if (!managedSet.has(label) || desiredSet.has(label)) continue;
      try {
        await this.request("DELETE", this.repoPath(`/issues/${number}/labels/${encodeURIComponent(label)}`));
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
  }

  async findOpenPullByHead(branch) {
    const head = encodeURIComponent(`${this.owner}:${branch}`);
    const pulls = await this.paginate(this.repoPath(`/pulls?state=open&head=${head}`), { limit: 1 });
    return pulls.find((pull) => pull.head?.ref === branch && pull.head?.repo?.full_name === this.repository) ?? null;
  }

  async getBranchTip(branch) {
    let branchData;
    try {
      branchData = (await this.request("GET", this.repoPath(`/branches/${encodeURIComponent(branch)}`))).data;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    const treeSha = branchData?.commit?.commit?.tree?.sha;
    const parentShas = branchData?.commit?.parents?.map((parent) => parent?.sha);
    if (typeof treeSha !== "string" || !Array.isArray(parentShas) || parentShas.some((sha) => typeof sha !== "string")) {
      throw new Error(`GitHub branch ${branch} has an invalid commit shape`);
    }
    return { treeSha, parentShas };
  }

  async deleteBranch(branch) {
    return this.request("DELETE", this.repoPath(`/git/refs/heads/${encodeURIComponent(branch)}`));
  }

  async createPull({ title, body, head, base, draft = true }) {
    return (
      await this.request("POST", this.repoPath("/pulls"), {
        body: { title, body, head, base, draft, maintainer_can_modify: true }
      })
    ).data;
  }

  async enableAutoMerge(pullRequestNodeId, mergeMethod = "SQUASH") {
    const query = `
      mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
          pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
        }
      }
    `;
    return this.graphql(query, { pullRequestId: pullRequestNodeId, mergeMethod });
  }

  async disableAutoMerge(pullRequestNodeId) {
    const query = `
      mutation DisableAutoMerge($pullRequestId: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
          pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
        }
      }
    `;
    return this.graphql(query, { pullRequestId: pullRequestNodeId });
  }

  async graphql(query, variables = {}) {
    const retries = isGraphqlMutation(query) ? 0 : this.retryAttempts;
    const { response, payload } = await this.fetchWithRetry(this.graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "codekeeper",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    }, {
      retries,
      consume: async (response, signal) => ({
        response,
        payload: await awaitWithSignal(response.json(), signal)
      }),
      retryPayload: ({ payload }) => isRetryableGraphqlPayload(payload)
    });
    if (!response.ok || payload.errors?.length) {
      const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
      const error = new Error(`GitHub GraphQL failed: ${message}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload.data;
  }
}
