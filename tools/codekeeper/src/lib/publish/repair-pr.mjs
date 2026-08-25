import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatch, collectWorkingTreeChanges, configureAutomationIdentity, createBranchAndCommit, createPatch, currentHead, ensureClean, gitText, pushBranch } from "../git.mjs";
import { readRegularFile, warn } from "../io.mjs";
import { LABELS } from "../label-ownership.mjs";
import { repairMarker, sha256 } from "../markers.mjs";
import { validatePatch } from "../policy.mjs";
import { renderRepairPullRequest, sanitizePublicTitle } from "../render.mjs";
import {
  expectedAutomationIdentity,
  managedLifecycleLabels,
  matchesAutomationActor,
  normalizeAutomationIdentity
} from "./common.mjs";

function branchSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 240);
}

export function repairBranch(config, mode, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Repair fingerprint must be a SHA-256 hex digest");
  const branch = branchSlug(`${config.repository.automationBranchPrefix}${mode}-${fingerprint}`);
  if (!branch.endsWith(`-${fingerprint}`)) throw new Error("Automation branch prefix leaves no room for repair fingerprint");
  return branch;
}

export function isTrustedRepairPull(pull, { fingerprint, config, repository, botLogin, botId, mode }) {
  const identity = normalizeAutomationIdentity({ login: botLogin, id: botId });
  if (!identity) return false;
  const branch = repairBranch(config, mode, fingerprint);
  return Boolean(
    matchesAutomationActor(pull?.user, identity) &&
    typeof pull?.body === "string" &&
    pull.body.endsWith(repairMarker(fingerprint)) &&
    String(pull.head?.ref ?? "") === branch &&
    pull.head?.repo?.full_name === repository &&
    pull.base?.repo?.full_name === repository
  );
}

async function findOpenRepairPull(github, fingerprint, config, mode) {
  const automationIdentity = expectedAutomationIdentity();
  const branch = repairBranch(config, mode, fingerprint);
  const pull = await github.findOpenPullByHead(branch);
  return pull && isTrustedRepairPull(pull, {
    fingerprint,
    config,
    repository: github.repository,
    botLogin: automationIdentity.login,
    botId: automationIdentity.id,
    mode
  }) ? pull : null;
}

async function verifyExistingRepairPull({
  github,
  pull,
  branch,
  expectedTreeSha,
  context,
  config,
  fingerprint,
  automationIdentity
}) {
  const remote = await github.getBranchTip(branch);
  if (!remote) throw new Error(`Existing repair PR #${pull.number} has no live automation branch`);
  if (
    remote.treeSha !== expectedTreeSha ||
    remote.parentShas.length !== 1 ||
    remote.parentShas[0] !== context.baseSha
  ) {
    throw new Error(`Existing repair PR #${pull.number} no longer matches the sealed repair tree`);
  }
  const live = await github.getPull(pull.number, { expectedHeadSha: remote.headSha });
  if (!isTrustedRepairPull(live, {
    fingerprint,
    config,
    repository: github.repository,
    botLogin: automationIdentity.login,
    botId: automationIdentity.id,
    mode: context.mode
  })) {
    throw new Error(`Existing repair PR #${pull.number} is no longer trusted`);
  }
  const expectedBaseRef = context.defaultBranch ?? config.repository.defaultBranch;
  if (
    live.state !== "open" ||
    live.head?.ref !== branch ||
    live.head?.sha !== remote.headSha ||
    live.base?.ref !== expectedBaseRef ||
    live.base?.sha !== context.baseSha
  ) {
    throw new Error(`Existing repair PR #${pull.number} no longer matches the sealed repair target`);
  }
  return live;
}

export async function publishPatchPullRequest({
  github,
  artifactDirectory,
  manifest,
  context,
  config,
  title,
  summary,
  body,
  risk,
  readyForReview,
  fingerprint,
  issueNumber = null,
  finding = null,
  dryRun = false
}) {
  if (!manifest.patch?.valid || !manifest.patch.fileName) {
    return { created: false, reason: manifest.patch?.reasons?.join("; ") || "No validated patch" };
  }

  const labels = new Set([LABELS.REVIEW_NEEDED]);
  if (currentHead() !== context.baseSha) {
    return { created: false, reason: `Default branch moved from ${context.baseSha} to ${currentHead()}` };
  }
  ensureClean();
  const patchPath = path.join(artifactDirectory, manifest.patch.fileName);
  const patchBytes = await readRegularFile(patchPath);
  if (sha256(patchBytes) !== manifest.patch.sha256) throw new Error("Patch artifact SHA-256 does not match manifest");
  if (patchBytes.length > config.audit.repair.maximumPatchBytes) {
    throw new Error(`Patch artifact is ${patchBytes.length} bytes; maximum is ${config.audit.repair.maximumPatchBytes}`);
  }
  applyPatch(patchPath);
  const liveChanges = { ...(await collectWorkingTreeChanges()), patchBytes: patchBytes.length };
  const livePolicy = validatePatch(liveChanges, config);
  if (!livePolicy.valid) throw new Error(`Fresh-checkout patch validation failed: ${livePolicy.reasons.join("; ")}`);
  const expectedFiles = [...manifest.patch.files].sort();
  const actualFiles = [...livePolicy.files].sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(`Fresh-checkout patch files differ from validated artifact: expected ${expectedFiles.join(", ")}, got ${actualFiles.join(", ")}`);
  }
  // Do not execute repository code in this token-bearing job. Configurable test
  // commands ran in the analysis job, which had no GitHub write token. Here we
  // only prove that the fresh checkout produces the exact validated patch.
  const freshPatchDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-publish-patch-"));
  const freshPatchPath = path.join(freshPatchDirectory, "fresh.diff");
  try {
    await createPatch(freshPatchPath);
    const freshPatchBytes = await readFile(freshPatchPath);
    if (sha256(freshPatchBytes) !== manifest.patch.sha256) {
      throw new Error("Fresh-checkout patch differs from the validated artifact");
    }
  } finally {
    await rm(freshPatchDirectory, { recursive: true, force: true });
  }

  const branch = repairBranch(config, context.mode, fingerprint);
  const normalizedTitle = sanitizePublicTitle(title, 200) || "chore: apply bounded maintenance repair";
  const draft = !readyForReview || risk !== "low";
  const validationReceipt = manifest.validation?.receipt;
  const validationCommands = validationReceipt?.commands ?? [];
  const validationSummary = [
    ...(validationCommands.length > 0
      ? validationCommands.map(
          (item) =>
            `- \`${item.command}\`: ${item.exitCode === 0 ? "passed" : "failed"} in ${item.durationMs} ms; stdout SHA-256 \`${item.stdoutDigest}\``,
        )
      : ["- No repository-specific validation commands were configured."]),
    `- Candidate SHA-256: \`${manifest.candidateSha256}\``,
    `- Base commit: \`${validationReceipt?.baseSha ?? context.baseSha}\``,
  ].join("\n");
  const prBody = renderRepairPullRequest({
    titleSummary: summary,
    body,
    finding,
    issueNumber,
    fingerprint,
    validationSummary,
    files: livePolicy.files
  });

  if (dryRun) {
    return { created: false, dryRun: true, branch, title: normalizedTitle, draft, files: livePolicy.files, prBody };
  }

  const automationIdentity = expectedAutomationIdentity();
  configureAutomationIdentity(automationIdentity);
  createBranchAndCommit({ branch, message: "chore: apply automated maintenance repair" });
  const expectedTreeSha = gitText(["rev-parse", "HEAD^{tree}"]);
  const existing = await findOpenRepairPull(github, fingerprint, config, context.mode);
  let pull = existing;
  let created = false;
  const remote = await github.getBranchTip(branch);
  if (!pull && remote && (
    remote.treeSha !== expectedTreeSha ||
    remote.parentShas.length !== 1 ||
    remote.parentShas[0] !== context.baseSha
  )) {
    throw new Error(`Automation branch ${branch} already exists with unexpected content`);
  }
  let pushedByThisRun = false;
  if (pull) {
    pull = await verifyExistingRepairPull({
      github, pull, branch, expectedTreeSha, context, config, fingerprint, automationIdentity
    });
  } else {
    if (!remote) {
      await github.mutateIfCurrent(() => pushBranch(branch, github.token));
      pushedByThisRun = true;
    }
    try {
      pull = await github.createPull({
        title: normalizedTitle,
        body: prBody,
        head: branch,
        base: context.defaultBranch ?? config.repository.defaultBranch,
        draft
      });
      created = true;
    } catch (error) {
      if (pushedByThisRun) {
        try {
          const existingPull = await github.findOpenPullByHead(branch);
          if (!existingPull) await github.deleteBranch(branch);
        } catch (cleanupError) {
          warn(`Could not remove orphaned automation branch ${branch}: ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }
  if (!dryRun) {
    if (!created) {
      pull = await verifyExistingRepairPull({
        github, pull, branch, expectedTreeSha, context, config, fingerprint, automationIdentity
      });
    }
    await github.ensureLabels(config.labels, [...labels]);
    if (!created) {
      pull = await verifyExistingRepairPull({
        github, pull, branch, expectedTreeSha, context, config, fingerprint, automationIdentity
      });
    }
    await github.replaceManagedLabels(
      pull.number,
      [...labels],
      managedLifecycleLabels([LABELS.REVIEW_NEEDED]),
      "lifecycle",
    );
  }
  return created
    ? {
      created: true,
      pullRequest: pull.number,
      url: pull.html_url,
      branch,
      draft,
      awaitingReview: true,
      reason: "Auto-merge is evaluated only after the current-head Codekeeper review publishes"
    }
    : { created: false, reason: "Existing repair PR", pullRequest: pull.number, url: pull.html_url };
}
