import {
  APP_SECRET,
  BOT_LOGIN_VARIABLE,
  CLIENT_ID_VARIABLE,
  CONSERVATIVE_BOUNDARIES,
  DEEPSEEK_SECRET,
  ENABLED_VARIABLE,
  MODE_IDS,
  MODES,
  OPENAI_SECRET,
  PRESET_IDS,
  SETUP_BRANCH,
  SETUP_COMMIT_MESSAGE,
  SETUP_PR_TITLE,
  TRACE_SECRET
} from "./constants.mjs";
import { renderInstallFiles } from "./assets.mjs";
import { InstallerError } from "./errors.mjs";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/;
const CLIENT_ID = /^Iv[A-Za-z0-9]{18,253}$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validDisplayName(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeModes(modes) {
  if (!Array.isArray(modes)) throw new InstallerError("Select at least one Codekeeper mode.", { code: "PLAN_INVALID" });
  const selected = [...new Set(modes)];
  if (!selected.length || selected.some((mode) => !MODE_IDS.includes(mode))) {
    throw new InstallerError("Select at least one supported Codekeeper mode.", { code: "PLAN_INVALID" });
  }
  return MODE_IDS.filter((mode) => selected.includes(mode));
}

export function normalizeOwnerLogins(ownerLogins) {
  if (!Array.isArray(ownerLogins) || !ownerLogins.length) throw new InstallerError("At least one owner login is required.", { code: "PLAN_INVALID" });
  const normalized = ownerLogins.map((login) => String(login).trim().toLowerCase());
  if (normalized.some((login) => !LOGIN.test(login)) || new Set(normalized).size !== normalized.length) {
    throw new InstallerError("Owner logins must be unique GitHub login names.", { code: "PLAN_INVALID" });
  }
  return normalized;
}

export function requiredSecretNames({ modes, preset }) {
  const selected = normalizeModes(modes);
  if (!PRESET_IDS.includes(preset)) throw new InstallerError(`Unsupported preset: ${preset}`, { code: "PLAN_INVALID" });
  const names = [];
  const openaiNeeded = selected.some((mode) => mode !== "issues") || (selected.includes("issues") && preset === "openai");
  if (openaiNeeded) names.push(OPENAI_SECRET);
  if (selected.includes("issues") && preset === "mixed") names.push(DEEPSEEK_SECRET);
  names.push(TRACE_SECRET, APP_SECRET);
  return Object.freeze(names);
}

export function appRegistrationUrl({ repository, displayName }) {
  const [owner] = repository.split("/");
  const name = `Codekeeper ${displayName}`.slice(0, 34);
  const parameters = new URLSearchParams({
    name,
    description: `Codekeeper automation for ${repository}`,
    url: `https://github.com/${repository}`,
    public: "false",
    webhook_active: "false",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read"
  });
  return `https://github.com/settings/apps/new?${parameters.toString()}#codekeeper-${owner.toLowerCase()}`;
}

export function documentMap(files) {
  return files.map((file) => Object.freeze({
    path: file.path,
    purpose: file.path.endsWith("codekeeper.json")
      ? "Conservative policy, model choices, protected paths, and disabled release controls"
      : MODES[MODE_IDS.find((mode) => MODES[mode].target === file.path)]?.label ?? "Codekeeper setup"
  }));
}

export function workflowMap(modes) {
  return normalizeModes(modes).map((mode) => Object.freeze({
    mode,
    workflow: MODES[mode].target,
    trigger: MODES[mode].trigger,
    policyAgent: MODES[mode].policyAgent
  }));
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

export function setupPullRequestBody(plan) {
  const documents = markdownTable(
    ["Document", "Purpose"],
    documentMap(plan.files).map((item) => [`\`${item.path}\``, item.purpose])
  );
  const workflows = markdownTable(
    ["Mode", "Trigger", "Policy agent"],
    workflowMap(plan.modes).map((item) => [item.mode, item.trigger, `\`${item.policyAgent}\``])
  );
  const proofs = [];
  if (plan.modes.includes("maintain")) proofs.push("Run maintenance manually with `dry_run=true`.");
  if (plan.modes.includes("review")) proofs.push("Open a controlled same-repository pull request and verify the App-owned review.");
  if (plan.modes.includes("issues")) proofs.push("Use a controlled issue event and verify bounded triage.");
  if (plan.modes.includes("fix")) proofs.push("Only after a deliberate policy change, use an owner-authorized fix command on a low-risk issue.");
  return `## Summary

Codekeeper is configured with the **${plan.preset}** preset at immutable source checkpoint \`${plan.source.commit}\`. The setup remains disabled until an owner deliberately enables it for a controlled proof.

Source: [${plan.source.repository}@${plan.source.commit}](https://github.com/${plan.source.repository}/tree/${plan.source.commit})

## Documents

${documents}

## Workflows

${workflows}

## Safety boundaries

${CONSERVATIVE_BOUNDARIES.map((item) => `- ${item}`).join("\n")}

Required variables: ${plan.variables.map((item) => `\`${item.name}\``).join(", ")}.

Required secrets: ${plan.secrets.map((item) => `\`${item.name}\``).join(", ")}. Values are never stored in this branch or pull request.

## After merge

Keep \`CODEKEEPER_ENABLED=false\` until the repository is ready for a bounded proof. For each selected proof, deliberately set it to \`true\`, run only that controlled scenario, then restore it to \`false\`:

${proofs.map((item) => `- ${item}`).join("\n")}

The installer did not merge this pull request, enable Codekeeper, or dispatch a workflow.
`;
}

export function buildInstallPlan({ bundle, snapshot, answers }) {
  const modes = normalizeModes(answers.modes);
  if (!PRESET_IDS.includes(answers.preset)) throw new InstallerError(`Unsupported preset: ${answers.preset}`, { code: "PLAN_INVALID" });
  if (!validDisplayName(answers.displayName)) throw new InstallerError("Repository display name is invalid.", { code: "PLAN_INVALID" });
  const ownerLogins = normalizeOwnerLogins(answers.ownerLogins);
  if (!CLIENT_ID.test(answers.appClientId ?? "")) throw new InstallerError("GitHub App Client ID is invalid.", { code: "PLAN_INVALID" });
  const automationBotLogin = modes.includes("review") ? String(answers.automationBotLogin ?? "").trim().toLowerCase() : null;
  if (modes.includes("review") && !BOT_LOGIN.test(automationBotLogin)) throw new InstallerError("GitHub App bot login is invalid.", { code: "PLAN_INVALID" });
  const files = renderInstallFiles(bundle, {
    modes,
    preset: answers.preset,
    displayName: answers.displayName,
    defaultBranch: snapshot.defaultBranch,
    ownerLogins
  });
  const variables = [
    { name: ENABLED_VARIABLE, value: "false" },
    { name: CLIENT_ID_VARIABLE, value: answers.appClientId }
  ];
  if (modes.includes("review")) variables.push({ name: BOT_LOGIN_VARIABLE, value: automationBotLogin });
  const plan = {
    source: {
      repository: bundle.metadata.source.repository,
      commit: bundle.metadata.source.commit
    },
    root: snapshot.root,
    repository: snapshot.repository,
    defaultBranch: snapshot.defaultBranch,
    originalHead: snapshot.headSha,
    modes,
    preset: answers.preset,
    displayName: answers.displayName,
    ownerLogins,
    files,
    variables,
    secrets: requiredSecretNames({ modes, preset: answers.preset }).map((name) => ({ name })),
    branch: SETUP_BRANCH,
    commitMessage: SETUP_COMMIT_MESSAGE,
    pullRequest: { title: SETUP_PR_TITLE }
  };
  plan.pullRequest.body = setupPullRequestBody(plan);
  return deepFreeze(plan);
}

export async function collectSetupAnswers({ prompt, snapshot, bundle, output }) {
  const repositoryConfirmed = await prompt.confirm({
    message: `Install into ${snapshot.repository} on default branch ${snapshot.defaultBranch}?`,
    defaultValue: false
  });
  if (!repositoryConfirmed) throw new InstallerError("Setup was cancelled before any mutation.", { code: "USER_CANCELLED" });
  const modes = await prompt.multiselect({
    message: "Which Codekeeper workflows should be installed?",
    choices: MODE_IDS.map((mode) => ({ value: mode, label: MODES[mode].label }))
  });
  const preset = await prompt.select({
    message: "Which bundled release model preset should be used?",
    defaultValue: "mixed",
    choices: [
      { value: "mixed", label: "mixed — OpenAI review/maintenance/fix; DeepSeek issue triage" },
      { value: "openai", label: "openai — OpenAI for every selected mode" }
    ]
  });
  const displayName = await prompt.inputText({
    message: "Repository display name",
    defaultValue: snapshot.displayName,
    validate: (value) => validDisplayName(value) || "Use 1–100 printable characters."
  });
  const ownersText = await prompt.inputText({
    message: "Owner GitHub logins (comma-separated)",
    defaultValue: snapshot.viewerLogin,
    validate(value) {
      try {
        normalizeOwnerLogins(value.split(","));
        return true;
      } catch {
        return "Enter one or more unique GitHub logins.";
      }
    }
  });

  const policy = JSON.parse(bundle.contents[`policies/${preset}.json`]);
  output.write("\nConservative setup boundaries:\n");
  CONSERVATIVE_BOUNDARIES.forEach((item) => output.write(`  - ${item}\n`));
  output.write("Protected paths include:\n");
  policy.audit.repair.protectedPaths.forEach((item) => output.write(`  - ${item}\n`));
  const confirmed = await prompt.confirm({ message: "Continue with these disabled-by-default boundaries?", defaultValue: false });
  if (!confirmed) throw new InstallerError("Setup was cancelled before any mutation.", { code: "USER_CANCELLED" });
  return Object.freeze({
    modes: normalizeModes(modes),
    preset,
    displayName,
    ownerLogins: normalizeOwnerLogins(ownersText.split(","))
  });
}

export async function collectAppAnswers({ prompt, modes }) {
  const appClientId = await prompt.inputText({
    message: "GitHub App Client ID",
    validate: (value) => CLIENT_ID.test(value) || "Enter the App Client ID shown in GitHub App settings."
  });
  let automationBotLogin = null;
  if (modes.includes("review")) {
    automationBotLogin = await prompt.inputText({
      message: "GitHub App bot login (for example my-app[bot])",
      validate: (value) => BOT_LOGIN.test(value.toLowerCase()) || "Enter the App bot login ending in [bot]."
    });
  }
  return Object.freeze({ appClientId, automationBotLogin: automationBotLogin?.toLowerCase() ?? null });
}
