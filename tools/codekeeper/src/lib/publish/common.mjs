import {
  LABELS,
  isCodekeeperIssueLabel,
  isCodekeeperLifecycleLabel,
  isCodekeeperPullRequestLabel
} from "../label-ownership.mjs";

function configuredManagedLabels(config, key, predicate, normalize = (label) => label) {
  const labels = config?.[key]?.managedLabels;
  if (!Array.isArray(labels)) throw new Error(`${key}.managedLabels must be an array`);
  return [...new Set(labels.map(normalize))].filter(predicate);
}

export function managedPullRequestLabels(config) {
  return configuredManagedLabels(config, "review", isCodekeeperPullRequestLabel);
}

export function managedIssueLabels(config) {
  return configuredManagedLabels(
    config,
    "issues",
    isCodekeeperIssueLabel,
    (label) => label === LABELS.NEEDS_TESTS ? LABELS.ISSUE_NEEDS_TESTS : label,
  );
}

export function managedLifecycleLabels(candidates) {
  if (!Array.isArray(candidates)) throw new Error("Lifecycle labels must be an array");
  const labels = [...new Set(candidates)];
  if (labels.some((label) => !isCodekeeperLifecycleLabel(label))) {
    throw new Error("Lifecycle labels must be Codekeeper-owned lifecycle labels");
  }
  return labels;
}

export function issueLabelNames(issue) {
  if (!Array.isArray(issue?.labels)) throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid label metadata`);
  const names = issue.labels.map((label) => typeof label === "string" ? label : label?.name);
  if (names.some((label) => typeof label !== "string" || label.length === 0) || new Set(names).size !== names.length) {
    throw new Error(`Issue #${issue?.number ?? "unknown"} has invalid or duplicate label metadata`);
  }
  return names;
}

export async function reconcileSecondaryIssue(github, issue, mutation) {
  await github.beginSecondaryIssueMutation({ issue, allowClosed: issue.state === "closed" });
  try {
    return await mutation();
  } finally {
    github.endSecondaryIssueMutation();
  }
}

export function matchesAutomationActor(actor, identity) {
  return Boolean(
    actor?.type === "Bot" &&
    String(actor.login ?? "").trim().toLowerCase() === identity.login &&
    String(actor.id ?? "") === identity.id
  );
}

export function isRecoverableMaintenanceIssue(issue, marker, identity) {
  return Boolean(
    identity &&
    matchesAutomationActor(issue?.user, identity) &&
    typeof issue?.body === "string" &&
    issue.body.endsWith(marker)
  );
}

export function isTrustedMaintenanceIssue(issue, { marker, botLogin, botId }) {
  const identity = normalizeAutomationIdentity({ login: botLogin, id: botId });
  return isRecoverableMaintenanceIssue(issue, marker, identity);
}

export function normalizeAutomationIdentity({ login, id }) {
  const normalizedLogin = String(login ?? "").trim().toLowerCase();
  const normalizedId = String(id ?? "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\[bot\]$/.test(normalizedLogin) || !/^[1-9]\d*$/.test(normalizedId)) {
    return null;
  }
  return { login: normalizedLogin, id: normalizedId };
}

export function expectedAutomationIdentity() {
  const login = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const id = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const identity = normalizeAutomationIdentity({ login, id });
  if (!identity) {
    throw new Error("CODEKEEPER_AUTOMATION_BOT_LOGIN and CODEKEEPER_AUTOMATION_BOT_ID must identify the configured GitHub App bot");
  }
  return identity;
}

export function trustedPublicationRunUrl(context) {
  const repository = String(context?.repository ?? "");
  const runId = String(context?.runId ?? "");
  const raw = String(context?.runUrl ?? "");
  if (!/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || !/^[1-9]\d{0,19}$/.test(runId) || raw.length > 2048) {
    throw new Error("Publication context has no valid workflow run URL");
  }
  let run;
  let server;
  try {
    run = new URL(raw);
    server = new URL(process.env.GITHUB_SERVER_URL ?? "https://github.com");
  } catch {
    throw new Error("Publication context has no valid workflow run URL");
  }
  if (run.protocol !== "https:" || run.origin !== server.origin || run.username || run.password || run.search || run.hash || run.pathname !== `/${repository}/actions/runs/${runId}`) {
    throw new Error("Publication context has no valid workflow run URL");
  }
  return run.toString();
}
