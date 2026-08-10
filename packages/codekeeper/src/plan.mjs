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
  MODEL_OPTIONS,
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
import { renderInstallFiles, sha256 } from "./assets.mjs";
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

export function requiredSecretNames({ modes, preset, tracing = true }) {
  const selected = normalizeModes(modes);
  if (!PRESET_IDS.includes(preset)) throw new InstallerError(`Unsupported preset: ${preset}`, { code: "PLAN_INVALID" });
  const names = [];
  const openaiNeeded = selected.some((mode) => mode !== "issues") || (selected.includes("issues") && preset === "openai");
  if (openaiNeeded) names.push(OPENAI_SECRET);
  if (selected.includes("issues") && preset === "mixed") names.push(DEEPSEEK_SECRET);
  if (tracing) names.push(TRACE_SECRET);
  names.push(APP_SECRET);
  return Object.freeze(names);
}

export function normalizeModelChoices({ modes, preset, bundle, choices = {}, policySource = bundle.contents[`policies/${preset}.json`] }) {
  const selected = normalizeModes(modes);
  const policy = JSON.parse(policySource);
  const normalized = {};
  for (const mode of selected) {
    const agent = policy.ai.agents[MODES[mode].policyAgent];
    const options = MODEL_OPTIONS[agent.provider];
    const defaultOption = options?.find((option) => option.model === agent.model && option.effort === agent.effort);
    const choiceId = choices[mode] ?? defaultOption?.id;
    const choice = options?.find((option) => option.id === choiceId);
    if (!choice) throw new InstallerError(`Model choice is invalid for ${MODES[mode].label}.`, { code: "PLAN_INVALID" });
    normalized[mode] = Object.freeze({
      provider: agent.provider,
      model: choice.model,
      effort: choice.effort,
      choice: choice.id
    });
  }
  if (Object.keys(choices).some((mode) => !selected.includes(mode))) {
    throw new InstallerError("Model choices do not match the selected workflows.", { code: "PLAN_INVALID" });
  }
  return Object.freeze(normalized);
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
      ? "Run workflow_dispatch with dry_run=true to check the audit. A live run can repair when repository repair is on."
      : item.mode === "review"
        ? "controlled same-repository pull request"
        : item.mode === "issues"
          ? "controlled issue event"
          : "controlled ready issue; use /codekeeper fix for a pull request repair"
  }));
  return Object.freeze({
    heading: enabled
      ? "After the setup pull request merges, Codekeeper starts running the workflows you selected. Test each one before making its check required."
      : "Codekeeper will stay off after merge. Set CODEKEEPER_ENABLED=true when you are ready to test it.",
    profileGuidance: "Edit .github/codekeeper/agents/*.md to change priorities, work selection, implementation, review standards, and reporting. Capability switches control repair, issue implementation, issue closure, and merge actions.",
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
    ["Mode", "Agent", "Trigger", "Model"],
    workflowMap(plan.modes).map((item) => {
      const selection = plan.models[item.mode];
      return [item.mode, MODES[item.mode].agentLabel, item.trigger, `\`${selection.provider} / ${selection.model} / ${selection.effort}\``];
    })
  );
  const proofs = [];
  const reviewDisabledNote = plan.modes.includes("review") && !plan.enabled
    ? "\nReview events fail the `Codekeeper review gate` while `CODEKEEPER_ENABLED=false`. Do not make the gate required until you enable Codekeeper and see a controlled review pass.\n"
    : "";
  if (plan.modes.includes("maintain")) proofs.push("Run maintenance manually with `dry_run=true`.");
  if (plan.modes.includes("review")) proofs.push("Open a controlled same-repository pull request and verify the App-owned review.");
  if (plan.modes.includes("issues")) proofs.push("Use a controlled issue event and verify bounded triage.");
  if (plan.modes.includes("fix")) proofs.push("Use a controlled issue that triage marks ready. Use \`/codekeeper fix\` only when repairing an existing pull request.");
  return `## Summary

Codekeeper is configured with the **${plan.preset}** preset at source commit \`${plan.source.commit}\`. It will be ${plan.enabled ? "enabled" : "disabled"} after this setup pull request merges.

OpenAI traces are **${plan.tracing ? "enabled" : "disabled"}**.

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

Edit \`.github/codekeeper/agents/*.md\` to tune priorities, work selection, implementation approach, review standards, and reporting. The capability switches above control which GitHub actions Codekeeper can take. A live maintenance run can repair when repository repair is on. An issue marked ready can start implementation when issue implementation is on.

${proofs.map((item) => `- ${item}`).join("\n")}

The installer did not merge this pull request or run a workflow.
`;
}

export function buildInstallPlan({ bundle, snapshot, answers }) {
  const modes = normalizeModes(answers.modes);
  const installation = snapshot.installation ?? null;
  const policySource = installation?.policySource ?? bundle.contents[`policies/${answers.preset}.json`];
  if (!PRESET_IDS.includes(answers.preset)) throw new InstallerError(`Unsupported preset: ${answers.preset}`, { code: "PLAN_INVALID" });
  if (!validDisplayName(answers.displayName)) throw new InstallerError("Repository display name is invalid.", { code: "PLAN_INVALID" });
  const ownerLogins = normalizeOwnerLogins(answers.ownerLogins);
  if (!validClientId(answers.appClientId)) throw new InstallerError("GitHub App Client ID is invalid.", { code: "PLAN_INVALID" });
  const automationBotLogin = modes.includes("review") ? String(answers.automationBotLogin ?? "").trim().toLowerCase() : null;
  if (modes.includes("review") && !BOT_LOGIN.test(automationBotLogin)) throw new InstallerError("GitHub App bot login is invalid.", { code: "PLAN_INVALID" });
  const capabilities = normalizeCapabilities(modes, answers.capabilities ?? []);
  const models = normalizeModelChoices({ modes, preset: answers.preset, bundle, choices: answers.models, policySource });
  const tracing = answers.tracing !== false;
  const files = renderInstallFiles(bundle, {
    modes,
    preset: answers.preset,
    displayName: answers.displayName,
    defaultBranch: snapshot.defaultBranch,
    ownerLogins,
    capabilities,
    models,
    tracing,
    policySource,
    profileSources: installation?.contents ?? bundle.contents,
    enforceBundledDefaults: !installation
  });
  const changedFiles = installation
    ? files
      .filter((file) => installation.contents[file.path] !== file.contents)
      .map((file) => ({ ...file, previousSha256: sha256(installation.contents[file.path]) }))
    : files;
  const enabled = answers.enabled !== false;
  const variables = installation
    ? (enabled === snapshot.existingSettings.enabled ? [] : [{ name: ENABLED_VARIABLE, value: String(enabled) }])
    : [
    { name: ENABLED_VARIABLE, value: String(enabled) },
    { name: CLIENT_ID_VARIABLE, value: answers.appClientId }
  ];
  if (!installation && modes.includes("review")) variables.push({ name: BOT_LOGIN_VARIABLE, value: automationBotLogin });
  if (installation && !changedFiles.length && !variables.length) {
    throw new InstallerError("The selected configuration does not change the current installation.", { code: "NO_CHANGES" });
  }
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
    models,
    tracing,
    files: changedFiles,
    variables,
    secrets: installation ? [] : requiredSecretNames({ modes, preset: answers.preset, tracing }).map((name) => ({ name })),
    branch: installation ? snapshot.updateBranch : SETUP_BRANCH,
    commitMessage: installation ? "chore(codekeeper): update configuration" : SETUP_COMMIT_MESSAGE,
    pullRequest: { title: installation ? "chore(codekeeper): update configuration" : SETUP_PR_TITLE },
    update: Boolean(installation),
    settingsOnly: Boolean(installation && !changedFiles.length)
  };
  plan.pullRequest.body = setupPullRequestBody(plan);
  return deepFreeze(plan);
}

export async function collectSetupAnswers({ prompt, snapshot, bundle, output }) {
  const installation = snapshot.installation ?? null;
  output.write(`Codekeeper guided setup\n\n`);
  output.write(installation
    ? "This edits the current Codekeeper installation through a new pull request.\n\n"
    : "This creates a setup pull request. It does not run a model, merge the pull request, or put secrets in generated files.\n\n");
  const repositoryConfirmed = await prompt.confirm({
    message: `${installation ? "Edit Codekeeper in" : "Install into"} ${snapshot.repository} on default branch ${snapshot.defaultBranch}?`,
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
  if (!installation) output.write("Recommended starter setup\n");
  if (!installation) {
    output.write("  - Pull request review: your GitHub App posts comments, labels, and a blocking result on controlled same-repository PRs\n");
    output.write("  - Repository maintenance: begin with a manual dry run that makes no GitHub changes\n");
    output.write("  - OpenAI preset: uses one OpenAI Platform API key for model calls\n");
    output.write("  - Issue triage and issue fix are not included\n");
    output.write("  - You choose whether Codekeeper starts when the setup pull request merges\n");
    output.write("  - The maintenance workflow includes a schedule after merge\n");
    output.write("Press Return at the next question to accept these choices.\n");
  }
  const useRecommended = installation ? false : prompt?.kind === "ink"
    ? await prompt.select({
      step: "setup",
      message: "Choose a starting setup",
      description: [
        "Recommended installs pull-request review and maintenance with OpenAI models.",
        "Custom lets you select issue triage, the separately gated fix workflow, or the mixed provider preset."
      ],
      defaultValue: "recommended",
      choices: [
        { value: "recommended", label: "Recommended — review + maintenance, OpenAI models" },
        { value: "custom", label: "Custom — choose workflows and provider preset" }
      ]
    }) === "recommended"
    : await prompt.confirm({ message: "Use the recommended starter setup?", defaultValue: true });

  let modes;
  let preset;
  if (installation) {
    modes = [...installation.modes];
    preset = installation.policy.ai.agents.issue?.provider === "deepseek" ? "mixed" : "openai";
    output.write(`Editing the current ${modes.map((mode) => MODES[mode].label).join(" + ")} installation.\n`);
  } else if (useRecommended) {
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
        { value: "openai", label: "openai — use OpenAI for every selected workflow (recommended)" },
        { value: "mixed", label: "mixed — use DeepSeek for issue triage and OpenAI for other workflows" }
      ]
    }, {
      step: "models",
      description: [
        "The preset chooses the model provider for each workflow.",
        "You choose a model for each selected workflow on the next screens."
      ]
    }));
  }
  const presetPolicy = installation?.policy ?? JSON.parse(bundle.contents[`policies/${preset}.json`]);
  const models = {};
  for (const mode of normalizeModes(modes)) {
    const agent = presetPolicy.ai.agents[MODES[mode].policyAgent];
    const choices = MODEL_OPTIONS[agent.provider];
    const defaultChoice = choices.find((choice) => choice.model === agent.model && choice.effort === agent.effort) ?? choices[0];
    models[mode] = await prompt.select(tuiOptions(prompt, {
      message: `Assign a model to the ${MODES[mode].agentLabel}:`,
      defaultValue: defaultChoice.id,
      choices: choices.map((choice) => ({ value: choice.id, label: choice.label }))
    }, {
      step: "models",
      description: [
        `${MODES[mode].label} uses this agent. Provider: ${agent.provider}.`,
        "You can change this choice later in .github/codekeeper.json."
      ]
    }));
  }
  const tracing = prompt?.kind === "ink"
    ? await prompt.select({
      step: "tracing",
      message: "Enable OpenAI traces?",
      description: [
        "Traces record model runs in OpenAI Platform Logs.",
        "Enabled needs a separate OpenAI Platform API key. Disabled does not request the trace key."
      ],
      defaultValue: (installation ? installation.policy.ai.tracing.enabled : true) ? "enabled" : "disabled",
      choices: [
        { value: "enabled", label: "Enabled" },
        { value: "disabled", label: "Disabled" }
      ]
    }) === "enabled"
    : await prompt.confirm({ message: "Enable OpenAI traces?", defaultValue: installation ? installation.policy.ai.tracing.enabled : true });
  const enabled = prompt?.kind === "ink"
    ? await prompt.select({
      step: "startup",
      message: "Start Codekeeper after the setup pull request merges?",
      description: [
        "Enabled starts the workflows you selected as soon as this setup is merged.",
        "Disabled installs the files and secrets but keeps every Codekeeper workflow off."
      ],
      defaultValue: (installation ? snapshot.existingSettings.enabled : true) ? "enabled" : "disabled",
      choices: [
        { value: "enabled", label: "Enabled (recommended)" },
        { value: "disabled", label: "Disabled" }
      ]
    }) === "enabled"
    : await prompt.confirm({ message: "Start Codekeeper after the setup pull request merges?", defaultValue: installation ? snapshot.existingSettings.enabled : true });
  const applicableCapabilities = applicableCapabilityIds(modes);
  const capabilities = applicableCapabilities.length
    ? await prompt.multiselect(tuiOptions(prompt, {
      message: "Choose capabilities to turn on:",
      defaultValues: installation
        ? applicableCapabilities.filter((id) => ({
          repair: installation.policy.audit.repair.enabled,
          issueImplementation: installation.policy.issues.allowAiImplementation,
          duplicateClosure: installation.policy.issues.closeExactDuplicates,
          autoMerge: installation.policy.merge.enabled
        })[id])
        : applicableCapabilities,
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
    defaultValue: installation?.policy.repository.displayName ?? snapshot.displayName,
    validate: (value) => validDisplayName(value) || "Use 1–100 printable characters."
  }, {
    step: "identity",
    description: ["This label appears in Codekeeper's GitHub comments. Your repository name is unchanged."],
    maxLength: 100
  }));
  const ownersText = await prompt.inputText(tuiOptions(prompt, {
    message: "GitHub users who can run owner-only /codekeeper commands (comma-separated)",
    defaultValue: installation?.policy.repository.ownerLogins?.join(",") ?? snapshot.viewerLogin,
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
    description: ["Keep the authenticated user unless another maintainer can run owner-only commands."]
  }));

  if (!installation) {
    output.write("\nCredentials this setup will request later through GitHub CLI\n");
    output.write("Setup does not call a model. API keys go directly to GitHub CLI. Codekeeper does not display or store their values.\n");
    output.write("The installer sends the selected App key file directly to GitHub CLI. It does not read or display the key.\n");
    for (const name of requiredSecretNames({ modes, preset, tracing })) output.write(`  - ${name}: ${SECRET_PURPOSES[name]}\n`);
  } else {
    output.write("\nThe current GitHub App settings and API keys stay unchanged.\n");
  }

  const policy = installation?.policy ?? JSON.parse(bundle.contents[`policies/${preset}.json`]);
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
    models,
    tracing,
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
    message: "GitHub App Client ID (starts with Iv, not the numeric App ID)",
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
