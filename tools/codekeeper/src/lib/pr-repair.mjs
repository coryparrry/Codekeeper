import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyPatch,
  assertCandidateValidationReceipt,
  collectWorkingTreeChanges,
  configureAutomationIdentity,
  createCommitOnCurrentHead,
  createPatch,
  currentHead,
  ensureClean,
  pushHeadToBranch
} from "./git.mjs";
import { readRegularFile } from "./io.mjs";
import { isAmbiguousGitHubMutationError } from "./github.mjs";
import { fixRunMarker, sha256 } from "./markers.mjs";
import { validatePatch } from "./policy.mjs";
import { frozenPullRepairReviewThreads, frozenPullRepairSubject, frozenPullRepairSubjectSha256 } from "./pull-repair-state.mjs";
import { sanitizeMarkdown } from "./render.mjs";
import { resumeDirectOwnerFix } from "./publish/owner-command.mjs";

export { frozenPullRepairReviewThreads, frozenPullRepairSubject, frozenPullRepairSubjectSha256 } from "./pull-repair-state.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const REPAIR_PUBLICATION_PHASE = Object.freeze({
  PREPARED: "prepared",
  COMMIT_CREATED: "commit-created",
  PUSH_ATTEMPTED: "push-attempted",
  PUSH_CONFIRMED: "push-confirmed",
  PR_REVALIDATED: "pr-revalidated",
  THREADS_RECONCILED: "threads-reconciled",
  COMPLETE: "complete"
});

function requiredText(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\0\r\n]/.test(normalized)) throw new Error(`Frozen PR target has an invalid ${name}`);
  return normalized;
}

export function frozenPullRepairTarget(context, config) {
  const target = context?.target;
  if (!target || target.kind !== "pull_request") throw new Error("Frozen fix context is not a pull request repair");
  if (!Number.isSafeInteger(target.number) || target.number <= 0) throw new Error("Frozen PR target has an invalid number");
  const frozen = {
    kind: target.kind,
    number: target.number,
    headRef: requiredText(target.headRef, "head ref"),
    headSha: requiredText(target.headSha, "head SHA"),
    headRepository: requiredText(target.headRepository, "head repository"),
    baseRef: requiredText(target.baseRef, "base ref"),
    baseSha: requiredText(target.baseSha, "base SHA"),
    baseRepository: requiredText(target.baseRepository, "base repository"),
    subjectSha256: requiredText(target.subjectSha256, "repair evidence SHA-256"),
    reviewThreadIds: Array.isArray(target.reviewThreadIds) ? [...target.reviewThreadIds] : []
  };
  if (!COMMIT_SHA.test(frozen.headSha) || !COMMIT_SHA.test(frozen.baseSha) || !SHA256.test(frozen.subjectSha256)) {
    throw new Error("Frozen PR target requires full head and base commit SHAs plus repair evidence SHA-256");
  }
  if (frozen.headRepository !== context.repository || frozen.baseRepository !== context.repository) {
    throw new Error(`PR #${frozen.number} is not a same-repository repair target`);
  }
  if (frozen.baseRef !== config.repository.defaultBranch || context.defaultBranch !== frozen.baseRef) {
    throw new Error(`PR #${frozen.number} does not target the configured default branch`);
  }
  if (frozen.headRef === frozen.baseRef) throw new Error(`PR #${frozen.number} uses the default branch as its head`);
  if (context.baseSha !== frozen.headSha) throw new Error(`PR #${frozen.number} checkout is not frozen to its head SHA`);
  return frozen;
}

function repairEvidencePolicy(context, config) {
  const authorizationMode = requiredText(context.authorizationMode, "repair authorization mode");
  if (!["owner", "policy"].includes(authorizationMode)) {
    throw new Error("Frozen PR target has invalid repair authorization mode");
  }
  return {
    authorizationMode,
    actor: requiredText(context.requestedBy, "repair actor"),
    ownerLogins: config.repository.ownerLogins.map((login) => requiredText(login, "repository owner login"))
  };
}

export function assertLivePullRepairTarget(pull, target, { expectedHeadSha = target.headSha } = {}) {
  if (!pull || pull.number !== target.number) throw new Error(`PR #${target.number} could not be revalidated`);
  if (pull.state !== "open") throw new Error(`PR #${target.number} is not open`);
  if (pull.draft) throw new Error(`PR #${target.number} is a draft`);
  const checks = [
    [pull.head?.ref, target.headRef, "head branch"],
    [pull.head?.sha, expectedHeadSha, "head SHA"],
    [pull.head?.repo?.full_name, target.headRepository, "head repository"],
    [pull.base?.ref, target.baseRef, "base branch"],
    [pull.base?.sha, target.baseSha, "base SHA"],
    [pull.base?.repo?.full_name, target.baseRepository, "base repository"]
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) {
      throw new Error(`PR #${target.number} ${label} changed from ${expected} to ${actual ?? "missing"}`);
    }
  }
  return pull;
}

async function exactPatch({ artifactDirectory, manifest, context, config }) {
  if (currentHead() !== context.baseSha) {
    throw new Error(`Repair checkout moved from ${context.baseSha} to ${currentHead()}`);
  }
  ensureClean();
  const patchPath = path.join(artifactDirectory, manifest.patch.fileName);
  const patchBytes = await readRegularFile(patchPath);
  if (sha256(patchBytes) !== manifest.patch.sha256) throw new Error("Patch artifact SHA-256 does not match manifest");
  if (patchBytes.length > config.audit.repair.maximumPatchBytes) {
    throw new Error(`Patch artifact is ${patchBytes.length} bytes; maximum is ${config.audit.repair.maximumPatchBytes}`);
  }
  assertCandidateValidationReceipt(manifest.validation?.receipt, {
    candidateSha256: manifest.candidateSha256,
    configSha256: manifest.configSha256,
    patchSha256: manifest.patch.sha256,
    baseSha: context.baseSha,
    config,
  });
  applyPatch(patchPath);
  const changes = await collectWorkingTreeChanges();
  const policy = validatePatch({ ...changes, patchBytes: patchBytes.length }, config);
  if (!policy.valid) throw new Error(`Fresh PR-head patch validation failed: ${policy.reasons.join("; ")}`);
  const expectedFiles = [...manifest.patch.files].sort();
  const actualFiles = [...policy.files].sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error(`Fresh PR-head patch files differ from validated artifact: expected ${expectedFiles.join(", ")}, got ${actualFiles.join(", ")}`);
  }
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-pr-repair-patch-"));
  try {
    const freshPath = path.join(temporaryDirectory, "fresh.diff");
    await createPatch(freshPath);
    if (sha256(await readFile(freshPath)) !== manifest.patch.sha256) {
      throw new Error("Fresh PR-head patch differs from the validated artifact");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return { files: policy.files, stagePaths: changes.files.flatMap((file) => [file.path, file.sourcePath].filter(Boolean)) };
}

function remoteReadSummary(result, resource) {
  if (result.status === "rejected") {
    const reason = sanitizeMarkdown(String(result.reason?.message ?? result.reason).replace(/[\r\n\t]+/g, " ").slice(0, 500));
    return `${resource} read failed (${reason})`;
  }
  if (!result.value) return `${resource} is missing`;
  const commitSha = resource === "PR" ? result.value.head?.sha : result.value.commit?.sha;
  return `${resource} head is ${COMMIT_SHA.test(String(commitSha ?? "")) ? `\`${commitSha}\`` : "unavailable"}`;
}

async function rereadPushedRepairState(github, target) {
  const [pull, branch] = await Promise.allSettled([
    github.getPull(target.number),
    github.getBranch(target.headRef)
  ]);
  return `Direct GitHub re-read: ${remoteReadSummary(pull, "PR")}; ${remoteReadSummary(branch, "branch")}.`;
}

function postPushFailure(error, publication) {
  const failure = new Error(
    `The repair commit ${publication.commitSha} was pushed, but final GitHub reconciliation is incomplete: ${error.message}`,
    { cause: error }
  );
  failure.code = "CODEKEEPER_PR_REPAIR_RECONCILIATION_INCOMPLETE";
  return failure;
}

async function publishFailureComment(github, context, target, error, automationIdentity, publication) {
  const reason = sanitizeMarkdown(String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 2000));
  const body = publication.remoteState
    ? `The repair commit \`${publication.commitSha}\` was pushed, but final GitHub reconciliation is incomplete. ${reason} ${publication.remoteState}`
    : `Codekeeper did not update this pull request. ${reason}`;
  await github.upsertMarkerComment(
    target.number,
    fixRunMarker(context.runId),
    body,
    automationIdentity
  );
}

const defaultGitOperations = Object.freeze({
  configureAutomationIdentity,
  createCommitOnCurrentHead,
  pushHeadToBranch
});

export async function publishPullRequestRepair({
  github,
  artifactDirectory,
  manifest,
  context,
  result,
  config,
  automationIdentity,
  resumePaused = false,
  dryRun = false,
  gitOperations = defaultGitOperations
}) {
  const target = frozenPullRepairTarget(context, config);
  const evidencePolicy = repairEvidencePolicy(context, config);
  const publication = {
    phase: REPAIR_PUBLICATION_PHASE.PREPARED,
    commitSha: null,
    remoteState: null
  };
  const pull = await github.beginPullRepairMutation({
    repository: context.repository,
    target,
    policy: config,
    repairEvidencePolicy: evidencePolicy,
    rejectPaused: !resumePaused,
    allowPausedResume: resumePaused,
  });
  if (resumePaused) await resumeDirectOwnerFix(github, context);
  if (!String(context.runId ?? "").trim()) throw new Error("Frozen PR repair context is missing its workflow run ID");
  try {
    if (!manifest.patch?.valid || !manifest.patch.fileName) {
      const reason = result.noChangeReason || manifest.patch?.reasons?.join("; ") || "No valid patch was produced";
      if (!dryRun) {
        await github.upsertMarkerComment(
          target.number,
          fixRunMarker(context.runId),
          `Codekeeper made no changes to this pull request. ${sanitizeMarkdown(reason)}`,
          automationIdentity
        );
      }
      return { updated: false, pullRequest: target.number, reason, dryRun };
    }

    const patch = await exactPatch({ artifactDirectory, manifest, context, config });
    if (dryRun) {
      return { updated: false, pullRequest: target.number, dryRun: true, branch: target.headRef, files: patch.files };
    }

    gitOperations.configureAutomationIdentity(automationIdentity);
    const commitSha = gitOperations.createCommitOnCurrentHead({
      expectedParent: target.headSha,
      message: "fix: apply owner-requested pull request repair",
      paths: patch.stagePaths
    });
    publication.commitSha = commitSha;
    publication.phase = REPAIR_PUBLICATION_PHASE.COMMIT_CREATED;
    publication.phase = REPAIR_PUBLICATION_PHASE.PUSH_ATTEMPTED;
    await github.mutatePullHeadIfCurrent(commitSha, () =>
      gitOperations.pushHeadToBranch(target.headRef, github.token)
    );
    publication.phase = REPAIR_PUBLICATION_PHASE.PUSH_CONFIRMED;
    const updatedPull = assertLivePullRepairTarget(
      await github.getPull(target.number, { expectedHeadSha: commitSha }),
      target,
      { expectedHeadSha: commitSha }
    );
    publication.phase = REPAIR_PUBLICATION_PHASE.PR_REVALIDATED;
    let resolvedReviewThreadIds = [];
    let reviewThreadWarning = null;
    try {
      for (const threadId of result.resolvedReviewThreadIds ?? []) {
        try {
          await github.resolveReviewThread(threadId);
        } catch (error) {
          if (!isAmbiguousGitHubMutationError(error)) throw error;
        }
      }
      if ((result.resolvedReviewThreadIds?.length ?? 0) > 0) {
        const threads = await github.listPullReviewThreads(target.number);
        const byId = new Map(threads.map((thread) => [thread.id, thread]));
        for (const threadId of result.resolvedReviewThreadIds) {
          if (byId.get(threadId)?.isResolved !== true) {
            throw new Error(`Review thread ${threadId} was not resolved after the verified fix was pushed`);
          }
        }
        resolvedReviewThreadIds = [...result.resolvedReviewThreadIds];
      }
    } catch (error) {
      reviewThreadWarning = `The repair commit was pushed, but review-thread reconciliation was incomplete: ${sanitizeMarkdown(error.message)}`;
    }
    publication.phase = REPAIR_PUBLICATION_PHASE.THREADS_RECONCILED;
    const appliedObjectives = Array.isArray(context.repairClusters)
      ? context.repairClusters.flatMap((cluster) => cluster.items ?? []).map((item) => item.title).filter(Boolean)
      : [];
    const appliedSummary = appliedObjectives.length > 0
      ? appliedObjectives.slice(0, 8).map((title) => `- ${sanitizeMarkdown(title)}`).join("\n")
      : (result.changedSummary ? sanitizeMarkdown(result.changedSummary).slice(0, 1500) : "See the repair commit.");
    await github.upsertMarkerComment(
      target.number,
      fixRunMarker(context.runId),
      `Codekeeper applied automatic repair \`${commitSha}\` on this pull request.\n\n${appliedSummary}`,
      automationIdentity
    );
    publication.phase = REPAIR_PUBLICATION_PHASE.COMPLETE;
    return {
      updated: true,
      pullRequest: target.number,
      url: updatedPull.html_url ?? pull.html_url,
      branch: target.headRef,
      previousHeadSha: target.headSha,
      headSha: commitSha,
      files: patch.files,
      resolvedReviewThreadIds,
      ...(reviewThreadWarning ? { reviewThreadWarning } : {}),
      dryRun: false
    };
  } catch (error) {
    let reportedError = error;
    if (!dryRun && error.code !== "CODEKEEPER_PAUSED") {
      try {
        if (publication.phase === REPAIR_PUBLICATION_PHASE.PUSH_CONFIRMED ||
            publication.phase === REPAIR_PUBLICATION_PHASE.PR_REVALIDATED) {
          publication.remoteState = await rereadPushedRepairState(github, target);
          reportedError = postPushFailure(error, publication);
        }
        await publishFailureComment(github, context, target, error, automationIdentity, publication);
      } catch (commentError) {
        throw new Error(`${reportedError.message}; failure comment could not be published: ${commentError.message}`, { cause: reportedError });
      }
    }
    throw reportedError;
  }
}
