const DEFAULT_MAX_TRANSPORT_REQUESTS = 250;
const DEFAULT_MAX_IDENTITY_CACHE_ENTRIES = 64;

const PAGINATION_POLICIES = Object.freeze([
  Object.freeze({ name: "pull-files", pattern: /\/pulls\/\d+\/files(?:\?|$)/, pages: 30 }),
  Object.freeze({ name: "issue-comments", pattern: /\/issues\/\d+\/comments(?:\?|$)/, pages: 20 }),
  Object.freeze({ name: "pull-comments", pattern: /\/pulls\/\d+\/comments(?:\?|$)/, pages: 20 }),
  Object.freeze({ name: "pull-reviews", pattern: /\/pulls\/\d+\/reviews(?:\?|$)/, pages: 5 }),
  Object.freeze({ name: "issue-inventory", pattern: /\/issues(?:\?|$)/, pages: 20 }),
  Object.freeze({ name: "pull-inventory", pattern: /\/pulls(?:\?|$)/, pages: 10 }),
  Object.freeze({ name: "default", pattern: /.*/, pages: 10 }),
]);

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function endpointPath(endpoint, apiUrl = "https://api.github.com") {
  try {
    return new URL(endpoint, `${String(apiUrl).replace(/\/$/, "")}/`).pathname
      + new URL(endpoint, `${String(apiUrl).replace(/\/$/, "")}/`).search;
  } catch {
    return String(endpoint ?? "");
  }
}

export function paginationPolicyFor(endpoint, apiUrl) {
  const candidate = endpointPath(endpoint, apiUrl);
  const policy = PAGINATION_POLICIES.find((item) => item.pattern.test(candidate));
  return { name: policy.name, pages: policy.pages };
}

export function parsePaginationLinks(value) {
  const links = {};
  for (const part of String(value ?? "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

export class GitHubRequestBudget {
  constructor({ maximumRequests = DEFAULT_MAX_TRANSPORT_REQUESTS } = {}) {
    this.maximumRequests = positiveInteger(
      maximumRequests,
      DEFAULT_MAX_TRANSPORT_REQUESTS,
      "maximumRequests",
    );
    this.requests = 0;
    this.restRequests = 0;
    this.graphqlRequests = 0;
    this.cacheHits = 0;
    this.paginationPages = new Map();
  }

  consumeTransport(url, method = "GET") {
    if (this.requests >= this.maximumRequests) {
      throw new Error(
        `GitHub transport request budget of ${this.maximumRequests} was exhausted before ${method} ${url}`,
      );
    }
    this.requests += 1;
    const pathname = endpointPath(url);
    if (pathname.endsWith("/graphql") || pathname === "/graphql") this.graphqlRequests += 1;
    else this.restRequests += 1;
  }

  recordPage(operation) {
    const name = String(operation || "unknown");
    this.paginationPages.set(name, (this.paginationPages.get(name) ?? 0) + 1);
  }

  recordCacheHit() {
    this.cacheHits += 1;
  }

  snapshot() {
    return Object.freeze({
      maximumRequests: this.maximumRequests,
      requests: this.requests,
      restRequests: this.restRequests,
      graphqlRequests: this.graphqlRequests,
      cacheHits: this.cacheHits,
      paginationPages: Object.freeze(
        Object.fromEntries([...this.paginationPages.entries()].sort(([left], [right]) =>
          left.localeCompare(right))),
      ),
    });
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class BoundedReadCache {
  constructor({ maximumEntries = DEFAULT_MAX_IDENTITY_CACHE_ENTRIES, onHit } = {}) {
    this.maximumEntries = positiveInteger(
      maximumEntries,
      DEFAULT_MAX_IDENTITY_CACHE_ENTRIES,
      "maximumEntries",
    );
    this.onHit = typeof onHit === "function" ? onHit : () => {};
    this.values = new Map();
  }

  async get(key, loader) {
    if (typeof loader !== "function") throw new TypeError("cache loader must be a function");
    const normalized = String(key);
    if (this.values.has(normalized)) {
      this.onHit();
      return clone(this.values.get(normalized));
    }
    const value = await loader();
    if (this.values.size < this.maximumEntries) this.values.set(normalized, clone(value));
    return clone(value);
  }

  clear() {
    this.values.clear();
  }
}
