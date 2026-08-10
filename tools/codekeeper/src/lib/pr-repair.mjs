import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyPatch,
  collectWorkingTreeChanges,
  configureAutomationIdentity,
  createCommitOnCurrentHead,
  createPatch,
  currentHead,
  ensureClean,
  pushHeadToBranch
} from "./git.mjs";
import { readRegularFile } from "./io.mjs";
import { fixRunMarker, sha256 } from "./markers.mjs";
import { validatePatch } from "./policy.mjs";
import { sanitizeMarkdown } from "./render.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

function boundedText(value, maximum, suffix = "\n…[truncated]") {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

export function frozenPullRepairSubject(pull, comments) {
  return {
    number: pull?.number,
    title: boundedText(pull?.title, 512, "…"),
    body: boundedText(pull?.body, 30000),
    author: boundedText(pull?.user?.login, 256, "…"),
    url: boundedText(pull?.html_url, 2048, "…"),
    comments: Array.isArray(comments)
      ? comments.slice(-20).map((comment) => ({
        author: boundedText(comment?.user?.login, 256, "…"),
        body: boundedText(comment?.body, 12000),
        createdAt: comment?.created_at ?? ""
      }))
      : []
  };
}

export function frozenPullRepairSubjectSha256(pull, comments) {
  return sha256(JSON.stringify(frozenPullRepairSubject(pull, comments)));
}

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
    subjectSha256: requiredText(target.subjectSha256, "repair evidence SHA-256")
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

async function assertWritableFrozenBranch(github, target) {
  const branch = await github.getBranch(target.headRef);
  if (!branch) throw new Error(`PR #${target.number} head branch ${target.headRef} no longer exists`);
  if (branch.protected) throw new Error(`PR #${target.number} head branch ${target.headRef} is protected`);
  if (branch.commit?.sha !== target.headSha) {
    throw new Error(`PR #${target.number} head branch moved from ${target.headSha} to ${branch.commit?.sha ?? "missing"}`);
  }
  return branch;
}

function pullLabelNames(pull) {
  if (!Array.isArray(pull?.labels)) throw new Error(`PR #${pull?.number ?? "unknown"} has invalid label metadata`);
  const names = pull.labels.map((label) => typeof label === "string" ? label : label?.name);
  if (names.some((label) => typeof label !== "string" || label.length === 0) || new Set(names).size !== names.length) {
    throw new Error(`PR #${pull?.number ?? "unknown"} has invalid or duplicate label metadata`);
  }
  return names;
}

async function currentFrozenPull(github, target, { rejectPaused = false } = {}) {
  const pull = assertLivePullRepairTarget(await github.getPull(target.number), target);
  if (rejectPaused && pullLabelNames(pull).includes("codekeeper:paused")) {
    const error = new Error(`PR #${target.number} is paused; automatic publication stopped`);
    error.code = "CODEKEEPER_PAUSED";
    throw error;
  }
  const comments = await github.listIssueComments(target.number);
  if (frozenPullRepairSubjectSha256(pull, comments) !== target.subjectSha256) {
    throw new Error(`PR #${target.number} repair evidence changed after implementation started`);
  }
  await assertWritableFrozenBranch(github, target);
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

async function publishFailureComment(github, context, target, error, automationIdentity) {
  const reason = sanitizeMarkdown(String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 2000));
  await github.upsertMarkerComment(
    target.number,
    fixRunMarker(context.runId),
    `Codekeeper did not update this pull request. ${reason}`,
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
  dryRun = false,
  gitOperations = defaultGitOperations
}) {
  const target = frozenPullRepairTarget(context, config);
  const revalidationOptions = { rejectPaused: true };
  if (!String(context.runId ?? "").trim()) throw new Error("Frozen PR repair context is missing its workflow run ID");
  try {
    const pull = await currentFrozenPull(github, target, revalidationOptions);
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

    await currentFrozenPull(github, target, revalidationOptions);
    gitOperations.configureAutomationIdentity(automationIdentity);
    const commitSha = gitOperations.createCommitOnCurrentHead({
      expectedParent: target.headSha,
      message: "fix: apply owner-requested pull request repair",
      paths: patch.stagePaths
    });
    await currentFrozenPull(github, target, revalidationOptions);
    const pushedSha = gitOperations.pushHeadToBranch(target.headRef, github.token);
    if (pushedSha !== commitSha) throw new Error(`PR repair pushed ${pushedSha}; expected ${commitSha}`);
    const updatedPull = assertLivePullRepairTarget(await github.getPull(target.number), target, { expectedHeadSha: commitSha });
    return {
      updated: true,
      pullRequest: target.number,
      url: updatedPull.html_url ?? pull.html_url,
      branch: target.headRef,
      previousHeadSha: target.headSha,
      headSha: commitSha,
      files: patch.files,
      dryRun: false
    };
  } catch (error) {
    if (!dryRun && error.code !== "CODEKEEPER_PAUSED") {
      try {
        await publishFailureComment(github, context, target, error, automationIdentity);
      } catch (commentError) {
        throw new Error(`${error.message}; failure comment could not be published: ${commentError.message}`, { cause: error });
      }
    }
    throw error;
  }
}
