import {
  CONSERVATIVE_BOUNDARIES,
  MODES,
  RELEASE_MANIFEST_TARGET
} from "../constants.mjs";
import { repositoryArtifactForTarget } from "../repository-artifacts.mjs";
import { capabilitySummary } from "./capabilities.mjs";
import { modelAssignments } from "./models.mjs";
import { normalizeModes } from "./normalization.mjs";

export function documentMap(files) {
  return files.map((file) => {
    const artifact = repositoryArtifactForTarget(file.path);
    return Object.freeze({
      path: file.path,
      purpose: file.delete === true
        ? artifact
          ? `Remove this release-owned artifact. ${artifact.purpose}`
          : "Remove this retired Codekeeper artifact"
        : file.path === RELEASE_MANIFEST_TARGET
          ? "Release version and managed generated-file inventory"
          : (artifact?.purpose ?? "Codekeeper setup")
    });
  });
}

export function workflowMap(modes, { maintenanceScheduled = true } = {}) {
  return normalizeModes(modes).map((mode) =>
    Object.freeze({
      mode,
      label: MODES[mode].label,
      description: MODES[mode].description,
      workflow: MODES[mode].target,
      trigger: mode === "maintain"
        ? maintenanceScheduled ? "scheduled report-only run and manual run" : "manual run"
        : MODES[mode].trigger,
      policyAgent: MODES[mode].policyAgent
    })
  );
}

export function completionGuidance(modes, enabled = true, update = false) {
  const normalizedModes = normalizeModes(modes);
  return Object.freeze({
    heading: enabled ? (update ? "Codekeeper keeps running the current default-branch configuration. Verify the updated installation after this pull request merges." : "The setup pull request is ready. Codekeeper is not proven ready until the pull request merges and codekeeper verify passes.") : "Codekeeper stays off after merge. Verify the installation before setting CODEKEEPER_ENABLED=true.",
    profileGuidance: "Packaged agent profiles are the default. Edit a profile in Settings to create an optional .github/codekeeper/agents/*.md repository override. Capability switches control repair, issue implementation, issue closure, and merge actions.",
    reviewGateWarning: !enabled && normalizedModes.includes("review") ? "Keep the Codekeeper review gate optional while Codekeeper is disabled." : null,
    closing: "After merge, run codekeeper verify from a clean, current default-branch checkout."
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
  const workflowDetails = new Map(
    workflowMap(plan.modes, {
      maintenanceScheduled: plan.maintenanceScheduled
    }).map((item) => [item.mode, item])
  );
  const workflows = markdownTable(
    ["Workflow", "Role", "What it does", "Trigger", "Provider and model"],
    modelAssignments(plan.modes).map(({ key, label, workflow }) => {
      const mode = plan.modes.find((candidate) => MODES[candidate].label === workflow);
      const selection = plan.models[key];
      return [MODES[mode].label, label, MODES[mode].description, workflowDetails.get(mode).trigger, `\`${selection.provider} / ${selection.model} / ${selection.effort}\``];
    })
  );
  const reviewDisabledNote = plan.modes.includes("review") && !plan.enabled
    ? "\nReview events fail the `Codekeeper review gate` while `CODEKEEPER_ENABLED=false`, so keep the gate optional until Codekeeper is enabled.\n"
    : "";
  const requiredSettings = [
    plan.variables.length ? `Required variables: ${plan.variables.map((item) => `\`${item.name}\``).join(", ")}.` : null,
    plan.secrets.length ? `Required secrets: ${plan.secrets.map((item) => `\`${item.name}\``).join(", ")}. Values are never stored in this branch or pull request.` : null
  ].filter(Boolean).join("\n\n");
  return `## Summary

Codekeeper CLI release **${plan.packageVersion}** uses the **${plan.preset}** starting model set at source commit \`${plan.source.commit}\`. Each role has its selected provider and model below. ${plan.update && plan.enabled ? "It is enabled now with the current default-branch configuration; this update applies after the pull request merges." : plan.update ? `It will be ${plan.enabled ? "enabled" : "disabled"} after this update pull request merges.` : `It will be ${plan.enabled ? "enabled" : "disabled"} after this setup pull request merges.`}

OpenAI traces are **${plan.tracing ? "enabled" : "disabled"}**.

Scheduled report-only maintenance is **${plan.maintenanceScheduled ? "enabled; scheduled runs cannot modify GitHub" : "disabled; manual maintenance remains available"}**. Manual dispatch always lets an operator explicitly choose dry or live maintenance.

Source: [${plan.source.repository}@${plan.source.commit}](https://github.com/${plan.source.repository}/tree/${plan.source.commit})

## Documents

${documents}

## Workflows

${workflows}

## Safety boundaries

${CONSERVATIVE_BOUNDARIES.map((item) => `- ${item}`).join("\n")}
${capabilitySummary(plan.capabilities, plan.modes).map((item) => `- ${item}`).join("\n")}
${reviewDisabledNote}
${requiredSettings ? `\n${requiredSettings}\n` : ""}

## After merge

${plan.enabled ? (plan.update ? "Codekeeper keeps running the current default-branch configuration. After this pull request merges, run `codekeeper verify` from a clean, current default-branch checkout." : "Codekeeper can start the selected workflows when this pull request merges. After merge, run `codekeeper verify` from a clean, current default-branch checkout before treating the installation as ready.") : "Codekeeper stays off. After merge, run `codekeeper verify`, then set `CODEKEEPER_ENABLED=true` when you want it to start."}

Packaged agent profiles are used by default. Edit a profile in Settings to create an optional \`.github/codekeeper/agents/*.md\` repository override for priorities, work selection, implementation approach, review standards, or reporting. The capability switches above control which GitHub actions Codekeeper can take. Scheduled maintenance is always report-only; only a manually dispatched live maintenance run can repair when repository repair is on. An issue marked ready can start implementation when issue implementation is on.

The installer did not merge this pull request or prove a workflow. A successful setup pull request is not a readiness result.
`;
}
