import { assertVerifiedModePlan, modeAdapter } from "./mode-adapters.mjs";
import {
  assertCredentialBoundary,
  resolveAutomationBot,
  validateAppPermissionInputs,
} from "./credential-boundaries.mjs";
import { publishCommandArtifact } from "./command-artifact.mjs";

function required(value, name) {
  if (value === undefined || value === null || value === "")
    throw new Error(`${name} is required`);
  return value;
}

function adapterMode(mode) {
  return mode === "issues" ? "issue" : mode === "maintain" ? "audit" : mode;
}

export async function runPublish({
  mode,
  operation,
  plan,
  config,
  ...options
}) {
  assertCredentialBoundary("publication", {
    modelKey: process.env.CODEKEEPER_MODEL_API_KEY,
    traceKey: process.env.CODEKEEPER_TRACE_API_KEY,
    workspaceKey: process.env.CODEKEEPER_WORKSPACE_API_KEY,
  });
  const verifiedPlan = assertVerifiedModePlan(plan, mode, { config });
  const adapter = modeAdapter(verifiedPlan.resolvedMode);
  if (operation === "preconditions") {
    if (
      !options.dryRun &&
      (!String(options.appClientId ?? "").trim() ||
        !String(options.appPrivateKey ?? "").trim())
    ) {
      throw new Error(
        "GitHub App publication credentials are required for a live publication",
      );
    }
    return validateAppPermissionInputs({
      expected: verifiedPlan.appPermissions,
      contents: required(options.contentsPermission, "contentsPermission"),
      issues: required(options.issuesPermission, "issuesPermission"),
      pullRequests: required(
        options.pullRequestsPermission,
        "pullRequestsPermission",
      ),
    });
  }
  if (operation === "permissions") {
    return validateAppPermissionInputs({
      expected: verifiedPlan.appPermissions,
      contents: required(options.contentsPermission, "contentsPermission"),
      issues: required(options.issuesPermission, "issuesPermission"),
      pullRequests: required(
        options.pullRequestsPermission,
        "pullRequestsPermission",
      ),
    });
  }
  if (operation === "bot") {
    return resolveAutomationBot({
      token: required(options.token, "token"),
      apiUrl: options.apiUrl,
      appSlug: required(options.appSlug, "appSlug"),
    });
  }
  if (operation === "publish") {
    if (!verifiedPlan.publicationRequired) {
      throw new Error(`Mode ${mode} does not authorize publication`);
    }
    if (typeof adapter.publish !== "function")
      throw new Error(`Mode ${mode} has no publication adapter`);
    return adapter.publish({
      ...options,
      mode: adapterMode(verifiedPlan.resolvedMode),
      config,
    });
  }
  if (operation === "command") {
    if (verifiedPlan.trigger !== "owner-command") {
      throw new Error(
        "Direct command publication requires an owner-command plan",
      );
    }
    return publishCommandArtifact({
      artifactDirectory: options.artifactDirectory,
      expectedManifestSha256: options.expectedManifestSha256,
      eventPath: options.eventPath,
      automationLogin: options.automationLogin,
      automationIdentity: {
        login: required(options.automationLogin, "automationLogin"),
        id: required(options.automationId, "automationId"),
      },
      installedModes: options.installedModes,
      modePlanPath: options.modePlanPath,
      configPath: options.configPath,
      config,
      configSha256: options.configSha256,
      token: required(options.token, "token"),
    });
  }
  throw new Error(`Unknown publish operation: ${operation}`);
}
