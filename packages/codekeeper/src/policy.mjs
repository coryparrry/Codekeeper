export const POLICY_VERSION = 3;

export const AUTOMATION_DEFAULTS = Object.freeze({
  automaticPrReview: true,
  reviewFeedbackTriage: true,
  issueTriage: true,
  ownerRequests: true,
  maintenanceSchedule: "17 7 * * *"
});

export const OPENROUTER_PROVIDER = Object.freeze({
  baseUrl: "https://openrouter.ai/api/v1",
  api: "chat_completions",
  structuredOutputs: false,
  supportsReasoningEffort: false
});

export const DEFERRED_LABEL = Object.freeze({
  color: "C5DEF5",
  description: "Verified work deferred from a pull request"
});

export function upgradePolicy(input) {
  const policy = structuredClone(input);
  if (policy.version !== 2 && policy.version !== POLICY_VERSION) {
    throw new Error(`Unsupported Codekeeper policy version: ${policy.version}`);
  }
  if (policy.version === 2) {
    policy.version = POLICY_VERSION;
    policy.automation = { ...AUTOMATION_DEFAULTS };
    policy.review.createDeferredIssues ??= false;
    policy.ai.providers.openrouter ??= structuredClone(OPENROUTER_PROVIDER);
    policy.labels["codekeeper:deferred"] ??= structuredClone(DEFERRED_LABEL);
    if (!policy.issues.managedLabels.includes("codekeeper:deferred")) {
      policy.issues.managedLabels.push("codekeeper:deferred");
    }
  }
  return policy;
}
