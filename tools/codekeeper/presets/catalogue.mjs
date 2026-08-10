const OPENAI_ISSUE_CANDIDATES = Object.freeze({
  "terra-medium": Object.freeze({ model: "gpt-5.6-terra", effort: "medium" }),
  "terra-high": Object.freeze({ model: "gpt-5.6-terra", effort: "high" }),
  "sol-high": Object.freeze({ model: "gpt-5.6-sol", effort: "high" })
});

export const POLICY_PRESETS = Object.freeze({
  mixed: Object.freeze({
    version: 1,
    description: "Use the repository starter policy without changing provider or agent settings."
  }),
  openai: Object.freeze({
    version: 1,
    description: "Keep the starter policy, with structured OpenAI issue triage at Terra medium.",
    defaultIssueCandidate: "terra-medium"
  })
});

function clone(value) {
  return structuredClone(value);
}

export function openaiIssueCandidates() {
  return clone(OPENAI_ISSUE_CANDIDATES);
}

export function applyPolicyPreset(starterPolicy, presetName, { openaiIssueCandidate } = {}) {
  if (!POLICY_PRESETS[presetName]) throw new Error(`Unknown policy preset: ${presetName}`);
  const policy = clone(starterPolicy);
  if (presetName === "mixed") return policy;

  const candidateName = openaiIssueCandidate ?? POLICY_PRESETS.openai.defaultIssueCandidate;
  const candidate = OPENAI_ISSUE_CANDIDATES[candidateName];
  if (!candidate) throw new Error(`Unknown OpenAI issue candidate: ${candidateName}`);

  policy.ai.agents.issue = {
    ...policy.ai.agents.issue,
    provider: "openai",
    model: candidate.model,
    effort: candidate.effort,
    modelSettings: { text: { verbosity: "low" } },
    workspace: {
      ...policy.ai.agents.issue.workspace,
      enabled: false,
      allowWrites: false,
      model: candidate.model,
      effort: candidate.effort
    }
  };
  return policy;
}
