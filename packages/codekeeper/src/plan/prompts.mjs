import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  ALL_MODEL_OPTIONS,
  CAPABILITIES,
  CONSERVATIVE_BOUNDARIES,
  MODE_IDS,
  MODES,
  MODEL_PROVIDER_SECRETS,
  RECOMMENDED_MODES,
  RECOMMENDED_PRESET,
  SECRET_PURPOSES
} from "../constants.mjs";
import { InstallerError } from "../errors.mjs";
import { upgradePolicy } from "../policy.mjs";
import { createEditableSettings, settingsAnswers, validateEditableSettings } from "../settings.mjs";
import {
  applicableCapabilityIds,
  capabilitySummary,
  normalizeCapabilities,
  requiresAutomationBotLogin
} from "./capabilities.mjs";
import {
  modelAssignments,
  normalizeModelChoices,
  requiredSecretNames
} from "./models.mjs";
import {
  appSlugFromInput,
  BOT_LOGIN,
  normalizeModes,
  normalizeOwnerLogins,
  validClientId,
  validDisplayName,
  validPrivateKeyPath
} from "./normalization.mjs";
import { editableSettingsForInstallation } from "./update.mjs";

function tuiOptions(prompt, plain, tui) {
  return prompt?.kind === "ink" ? { ...plain, ...tui } : plain;
}

function freshSettings(snapshot, bundle, preset = RECOMMENDED_PRESET) {
  const baselinePolicy = upgradePolicy(JSON.parse(bundle.contents[`policies/${preset}.json`]));
  baselinePolicy.repository.displayName = snapshot.displayName;
  baselinePolicy.repository.ownerLogins = [snapshot.viewerLogin.toLowerCase()];
  baselinePolicy.merge.allowedUserAuthors = [...baselinePolicy.repository.ownerLogins];
  baselinePolicy.ai.tracing.enabled = false;
  baselinePolicy.review.autoRepair = false;
  baselinePolicy.audit.repair.enabled = false;
  baselinePolicy.issues.allowAiImplementation = false;
  baselinePolicy.issues.closeExactDuplicates = false;
  baselinePolicy.merge.enabled = false;
  const profileDefaults = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  return {
    preset,
    baselinePolicy,
    profileDefaults,
    settings: createEditableSettings({
      policy: baselinePolicy,
      modes: RECOMMENDED_MODES,
      enabled: true,
      maintenanceScheduled: false,
      validationCommandCandidate: snapshot.validationCommandCandidate,
      profiles: profileDefaults
    })
  };
}

function recommendedAnswers(snapshot, bundle) {
  const fresh = freshSettings(snapshot, bundle);
  return Object.freeze({
    ...settingsAnswers(fresh.settings),
    preset: fresh.preset
  });
}

export async function collectSetupAnswers({ prompt, snapshot, bundle, output, initialAnswers = null }) {
  const installation = snapshot.installation ?? null;
  if (!initialAnswers) {
    output.write(`Codekeeper guided setup\n\n`);
    output.write(installation
      ? "This edits the current Codekeeper installation through a new pull request.\n\n"
      : "This creates a setup pull request. It does not run a model, merge the pull request, or put secrets in generated files.\n\n");
    const repositoryConfirmed = await prompt.confirm({
      message: `${installation ? "Edit Codekeeper in" : "Install into"} ${snapshot.repository} on default branch ${snapshot.defaultBranch}?`,
      defaultValue: true,
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
    if (!repositoryConfirmed)
      throw new InstallerError("Setup was cancelled before any mutation.", {
        code: "USER_CANCELLED"
      });
  }
  const canEditSettings = prompt?.kind === "ink" && typeof prompt.editSettings === "function";
  let chooseCustom = Boolean(installation || initialAnswers);
  if (!chooseCustom && canEditSettings) {
    chooseCustom =
      (await prompt.select({
        step: "setup",
        message: "Choose a starting setup",
        description: ["Recommended starts with automatic pull-request review and manual maintenance.", "When enabled, scheduled maintenance is report-only; manual dispatch can explicitly choose dry or live mode. Tracing, schedules, repository repair, issue implementation, and automatic merge start off."],
        defaultValue: "recommended",
        choices: [
          {
            value: "recommended",
            label: "Recommended — review on, manual maintenance available"
          },
          { value: "custom", label: "Customize — open all settings" }
        ]
      })) === "custom";
    if (!chooseCustom) {
      output.write("Using the recommended setup: review on, manual maintenance available, scheduled runs off, tracing and code-changing automation off.\n");
      return recommendedAnswers(snapshot, bundle);
    }
  }
  if (canEditSettings && chooseCustom) {
    const installed = installation ? editableSettingsForInstallation(snapshot, bundle) : null;
    const preset = initialAnswers?.preset ?? installed?.preset ?? "openai";
    const fresh = installation ? null : freshSettings(snapshot, bundle, preset);
    const baselinePolicy = installed?.settings.policy ?? fresh.baselinePolicy;
    const profileDefaults = fresh?.profileDefaults ?? Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
    const settings = initialAnswers
      ? createEditableSettings({
          policy: initialAnswers.policy,
          modes: initialAnswers.modes,
          enabled: initialAnswers.enabled,
          maintenanceScheduled: initialAnswers.maintenanceScheduled,
          validationCommandCandidate: snapshot.validationCommandCandidate,
          validationCommand: initialAnswers.validationCommand,
          profiles: initialAnswers.profiles,
          profileDefaults,
          profileSources: initialAnswers.profileSources
        })
      : (installed?.settings ?? fresh.settings);
    const edited = await prompt.editSettings({
      settings,
      baselinePolicy,
      repository: snapshot.repository,
      update: Boolean(installation)
    });
    validateEditableSettings(edited, baselinePolicy);
    return Object.freeze({
      ...settingsAnswers(edited),
      preset,
      ...(initialAnswers?.releaseUpdate ? { releaseUpdate: true } : {})
    });
  }
  if (!installation) output.write("Recommended starter setup\n");
  if (!installation) {
    output.write("  - Pull request review: your GitHub App posts comments, labels, and a blocking result on controlled same-repository PRs\n");
    output.write("  - Repository maintenance: installed for manual runs; its schedule starts off\n");
    output.write("  - OpenAI starting models: you can assign any supported provider and model to each role\n");
    output.write("  - Issue triage and issue fix are not included\n");
    output.write("  - Tracing, repository repair, issue implementation, and automatic merge start off\n");
    output.write("  - Codekeeper starts after merge; run codekeeper verify before treating it as ready\n");
    output.write("Press Return at the next question to accept these choices.\n");
  }
  const useRecommended = installation
    ? false
    : await prompt.confirm({
        message: "Use the recommended starter setup?",
        defaultValue: true
      });
  if (useRecommended) {
    output.write("Using the recommended setup: review on, manual maintenance available, scheduled runs off, tracing and code-changing automation off.\n");
    return recommendedAnswers(snapshot, bundle);
  }

  let modes;
  let preset;
  if (installation) {
    modes = [...installation.modes];
    preset = installation.policy.ai.agents.issue?.provider === "deepseek" ? "mixed" : "openai";
    output.write(`Editing the current ${modes.map((mode) => MODES[mode].label).join(" + ")} installation.\n`);
    if (installation.legacyFiles?.length) {
      output.write(`Legacy inactive file remains unchanged: ${installation.legacyFiles.join(", ")}. Remove it in a separately reviewed pull request when ready.\n`);
    }
  } else {
    output.write("\nCustom setup: install only the workflows that you want to use. Issue triage responds to issue events. You choose issue implementation separately.\n");
    modes = await prompt.multiselect(
      tuiOptions(
        prompt,
        {
          message: "Choose workflows to generate:",
          defaultValues: RECOMMENDED_MODES,
          choices: MODE_IDS.map((mode) => ({
            value: mode,
            label: `${MODES[mode].label} — ${MODES[mode].description}`
          }))
        },
        {
          step: "workflows",
          description: ["Install only the workflows you intend to prove in this repository."]
        }
      )
    );
    preset = await prompt.select(
      tuiOptions(
        prompt,
        {
          message: "Choose the starting model set:",
          defaultValue: RECOMMENDED_PRESET,
          choices: [
            {
              value: "openai",
              label: "openai — use OpenAI for every selected workflow (recommended)"
            },
            {
              value: "mixed",
              label: "mixed — use DeepSeek for issue triage and OpenAI for other workflows"
            }
          ]
        },
        {
          step: "models",
          description: ["This choice supplies starting models. You can change every role on the next screens."]
        }
      )
    );
  }
  const presetPolicy = installation?.policy ?? JSON.parse(bundle.contents[`policies/${preset}.json`]);
  const models = {};
  for (const assignment of modelAssignments(modes)) {
    const { key, agent: agentId, label, workflow } = assignment;
    const agent = presetPolicy.ai.agents[agentId];
    const defaultChoice = ALL_MODEL_OPTIONS.find((choice) => choice.provider === agent.provider && choice.model === agent.model && choice.effort === agent.effort);
    const customChoiceId = `current-custom-${key}`;
    const newCustomChoiceId = `custom-${key}`;
    const choices = [
      ...(defaultChoice ? [] : [{
        id: customChoiceId,
        label: `Current custom model · ${agent.provider} · ${agent.model} · ${agent.effort} effort`
      }]),
      ...ALL_MODEL_OPTIONS,
      { id: newCustomChoiceId, label: "Custom provider and model" }
    ];
    const selectedModel = await prompt.select(
      tuiOptions(
        prompt,
        {
          message: `Assign a model to the ${label}:`,
          defaultValue: defaultChoice?.id ?? customChoiceId,
          choices: choices.map((choice) => ({
            value: choice.id,
            label: choice.label
          }))
        },
        {
          step: "models",
          description: [`${workflow} uses this role. The role is not tied to one provider.`, "You can change this choice later in .github/codekeeper.json."]
        }
      )
    );
    if (selectedModel === newCustomChoiceId) {
      const provider = await prompt.select(
        tuiOptions(
          prompt,
          {
            message: `Choose the provider for the ${label}:`,
            defaultValue: agent.provider,
            choices: Object.keys(MODEL_PROVIDER_SECRETS).map((value) => ({
              value,
              label: value
            }))
          },
          {
            step: "models",
            description: ["Provider credentials are collected separately and never written to the repository."]
          }
        )
      );
      const model = await prompt.inputText(
        tuiOptions(
          prompt,
          {
            message: `Enter the model ID for the ${label}:`,
            defaultValue: provider === agent.provider ? agent.model : ""
          },
          {
            step: "models",
            description: ["Use the exact model ID accepted by the selected provider."]
          }
        )
      );
      const effort = presetPolicy.ai.providers[provider].supportsReasoningEffort
        ? await prompt.select(tuiOptions(prompt, {
          message: `Choose the reasoning effort for the ${label}:`,
          defaultValue: provider === agent.provider ? agent.effort : "medium",
          choices: ["none", "minimal", "low", "medium", "high", "max", "xhigh"]
            .map((value) => ({ value, label: value }))
        }, {
          step: "models",
          description: ["The provider must support the selected reasoning effort."]
        }))
        : "none";
      models[key] = { provider, model, effort };
    } else {
      models[key] =
        selectedModel === customChoiceId
          ? {
              provider: agent.provider,
              model: agent.model,
              effort: agent.effort
            }
          : selectedModel;
    }
  }
  const tracing =
    prompt?.kind === "ink"
      ? (await prompt.select({
          step: "tracing",
          message: "Enable OpenAI traces?",
          description: ["Traces record model runs in OpenAI Platform Logs.", "Enabled needs a separate OpenAI Platform API key. Disabled does not request the trace key."],
          defaultValue: (installation ? installation.policy.ai.tracing.enabled : false) ? "enabled" : "disabled",
          choices: [
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" }
          ]
        })) === "enabled"
      : await prompt.confirm({
          message: "Enable OpenAI traces?",
          defaultValue: installation ? installation.policy.ai.tracing.enabled : false
        });
  const enabled =
    prompt?.kind === "ink"
      ? (await prompt.select({
          step: "startup",
          message: installation ? "Start Codekeeper now?" : "Start Codekeeper after the setup pull request merges?",
          description: installation ? ["Enabled changes the repository setting now and starts the current default-branch configuration.", "Configuration changes from this update take effect after its pull request merges."] : ["Enabled starts the workflows you selected as soon as this setup is merged.", "Disabled installs the files and secrets but keeps every Codekeeper workflow off."],
          defaultValue: (installation ? snapshot.existingSettings.enabled : true) ? "enabled" : "disabled",
          choices: [
            { value: "enabled", label: "Enabled (recommended)" },
            { value: "disabled", label: "Disabled" }
          ]
        })) === "enabled"
      : await prompt.confirm({
          message: installation ? "Start Codekeeper now?" : "Start Codekeeper after the setup pull request merges?",
          defaultValue: installation ? snapshot.existingSettings.enabled : true,
          ...(installation
            ? {
                description: ["Enabled changes the repository setting now and starts the current default-branch configuration.", "Configuration changes from this update take effect after its pull request merges."]
              }
            : {})
        });
  const applicableCapabilities = applicableCapabilityIds(modes);
  const capabilities = applicableCapabilities.length
    ? await prompt.multiselect(tuiOptions(prompt, {
      message: "Choose capabilities to turn on:",
      allowEmpty: true,
      defaultValues: installation
        ? applicableCapabilities.filter((id) => ({
          reviewRepair: installation.policy.review.autoRepair,
          repair: installation.policy.audit.repair.enabled,
          issueImplementation: installation.policy.issues.allowAiImplementation,
          duplicateClosure: installation.policy.issues.closeExactDuplicates,
          autoMerge: installation.policy.merge.enabled
        })[id])
        : [],
      choices: applicableCapabilities.map((id) => ({
        value: id,
        label: `${CAPABILITIES[id].label} — ${CAPABILITIES[id].description}`
      }))
    }, {
      step: "capabilities",
      description: [
        "Automatic code changes and merge start off.",
        "Select only the capabilities that you want Codekeeper to use."
      ]
    }))
    : [];
  const codeChangingCapability = capabilities.some((id) => ["reviewRepair", "repair", "issueImplementation"].includes(id));
  let validationCommand = null;
  if (codeChangingCapability) {
    if (!snapshot.validationCommandCandidate) {
      throw new InstallerError(
        "Code-changing capabilities require a trusted repository validation command. Add a supported root package lockfile and check or test script, then rerun setup.",
        { code: "SETTING_INVALID" },
      );
    }
    const validationConfirmed = await prompt.confirm(
      tuiOptions(
        prompt,
        {
          message: `Record ${snapshot.validationCommandCandidate} as the required validation command for code changes?`,
          defaultValue: false,
        },
        {
          step: "validation",
          description: ["The installer never runs this command.", "Codekeeper's fresh credential-free verifier will run this exact command before it can publish a repair."],
          yesLabel: "Confirm validation command",
          noLabel: "Cancel code-changing setup",
        },
      ),
    );
    if (!validationConfirmed) {
      throw new InstallerError("Code-changing capabilities were not enabled because the repository validation command was not confirmed.", {
        code: "USER_CANCELLED",
      });
    }
    validationCommand = snapshot.validationCommandCandidate;
  }
  const maintenanceScheduled = modes.includes("maintain")
    ? await prompt.confirm(
        tuiOptions(
          prompt,
          {
            message: "Run report-only maintenance on a schedule?",
            defaultValue: installation?.maintenanceScheduled ?? false
          },
          {
            step: "automation",
            description: ["Scheduled runs are always report-only and cannot modify GitHub.", "Manual maintenance remains available when the schedule is off and lets you explicitly choose dry or live mode."]
          }
        )
      )
    : false;
  const displayName = await prompt.inputText(
    tuiOptions(
      prompt,
      {
        message: "Name to show in Codekeeper comments",
        defaultValue: installation?.policy.repository.displayName ?? snapshot.displayName,
        validate: (value) => validDisplayName(value) || "Use 1–100 printable characters."
      },
      {
        step: "identity",
        description: ["This label appears in Codekeeper's GitHub comments. Your repository name is unchanged."],
        maxLength: 100
      }
    )
  );
  const ownersText = await prompt.inputText(
    tuiOptions(
      prompt,
      {
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
      },
      {
        step: "identity",
        description: ["Keep the authenticated user unless another maintainer can run owner-only commands."]
      }
    )
  );

  if (!installation) {
    output.write("\nCredentials this setup will request later through GitHub CLI\n");
    output.write("Setup does not call a model. API keys go directly to GitHub CLI. Codekeeper does not display or store their values.\n");
    output.write("The installer sends the selected App key file directly to GitHub CLI. It does not read or display the key.\n");
    const selectedModels = normalizeModelChoices({
      modes,
      preset,
      bundle,
      choices: models,
      policySource: JSON.stringify(presetPolicy)
    });
    for (const name of requiredSecretNames({
      modes,
      models: selectedModels,
      tracing,
      policy: presetPolicy
    }))
      output.write(`  - ${name}: ${SECRET_PURPOSES[name]}\n`);
  } else {
    output.write("\nThe current GitHub App settings and existing API keys stay unchanged. If this edit needs a new key, the installer requests it after the final review.\n");
  }

  const policy = installation?.policy ?? JSON.parse(bundle.contents[`policies/${preset}.json`]);
  output.write("\nSafety settings\n");
  capabilitySummary(normalizeCapabilities(modes, capabilities), modes).forEach((item) => output.write(`  - ${item}\n`));
  CONSERVATIVE_BOUNDARIES.forEach((item) => output.write(`  - ${item}\n`));
  output.write(`The policy has ${policy.audit.repair.protectedPaths.length} protected-path rules. Review the full list in the setup pull request.\n`);
  const confirmed = await prompt.confirm(
    tuiOptions(
      prompt,
      {
        message: "Continue with these safety settings?",
        defaultValue: false
      },
      {
        step: "safety",
        description: [...capabilitySummary(normalizeCapabilities(modes, capabilities), modes), ...CONSERVATIVE_BOUNDARIES, `${policy.audit.repair.protectedPaths.length} protected-path rules are bundled for review before merge.`],
        yesLabel: "Continue",
        noLabel: "Cancel"
      }
    )
  );
  if (!confirmed)
    throw new InstallerError("Setup was cancelled before any mutation.", {
      code: "USER_CANCELLED"
    });
  return Object.freeze({
    modes: normalizeModes(modes),
    preset,
    models,
    tracing,
    displayName,
    ownerLogins: normalizeOwnerLogins(ownersText.split(",")),
    enabled,
    maintenanceScheduled,
    capabilities,
    validationCommand,
  });
}

export async function collectAutomationBotLogin({ prompt, output }) {
  output.write("  - App settings URL: copy it from the browser after GitHub saves the App\n");
  if (prompt?.kind === "ink") {
    const appInput = await prompt.inputText({
      step: "GitHub App",
      message: "Paste the GitHub App settings URL",
      description: [
        "Copy the GitHub App settings URL after GitHub saves the App.",
        "For https://github.com/settings/apps/my-codekeeper-app, Codekeeper uses my-codekeeper-app[bot].",
        "You can also enter only my-codekeeper-app."
      ],
      validate: (value) => Boolean(appSlugFromInput(value)) || "Paste a GitHub App settings URL, or enter its lowercase URL name."
    });
    const appSlug = appSlugFromInput(appInput);
    if (!appSlug)
      throw new InstallerError("The GitHub App settings URL is invalid.", {
        code: "PLAN_INVALID"
      });
    return `${appSlug}[bot]`;
  }
  const automationBotLogin = await prompt.inputText({
    message: "GitHub App bot login (<app-slug>[bot], for example my-app[bot])",
    validate: (value) => BOT_LOGIN.test(value.toLowerCase()) || "Enter the App bot login ending in [bot]."
  });
  return automationBotLogin.toLowerCase();
}

export async function collectAppAnswers({ prompt, modes, capabilities = [], ownerRequests = true, output }) {
  output.write("\nGitHub App identifiers\n");
  output.write("  - Client ID: find the value that starts with Iv in the App settings\n");
  const appClientId = await prompt.inputText(
    tuiOptions(
      prompt,
      {
        message: "GitHub App Client ID (starts with Iv, not the numeric App ID)",
        validate: (value) => validClientId(value) || "Enter the App Client ID shown in GitHub App settings."
      },
      {
        step: "GitHub App",
        description: ["Find Client ID in the App's General settings. It begins with Iv.", "Do not enter the numeric App ID."]
      }
    )
  );
  const automationBotLogin = requiresAutomationBotLogin(modes, capabilities, ownerRequests) ? await collectAutomationBotLogin({ prompt, output }) : null;
  return Object.freeze({
    appClientId,
    automationBotLogin: automationBotLogin?.toLowerCase() ?? null
  });
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
