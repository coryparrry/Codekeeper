import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES
} from "../constants.mjs";
import { InstallerError } from "../errors.mjs";
import { createEditableSettings, settingsAnswers } from "../settings.mjs";

export function editableSettingsForInstallation(snapshot, bundle) {
  const installation = snapshot.installation;
  if (!installation) {
    throw new InstallerError("No Codekeeper installation was found. Run codekeeper init first.", {
      code: "UPDATE_NOT_INSTALLED"
    });
  }
  const preset = installation.policy.ai.agents.issue?.provider === "deepseek" ? "mixed" : "openai";
  const profiles = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [
    id,
    installation.contents[AGENT_PROFILES[id].target] ?? bundle.contents[AGENT_PROFILES[id].asset]
  ]));
  const profileDefaults = Object.fromEntries(AGENT_PROFILE_IDS.map((id) => [id, bundle.contents[AGENT_PROFILES[id].asset]]));
  const settings = createEditableSettings({
    policy: installation.policy,
    modes: installation.modes,
    enabled: snapshot.existingSettings.enabled,
    maintenanceScheduled: installation.maintenanceScheduled,
    validationCommandCandidate: snapshot.validationCommandCandidate,
    validationCommand: installation.policy.audit.repair.validationCommands.includes(snapshot.validationCommandCandidate)
      ? snapshot.validationCommandCandidate
      : null,
    profiles,
    profileDefaults,
    profileOverrides: AGENT_PROFILE_IDS.filter((id) => Object.hasOwn(installation.contents, AGENT_PROFILES[id].target))
  });
  return { preset, settings };
}

export function buildUpdateAnswers({ snapshot, bundle, output }) {
  const { preset, settings } = editableSettingsForInstallation(snapshot, bundle);
  output.write("Codekeeper release update\n\n");
  output.write("This advances the release-owned workflow and runtime pins, policy safety boundaries, and provider definitions.\n");
  output.write("Your selected workflows, repository settings, model choices, automation choices, and existing agent profile overrides stay unchanged.\n\n");
  return Object.freeze({
    ...settingsAnswers(settings),
    preset,
    releaseUpdate: true,
    appClientId: snapshot.existingSettings.appClientId,
    automationBotLogin: snapshot.existingSettings.automationBotLogin
  });
}
