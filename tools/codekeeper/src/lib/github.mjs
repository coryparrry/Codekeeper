import { GitHubClient as CoreGitHubClient } from "./github-core.mjs";
import {
  BoundedReadCache,
  GitHubRequestBudget,
  paginationPolicyFor,
  parsePaginationLinks,
} from "./github-budget.mjs";

export * from "./github-core.mjs";

function safeLimit(value) {
  return value === Number.POSITIVE_INFINITY
    || (Number.isSafeInteger(value) && value > 0);
}

function safePageBudget(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export class GitHubClient extends CoreGitHubClient {
  constructor(options = {}) {
    super(options);
    const budgetOptions = options.transport?.budget ?? {};
    this.codekeeperRequestBudget = new GitHubRequestBudget(budgetOptions);
    this.codekeeperIdentityCache = new BoundedReadCache({
      maximumEntries: budgetOptions.maximumIdentityCacheEntries,
      onHit: () => this.codekeeperRequestBudget.recordCacheHit(),
    });
    const fetchTransport = this.fetch;
    this.fetch = async (url, requestOptions = {}) => {
      this.codekeeperRequestBudget.consumeTransport(
        url,
        requestOptions.method ?? "GET",
      );
      return fetchTransport(url, requestOptions);
    };
  }

  requestMetrics() {
    return this.codekeeperRequestBudget.snapshot();
  }

  clearReadCache() {
    this.codekeeperIdentityCache.clear();
  }

  async paginate(
    endpoint,
    {
      limit = Number.POSITIVE_INFINITY,
      predicate = () => true,
      pageBudget,
      operation,
    } = {},
  ) {
    if (!safeLimit(limit)) throw new Error("Pagination limit must be a positive integer");
    if (typeof predicate !== "function") throw new TypeError("Pagination predicate must be a function");

    const policy = paginationPolicyFor(endpoint, this.apiUrl);
    const maximumPages = pageBudget === undefined ? policy.pages : pageBudget;
    if (!safePageBudget(maximumPages)) {
      throw new Error("Pagination page budget must be a positive integer");
    }
    const operationName = operation || policy.name;
    const results = [];
    let url = endpoint.includes("?") ? `${endpoint}&per_page=100` : `${endpoint}?per_page=100`;
    const visited = new Set();
    const apiBase = new URL(`${this.apiUrl}/`);
    let pages = 0;

    while (url && results.length < limit) {
      if (pages >= maximumPages) {
        throw new Error(
          `GitHub ${operationName} pagination exceeded its ${maximumPages}-page budget`,
        );
      }
      const resolved = url.startsWith("/")
        ? new URL(`${this.apiUrl}${url}`)
        : new URL(url, apiBase);
      if (
        resolved.origin !== apiBase.origin
        || !resolved.pathname.startsWith(apiBase.pathname)
      ) {
        throw new Error("GitHub pagination returned an untrusted next URL");
      }
      const normalized = resolved.toString();
      if (visited.has(normalized)) {
        throw new Error("GitHub pagination returned a repeated next URL");
      }
      visited.add(normalized);
      pages += 1;
      this.codekeeperRequestBudget.recordPage(operationName);

      const response = await this.request("GET", url);
      if (!Array.isArray(response.data)) throw new Error(`Expected array from ${url}`);
      for (const item of response.data) {
        if (!predicate(item)) continue;
        results.push(item);
        if (results.length === limit) break;
      }
      if (results.length === limit) return results;
      const links = parsePaginationLinks(response.headers.get("link"));
      if (links.next && pages >= maximumPages) {
        throw new Error(
          `GitHub ${operationName} pagination exceeded its ${maximumPages}-page budget`,
        );
      }
      url = links.next ?? "";
    }
    return results;
  }

  async getUser(login) {
    const normalized = String(login ?? "").trim().toLowerCase();
    return this.codekeeperIdentityCache.get(
      `user:${normalized}`,
      () => super.getUser(login),
    );
  }

  async getApp(slug) {
    const normalized = String(slug ?? "").trim().toLowerCase();
    return this.codekeeperIdentityCache.get(
      `app:${normalized}`,
      () => super.getApp(slug),
    );
  }
}
