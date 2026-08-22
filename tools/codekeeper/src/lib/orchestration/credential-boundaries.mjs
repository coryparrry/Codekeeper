const PERMISSIONS = new Set(["read", "write"]);

function permission(value, name) {
  if (!PERMISSIONS.has(value)) throw new Error(`${name} must be read or write`);
  return value;
}

export function validateAppPermissionInputs({
  expected,
  contents,
  issues,
  pullRequests,
}) {
  if (!expected || typeof expected !== "object")
    throw new Error(
      "A verified mode plan is required for App permission validation",
    );
  const actual = {
    contents: permission(contents, "contents permission"),
    issues: permission(issues, "issues permission"),
    pullRequests: permission(pullRequests, "pull-requests permission"),
  };
  for (const key of Object.keys(actual)) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `GitHub App ${key} permission does not match the verified mode plan`,
      );
    }
  }
  return Object.freeze(actual);
}

export function assertCredentialBoundary(
  stage,
  { token = "", modelKey = "", traceKey = "", workspaceKey = "" } = {},
) {
  const has = (value) => typeof value === "string" && value.length > 0;
  if (["workspace", "coordinator", "validate"].includes(stage) && has(token)) {
    throw new Error(`${stage} stage must not receive an App token`);
  }
  if (stage === "workspace" && (has(modelKey) || has(traceKey))) {
    throw new Error(
      "Workspace stage must not receive model or trace credentials",
    );
  }
  if (stage === "coordinator" && has(workspaceKey)) {
    throw new Error("Coordinator stage must not receive workspace credentials");
  }
  if (
    ["validate", "publication"].includes(stage) &&
    (has(modelKey) || has(traceKey) || has(workspaceKey))
  ) {
    throw new Error(
      `${stage} stage must not receive model, trace, or workspace credentials`,
    );
  }
  return true;
}

export async function resolveAutomationBot({
  token,
  apiUrl = process.env.GITHUB_API_URL,
  appSlug,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof token !== "string" || !token)
    throw new Error("A GitHub token is required to resolve the automation bot");
  if (typeof apiUrl !== "string" || !/^https?:\/\//.test(apiUrl))
    throw new Error("GITHUB_API_URL is invalid");
  if (
    typeof appSlug !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(appSlug)
  )
    throw new Error("GitHub App slug is invalid");
  if (typeof fetchImpl !== "function")
    throw new Error("Fetch is unavailable for bot identity resolution");
  const response = await fetchImpl(
    `${apiUrl}/users/${encodeURIComponent(appSlug)}[bot]`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok)
    throw new Error(
      `GitHub automation bot lookup failed with HTTP ${response.status}`,
    );
  const identity = await response.json();
  if (
    !identity ||
    typeof identity.login !== "string" ||
    !Number.isSafeInteger(identity.id)
  ) {
    throw new Error("GitHub automation bot response is invalid");
  }
  return Object.freeze({ login: identity.login, id: identity.id });
}
