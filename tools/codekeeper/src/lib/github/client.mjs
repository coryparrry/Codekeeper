import { commentMethods } from "./comments.mjs";
import { resolveGraphqlUrl, graphql as executeGitHubGraphql } from "./graphql.mjs";
import { issueMethods } from "./issues.mjs";
import { labelMethods } from "./labels.mjs";
import { mutationGuardMethods } from "./mutation-guard.mjs";
import { paginate as paginateGitHub } from "./pagination.mjs";
import { pullMethods } from "./pulls.mjs";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  fetchWithRetry as fetchGitHubWithRetry,
  positiveFiniteNumber,
  request as executeGitHubRequest,
  retryAttempts,
  retryDelay as githubRetryDelay,
  sleep,
} from "./transport.mjs";

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
    this.pullMutation = null;
    this.branchMutation = null;
    this.issueMutation = null;
    this.secondaryIssueMutation = null;
  }

  retryDelay(response, attempt) {
    return githubRetryDelay(this, response, attempt);
  }

  async fetchWithRetry(url, options, extras) {
    return fetchGitHubWithRetry(this, url, options, extras);
  }

  async request(method, endpoint, options) {
    return executeGitHubRequest(this, method, endpoint, options);
  }

  async paginate(endpoint, options) {
    return paginateGitHub(this, endpoint, options);
  }

  repoPath(suffix) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
  }

  async getUser(login) {
    const normalized = String(login ?? "").trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(normalized)) {
      throw new Error("GitHub user login is invalid");
    }
    return (await this.request("GET", `/users/${encodeURIComponent(normalized)}`)).data;
  }

  async getApp(slug) {
    const normalized = String(slug ?? "").trim();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(normalized)) {
      throw new Error("GitHub App slug is invalid");
    }
    return (await this.request("GET", `/apps/${encodeURIComponent(normalized)}`)).data;
  }

  async createRepositoryDispatch(eventType, clientPayload) {
    await this.request("POST", this.repoPath("/dispatches"), {
      body: { event_type: eventType, client_payload: clientPayload }
    });
  }

  async graphql(query, variables) {
    return executeGitHubGraphql(this, query, variables);
  }
}

Object.assign(
  GitHubClient.prototype,
  mutationGuardMethods,
  issueMethods,
  commentMethods,
  labelMethods,
  pullMethods,
);
