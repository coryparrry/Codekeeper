import {
  CAPABILITIES,
  CAPABILITY_IDS
} from "../constants.mjs";
import { InstallerError } from "../errors.mjs";
import { normalizeModes } from "./normalization.mjs";

export function applicableCapabilityIds(modes) {
  const selected = normalizeModes(modes);
  return CAPABILITY_IDS.filter((id) => id === "reviewRepair"
    ? selected.includes("review") && selected.includes("fix")
    : CAPABILITIES[id].modes.some((mode) => selected.includes(mode)));
}

export function normalizeCapabilities(modes, selected = []) {
  if (!Array.isArray(selected))
    throw new InstallerError("Capability choices are invalid.", {
      code: "PLAN_INVALID"
    });
  const applicable = applicableCapabilityIds(modes);
  if (selected.some((id) => !applicable.includes(id)) || new Set(selected).size !== selected.length) {
    throw new InstallerError("Capability choices do not match the selected workflows.", { code: "PLAN_INVALID" });
  }
  return Object.freeze(Object.fromEntries(CAPABILITY_IDS.map((id) => [id, selected.includes(id)])));
}

export function requiresAutomationBotLogin(modes, capabilities = [], ownerRequests = true) {
  const issueImplementation = Array.isArray(capabilities)
    ? capabilities.includes("issueImplementation")
    : capabilities?.issueImplementation === true;
  return ownerRequests || modes.includes("review") || (modes.includes("fix") && issueImplementation);
}

export function capabilitySummary(capabilities, modes = null) {
  const ids = modes ? applicableCapabilityIds(modes) : CAPABILITY_IDS;
  return ids.map((id) => `${CAPABILITIES[id].label}: ${capabilities[id] ? "on" : "off"}.`);
}
