import { awaitWithSignal } from "./transport.mjs";

const TRANSIENT_GRAPHQL_ERROR_TYPES = new Set(["INTERNAL", "INTERNAL_ERROR", "RATE_LIMITED", "SERVICE_UNAVAILABLE"]);

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

function isRetryableGraphqlPayload(payload) {
  return payload?.errors?.some((error) =>
    TRANSIENT_GRAPHQL_ERROR_TYPES.has(String(error?.type ?? error?.extensions?.code ?? "").toUpperCase())
  );
}

function isGraphqlMutation(query) {
  return /^\s*mutation\b/i.test(String(query));
}

function isAmbiguousGraphqlMutationPayload(payload) {
  const hasData = payload?.data !== null && payload?.data !== undefined;
  const hasExecutionPath = payload?.errors?.some((error) =>
    Array.isArray(error?.path) && error.path.length > 0
  );
  return hasData || hasExecutionPath;
}

export async function graphql(client, query, variables = {}) {
  const mutation = isGraphqlMutation(query);
  if (mutation) await client.assertMutationCurrent();
  const retries = mutation ? 0 : client.retryAttempts;
  let requestResult;
  try {
    requestResult = await client.fetchWithRetry(client.graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${client.token}`,
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
  } catch (error) {
    if (mutation && error && typeof error === "object") {
      error.githubMutationOutcome = "ambiguous";
    }
    throw error;
  }
  const { response, payload } = requestResult;
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
    const error = new Error(`GitHub GraphQL failed: ${message}`);
    error.status = response.status;
    error.payload = payload;
    if (mutation && isAmbiguousGraphqlMutationPayload(payload)) {
      error.githubMutationOutcome = "ambiguous";
    }
    throw error;
  }
  return payload.data;
}

export async function paginateGraphqlConnection(client, {
  query,
  variables,
  getConnection,
  limit,
  invalidError,
  truncatedError,
  inspectNode
}) {
  const nodes = [];
  let after = null;
  while (nodes.length < limit) {
    const data = await client.graphql(query, { ...variables, after });
    const connection = getConnection(data);
    if (!connection || !Array.isArray(connection.nodes)) throw new Error(invalidError);
    for (const node of connection.nodes) {
      inspectNode?.(node);
      nodes.push(node);
      if (nodes.length === limit) break;
    }
    if (!connection.pageInfo?.hasNextPage) return nodes;
    if (nodes.length === limit || !connection.pageInfo.endCursor) {
      throw new Error(truncatedError);
    }
    after = connection.pageInfo.endCursor;
  }
  return nodes;
}
