import path from "node:path";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  APP_SECRET,
  BOT_LOGIN_VARIABLE,
  CAPABILITIES,
  CAPABILITY_IDS,
  CLIENT_ID_VARIABLE,
  CONSERVATIVE_BOUNDARIES,
  DEEPSEEK_SECRET,
  ENABLED_VARIABLE,
  MODE_IDS,
  MODES,
  OPENAI_SECRET,
  PRESET_IDS,
  RECOMMENDED_MODES,
  RECOMMENDED_PRESET,
  SECRET_PURPOSES,
  SETUP_BRANCH,
  SETUP_COMMIT_MESSAGE,
  SETUP_PR_TITLE,
  TRACE_SECRET
} from "./constants.mjs";
import { renderInstallFiles } from "./assets.mjs";
import { InstallerError } from "./errors.mjs";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BOT_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})\[bot\]$/;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,99})$/;
const CLIENT_ID = /^(?:Iv[A-Za-z0-9]{18,253}|Iv1\.[A-Za-z0-9]{16,253})$/;

function tuiOptions(prompt, plain, tui) {
  return prompt?.kind === "ink" ? { ...plain, ...tui } : plain;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validDisplayName(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPrivateKeyPath(value) {
  return typeof value === "string"
    && path.isAbsolute(value)
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validClientId(value) {
  return typeof value === "string"
    && !/[\s\u0000-\u001f\u007f]/.test(value)
    && CLIENT_ID.test(value);
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

export function applicableCapabilityIds(modes) {
  const selected = normalizeModes(modes);
  return CAPABILITY_IDS.filter((id) => CAPABILITIES[id].modes.some((mode) => selected.includes(mode)));
}

export function normalizeCapabilities(modes, selected = []) {
  if (!Array.isArray(selected)) throw new InstallerError("Capability choices are invalid.", { code: "PLAN_INVALID" });
  const applicable = applicableCapabilityIds(modes);
  if (selected.some((id) => !applicable.includes(id)) || new Set(selected).size !== selected.length) {
    throw new InstallerError("Capability choices do not match the selected workflows.", { code: "PLAN_INVALID" });
  }
  return Object.freeze(Object.fromEntries(CAPABILITY_IDS.map((id) => [id, selected.includes(id)])));
}

export function capabilitySummary(capabilities, modes = null) {
  const ids = modes ? applicableCapabilityIds(modes) : CAPABILITY_IDS;
  return ids.map((id) => `${CAPABILITIES[id].label}: ${capabilities[id] ? "on" : "off"}.`);
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

export function appRegistrationUrl({ repository, displayName, ownerType = "User" }) {
  const [owner] = repository.split("/");
  if (ownerType !== "User" && ownerType !== "Organization") {
    throw new InstallerError("GitHub App registration requires a personal or organization repository owner.", { code: "PLAN_INVALID" });
  }
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
  const registrationPath = ownerType === "Organization"
    ? `/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : "/settings/apps/new";
  return `https://github.com${registrationPath}?${parameters.toString()}#codekeeper-${owner.toLowerCase()}`;
}

export function documentMap(files) {
  return files.map((file) => Object.freeze({
    path: file.path,
    purpose: file.path.endsWith("codekeeper.json")
      ? "Policy, model choices, protected paths, and startup controls"
      : AGENT_PROFILES[AGENT_PROFILE_IDS.find((profile) => AGENT_PROFILES[profile].target === file.path)]?.purpose
        ?? MODES[MODE_IDS.find((mode) => MODES[mode].target === file.path)]?.label
        ?? "Codekeeper setup"
  }));
}

export function workflowMap(modes) {
  return normalizeModes(modes).map((mode) => Object.freeze({
    mode,
    label: MODES[mode].label,
    description: MODES[mode].description,
    workflow: MODES[mode].target,
    trigger: MODES[mode].trigger,
    policyAgent: MODES[mode].policyAgent
  }));
}

export function completionGuidance(modes, enabled = true) {
  const proofs = workflowMap(modes).map((item) => Object.freeze({
    mode: item.mode,
    label: item.label,
    instruction: item.mode === "maintain"
      ? "manual workflow_dispatch with dry_run=true; report-only unless an owner explicitly commands repair through a supporting runtime"
      : item.mode === "review"
        ? "controlled same-repository pull request"
        : item.mode === "issues"
          ? "controlled issue event"
          : "owner command after you turn on issue implementation in the policy"
  }));
  return Object.freeze({
    heading: enabled
      ? "After the setup pull request merges, Codekeeper starts running the workflows you selected. Test each one before making its check required."
      : "Codekeeper will stay off after merge. Set CODEKEEPER_ENABLED=true when you are ready to test it.",
    profileGuidance: "Edit .github/codekeeper/agents/*.md to change decision guidance. Profiles cannot grant write, trigger, branch, repair, issue closure, or merge access.",
    proofs: Object.freeze(proofs),
    reviewGateWarning: proofs.some((item) => item.mode === "review")
      ? "Do not make the Codekeeper review gate required until its controlled review proof passes."
      : null,
    closing: "The installer did not run a workflow or merge the pull request."
  });
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
  const reviewDisabledNote = plan.modes.includes("review") && !plan.enabled
    ? "\nReview events fail the `Codekeeper review gate` while `CODEKEEPER_ENABLED=false`. Do not make the gate required until you enable Codekeeper and see a controlled review pass.\n"
    : "";
  if (plan.modes.includes("maintain")) proofs.push("Run maintenance manually with `dry_run=true`.");
  if (plan.modes.includes("review")) proofs.push("Open a controlled same-repository pull request and verify the App-owned review.");
  if (plan.modes.includes("issues")) proofs.push("Use a controlled issue event and verify bounded triage.");
  if (plan.modes.includes("fix")) proofs.push("Only after a deliberate policy change, use an owner-authorized fix command on a low-risk issue.");
  return `## Summary

Codekeeper is configured with the **${plan.preset}** preset at source commit \`${plan.source.commit}\`. It will be ${plan.enabled ? "enabled" : "disabled"} after this setup pull request merges.

Source: [${plan.source.repository}@${plan.source.commit}](https://github.com/${plan.source.repository}/tree/${plan.source.commit})

## Documents

${documents}

## Workflows

${workflows}

## Safety boundaries

${CONSERVATIVE_BOUNDARIES.map((item) => `- ${item}`).join("\n")}
${capabilitySummary(plan.capabilities, plan.modes).map((item) => `- ${item}`).join("\n")}
${reviewDisabledNote}

Required variables: ${plan.variables.map((item) => `\`${item.name}\``).join(", ")}.

Required secrets: ${plan.secrets.map((item) => `\`${item.name}\``).join(", ")}. Values are never stored in this branch or pull request.

## After merge

${plan.enabled
    ? "Codekeeper starts running the selected workflows. Test each one before making its check required:"
    : "Codekeeper stays off. Set `CODEKEEPER_ENABLED=true` when you are ready, then test each selected workflow:"}

Edit \`.github/codekeeper/agents/*.md\` to tune evidence thresholds, risk judgment, and no-action decisions. These profiles cannot grant writes, change triggers or branches, authorize repairs, close issues, or enable merge. Maintenance remains report-only unless an owner explicitly commands a repair after the supporting runtime is installed.

${proofs.map((item) => `- ${item}`).join("\n")}

The installer did not merge this pull request or run a workflow.
`;
}

export function buildInstallPlan({ bundle, snapshot, answers }) {
  const modes = normalizeModes(answers.modes);
  if (!PRESET_IDS.includes(answers.preset)) throw new InstallerError(`Unsupported preset: ${answers.preset}`, { code: "PLAN_INVALID" });
  if (!validDisplayName(answers.displayName)) throw new InstallerError("Repository display name is invalid.", { code: "PLAN_INVALID" });
  const ownerLogins = normalizeOwnerLogins(answers.ownerLogins);
  if (!validClientId(answers.appClientId)) throw new InstallerError("GitHub App Client ID is invalid.", { code: "PLAN_INVALID" });
  const automationBotLogin = modes.includes("review") ? String(answers.automationBotLogin ?? "").trim().toLowerCase() : null;
  if (modes.includes("review") && !BOT_LOGIN.test(automationBotLogin)) throw new InstallerError("GitHub App bot login is invalid.", { code: "PLAN_INVALID" });
  const capabilities = normalizeCapabilities(modes, answers.capabilities ?? []);
  const files = renderInstallFiles(bundle, {
    modes,
    preset: answers.preset,
    displayName: answers.displayName,
    defaultBranch: snapshot.defaultBranch,
    ownerLogins,
    capabilities
  });
  const enabled = answers.enabled !== false;
  const variables = [
    { name: ENABLED_VARIABLE, value: String(enabled) },
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
    enabled,
    capabilities,
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
  output.write(`Codekeeper guided setup\n\n`);
  output.write("This creates a setup pull request. It does not run a model, merge the pull request, or put secrets in generated files.\n\n");
  const repositoryConfirmed = await prompt.confirm({
    message: `Install into ${snapshot.repository} on default branch ${snapshot.defaultBranch}?`,
    defaultValue: false,
    ...(prompt?.kind === "ink" ? {
      step: "repository",
      description: [
        "Codekeeper supports GitHub.com repositories with a clean, current default-branch checkout.",
        "The installer is still read-only at this point."
      ],
      yesLabel: "Use this repository",
      noLabel: "Cancel"
    } : {})
  });
  if (!repositoryConfirmed) throw new InstallerError("Setup was cancelled before any mutation.", { code: "USER_CANCELLED" });
  output.write("Recommended starter setup\n");
  output.write("  - Pull request review: your GitHub App posts comments, labels, and a blocking result on controlled same-repository PRs\n");
  output.write("  - Repository maintenance: begin with a manual dry run that makes no GitHub changes\n");
  output.write("  - OpenAI preset: uses one model API key and one trace API key\n");
  output.write("  - Issue triage and issue fix are not included\n");
  output.write("  - You choose whether Codekeeper starts when the setup pull request merges\n");
  output.write("  - The maintenance workflow includes a schedule after merge\n");
  output.write("Press Return at the next question to accept these choices.\n");
  const useRecommended = prompt?.kind === "ink"
    ? await prompt.select({
      step: "setup",
      message: "Choose a starting setup",
      description: [
        "Recommended installs pull-request review and maintenance with one OpenAI model-provider key plus a separate OpenAI trace key.",
        "Custom lets you select issue triage, the separately gated fix workflow, or the mixed provider preset."
      ],
      defaultValue: "recommended",
      choices: [
        { value: "recommended", label: "Recommended — review + maintenance, OpenAI preset" },
        { value: "custom", label: "Custom — choose workflows and provider preset" }
      ]
    }) === "recommended"
    : await prompt.confirm({ message: "Use the recommended starter setup?", defaultValue: true });

  let modes;
  let preset;
  if (useRecommended) {
    modes = [...RECOMMENDED_MODES];
    preset = RECOMMENDED_PRESET;
    output.write("Using pull request review + repository maintenance with the OpenAI preset.\n");
  } else {
    output.write("\nCustom setup: install only the workflows that you want to use. Issue triage responds to issue events. You choose issue implementation separately.\n");
    modes = await prompt.multiselect(tuiOptions(prompt, {
      message: "Choose workflows to generate:",
      defaultValues: RECOMMENDED_MODES,
      choices: MODE_IDS.map((mode) => ({ value: mode, label: `${MODES[mode].label} — ${MODES[mode].description}` }))
    }, {
      step: "workflows",
      description: ["Install only the workflows you intend to prove in this repository."]
    }));
    preset = await prompt.select(tuiOptions(prompt, {
      message: "Choose the model-provider preset:",
      defaultValue: RECOMMENDED_PRESET,
      choices: [
        { value: "openai", label: "openai — one OpenAI model-provider key plus a separate OpenAI trace key (recommended)" },
        { value: "mixed", label: "mixed — provider keys vary by workflow, plus a separate OpenAI trace key" }
      ]
    }, {
      step: "models",
      description: [
        "The preset chooses the starting models. You can change them in .github/codekeeper.json.",
        "Provider credentials are requested later and never stored in generated files."
      ]
    }));
  }
  const enabled = prompt?.kind === "ink"
    ? await prompt.select({
      step: "startup",
      message: "Start Codekeeper after the setup pull request merges?",
      description: [
        "Enabled starts the workflows you selected as soon as this setup is merged.",
        "Disabled installs the files and secrets but keeps every Codekeeper workflow off."
      ],
      defaultValue: "enabled",
      choices: [
        { value: "enabled", label: "Enabled (recommended)" },
        { value: "disabled", label: "Disabled" }
      ]
    }) === "enabled"
    : await prompt.confirm({ message: "Start Codekeeper after the setup pull request merges?", defaultValue: true });
  const applicableCapabilities = applicableCapabilityIds(modes);
  const capabilities = applicableCapabilities.length
    ? await prompt.multiselect(tuiOptions(prompt, {
      message: "Choose capabilities to turn on:",
      defaultValues: applicableCapabilities,
      choices: applicableCapabilities.map((id) => ({
        value: id,
        label: `${CAPABILITIES[id].label} — ${CAPABILITIES[id].description}`
      }))
    }, {
      step: "capabilities",
      description: [
        "All capabilities that match your workflows are selected by default.",
        "Clear any capability that you do not want Codekeeper to use."
      ]
    }))
    : [];
  const displayName = await prompt.inputText(tuiOptions(prompt, {
    message: "Name to show in Codekeeper comments",
    defaultValue: snapshot.displayName,
    validate: (value) => validDisplayName(value) || "Use 1–100 printable characters."
  }, {
    step: "identity",
    description: ["This label appears in Codekeeper's GitHub comments. Your repository name is unchanged."],
    maxLength: 100
  }));
  const ownersText = await prompt.inputText(tuiOptions(prompt, {
    message: "GitHub users who can run owner-only /codekeeper commands (comma-separated)",
    defaultValue: snapshot.viewerLogin,
    validate(value) {
      try {
        normalizeOwnerLogins(value.split(","));
        return true;
      } catch {
        return "Enter one or more unique GitHub logins.";
      }
    }
  }, {
    step: "identity",
    description: ["Keep the authenticated user unless another maintainer should be allowed to run owner-only commands."]
  }));

  output.write("\nCredentials this setup will request later through GitHub CLI\n");
  output.write("Setup does not call a model. API keys go directly to GitHub CLI. Codekeeper does not display or store their values.\n");
  output.write("The installer sends the selected App key file directly to GitHub CLI. It does not read or display the key.\n");
  for (const name of requiredSecretNames({ modes, preset })) output.write(`  - ${name}: ${SECRET_PURPOSES[name]}\n`);

  const policy = JSON.parse(bundle.contents[`policies/${preset}.json`]);
  output.write("\nSafety settings\n");
  capabilitySummary(normalizeCapabilities(modes, capabilities), modes).forEach((item) => output.write(`  - ${item}\n`));
  CONSERVATIVE_BOUNDARIES.forEach((item) => output.write(`  - ${item}\n`));
  output.write(`The policy has ${policy.audit.repair.protectedPaths.length} protected-path rules. Review the full list in the setup pull request.\n`);
  const confirmed = await prompt.confirm(tuiOptions(prompt, {
    message: "Continue with these safety settings?",
    defaultValue: false
  }, {
    step: "safety",
    description: [
      ...capabilitySummary(normalizeCapabilities(modes, capabilities), modes),
      ...CONSERVATIVE_BOUNDARIES,
      `${policy.audit.repair.protectedPaths.length} protected-path rules are bundled for review before merge.`
    ],
    yesLabel: "Continue",
    noLabel: "Cancel"
  }));
  if (!confirmed) throw new InstallerError("Setup was cancelled before any mutation.", { code: "USER_CANCELLED" });
  return Object.freeze({
    modes: normalizeModes(modes),
    preset,
    displayName,
    ownerLogins: normalizeOwnerLogins(ownersText.split(",")),
    enabled,
    capabilities
  });
}

export async function collectAppAnswers({ prompt, modes, output }) {
  output.write("\nGitHub App identifiers\n");
  output.write("  - Client ID: find the value that starts with Iv in the App settings\n");
  if (modes.includes("review")) output.write("  - App URL name: find the name at the end of the App settings URL\n");
  const appClientId = await prompt.inputText(tuiOptions(prompt, {
    message: "GitHub App Client ID (starts with Iv; not the numeric App ID)",
    validate: (value) => validClientId(value) || "Enter the App Client ID shown in GitHub App settings."
  }, {
    step: "GitHub App",
    description: [
      "Find Client ID in the App's General settings. It begins with Iv.",
      "Do not enter the numeric App ID."
    ]
  }));
  let automationBotLogin = null;
  if (modes.includes("review")) {
    if (prompt?.kind === "ink") {
      const appSlug = await prompt.inputText({
        step: "GitHub App",
        message: "GitHub App name from the settings URL",
        description: [
          "GitHub uses this name in the App settings URL.",
          "For github.com/settings/apps/my-codekeeper-app, enter my-codekeeper-app. Codekeeper then uses my-codekeeper-app[bot]."
        ],
        validate: (value) => APP_SLUG.test(value.toLowerCase()) || "Enter the lowercase App name from its settings URL, without [bot]."
      });
      automationBotLogin = `${appSlug.toLowerCase()}[bot]`;
    } else {
      automationBotLogin = await prompt.inputText({
        message: "GitHub App bot login (<app-slug>[bot], for example my-app[bot])",
        validate: (value) => BOT_LOGIN.test(value.toLowerCase()) || "Enter the App bot login ending in [bot]."
      });
    }
  }
  return Object.freeze({ appClientId, automationBotLogin: automationBotLogin?.toLowerCase() ?? null });
}

export async function collectAppPrivateKeyPath({ prompt, output }) {
  output.write("\nGitHub App private-key file\n");
  output.write("Select the new .pem file that GitHub downloaded. Do not open the file or paste its contents.\n");
  output.write("The installer sends the file directly to GitHub CLI. It does not display the path or key.\n");
  if (typeof prompt.selectPrivateKey === "function") return prompt.selectPrivateKey();
  return prompt.inputText({
    message: "Full absolute path to the downloaded GitHub App private-key PEM",
    validate: (value) => validPrivateKeyPath(value) || "Enter the full absolute path to the downloaded .pem file, not the key contents."
  });
}
