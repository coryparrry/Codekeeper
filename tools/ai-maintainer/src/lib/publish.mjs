import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatch, collectWorkingTreeChanges, configureAutomationIdentity, createBranchAndCommit, createPatch, currentHead, ensureClean, pushBranch } from "./git.mjs";
import { GitHubClient, isOwnedMarkerComment } from "./github.mjs";
import { readJson, log, warn } from "./io.mjs";
import { ISSUE_TRIAGE_MARKER, REVIEW_MARKER, findingFingerprint, findingMarker, sha256 } from "./markers.mjs";
import { evaluateAutoMerge, findingLabels, issueTypeLabel, reviewLabels, validatePatch } from "./policy.mjs";
import { renderIssueTriage, renderMaintenanceIssue, renderRepairPullRequest, renderReviewComment, sanitizeMarkdown } from "./render.mjs";

function singleLine(value, maximum = 256) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maximum);
}

async function loadArtifact(artifactDirectory, expectedMode, configSha256) {
  const [manifest, context, result] = await Promise.all([
    readJson(path.join(artifactDirectory, "manifest.json")),
    readJson(path.join(artifactDirectory, "context.json")),
    readJson(path.join(artifactDirectory, "result.json"))
  ]);
  if (manifest.version !== 1) throw new Error("Unsupported artifact manifest version");
  if (manifest.sealed !== true) throw new Error("Only sealed artifacts may be published");
  if (!/^[a-f0-9]{64}$/i.test(String(configSha256 ?? ""))) {
    throw new Error("Publisher requires the SHA-256 of its frozen configuration");
  }
  if (manifest.configSha256 !== configSha256 || context.configSha256 !== configSha256) {
    throw new Error("Artifact configuration does not match the publisher's frozen configuration");
  }
  if (manifest.mode !== expectedMode || context.mode !== expectedMode || result.mode !== expectedMode) {
    throw new Error(`Artifact mode mismatch; expected ${expectedMode}`);
  }
  if (manifest.repository !== context.repository) throw new Error("Artifact repository fields do not match");
  if (JSON.stringify(manifest.context) !== JSON.stringify(context)) {
    throw new Error("Artifact context does not match its trusted manifest");
  }
  if (process.env.GITHUB_REPOSITORY && context.repository !== process.env.GITHUB_REPOSITORY) {
    throw new Error(`Artifact targets ${context.repository}; workflow repository is ${process.env.GITHUB_REPOSITORY}`);
  }
  return { manifest, context, result };
}

function managedIssueLabels(config) {
  return config.issues.managedLabels;
}

function branchSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 240);
}

export async function reconcileAutoMerge(github, pullRequest, config, decision) {
  if (decision.eligible) {
    try {
      await github.enableAutoMerge(pullRequest.node_id, config.merge.method);
      return { enabled: true, disabled: false, reason: "enabled" };
    } catch (error) {
      warn(`Could not enable auto-merge for PR #${pullRequest.number}: ${error.message}`);
      return { enabled: false, disabled: false, reason: error.message };
    }
  }

  if (pullRequest.auto_merge) {
    try {
      await github.disableAutoMerge(pullRequest.node_id);
      return { enabled: false, disabled: true, reason: decision.reasons.join("; ") || "policy no longer permits auto-merge" };
    } catch (error) {
      throw new Error(`Could not disable stale auto-merge for PR #${pullRequest.number}: ${error.message}`, { cause: error });
    }
  }

  return { enabled: false, disabled: false, reason: decision.reasons.join("; ") };
}

async function currentReviewPull(github, context, config) {
  const pull = await github.getPull(context.pullRequest.number);
  if (pull.state !== "open") throw new Error(`PR #${pull.number} is not open`);
  if (pull.head.sha !== context.pullRequest.headSha) {
    throw new Error(`PR #${pull.number} moved from ${context.pullRequest.headSha} to ${pull.head.sha}; stale review will not publish`);
  }
  if (pull.base.sha !== context.pullRequest.baseSha) {
    throw new Error(`PR #${pull.number} base moved from ${context.pullRequest.baseSha} to ${pull.base.sha}; stale review will not publish`);
  }
  if (pull.base.ref !== config.repository.defaultBranch) {
    throw new Error(`PR #${pull.number} base branch changed from ${config.repository.defaultBranch} to ${pull.base.ref}; stale review will not publish`);
  }
  if (pull.head.repo?.full_name !== context.repository || pull.base.repo?.full_name !== context.repository) {
    throw new Error(`PR #${pull.number} repository changed; stale review will not publish`);
  }
  return pull;
}

export async function publishReview({ artifactDirectory, config, configSha256, token, dryRun = false }) {
  const { context, result } = await loadArtifact(artifactDirectory, "review", configSha256);
  const github = new GitHubClient({ token, repository: context.repository });
  const pull = await currentReviewPull(github, context, config);
  const files = await github.listPullFiles(pull.number, config.merge.maximumFiles + 1);
  const automationBotLogin = String(process.env.AI_MAINTAINER_AUTOMATION_BOT_LOGIN ?? "").trim().toLowerCase();
  const autoMerge = evaluateAutoMerge({ config, pullRequest: pull, files, reviewResult: result, automationBotLogin });
  const desiredSet = new Set(reviewLabels(result));
  desiredSet.delete("ai-maintainer:auto-merge");
  desiredSet.delete("ai-maintainer:manual-review");
  const critical = [...result.blockingFindings, ...result.nonBlockingFindings].some((finding) => finding.severity === "critical");
  if (result.blockingFindings.length > 0 || critical || result.mergeRecommendation === "block") {
    desiredSet.add("ai-maintainer:blocked");
  } else if (autoMerge.eligible) {
    desiredSet.add("ai-maintainer:auto-merge");
  } else {
    desiredSet.add("ai-maintainer:manual-review");
  }
  const desiredLabels = [...desiredSet];
  const comment = renderReviewComment(result, autoMerge);
  const blocking = result.blockingFindings.length > 0 || critical || result.mergeRecommendation === "block";

  if (dryRun) {
    log(`DRY RUN review PR #${pull.number}`, { desiredLabels, autoMerge, comment, blocking });
    return { pullRequest: pull.number, desiredLabels, autoMerge, blocking, dryRun: true };
  }

  const automationIdentity = expectedAutomationIdentity();
  await currentReviewPull(github, context, config);
  await github.ensureLabels(config.labels, desiredLabels);
  await currentReviewPull(github, context, config);
  await github.replaceManagedLabels(pull.number, desiredLabels, config.review.managedLabels);
  await currentReviewPull(github, context, config);
  await github.upsertMarkerComment(
    pull.number,
    REVIEW_MARKER,
    comment,
    automationIdentity
  );

  const currentPull = await currentReviewPull(github, context, config);
  const currentAutoMerge = evaluateAutoMerge({ config, pullRequest: currentPull, files, reviewResult: result, automationBotLogin: automationIdentity.login });
  const autoMergeResult = await reconcileAutoMerge(github, currentPull, config, currentAutoMerge);
  return { pullRequest: pull.number, desiredLabels, autoMerge: currentAutoMerge, autoMergeResult, blocking };
}

export async function publishIssue({ artifactDirectory, config, configSha256, token, dryRun = false }) {
  const { context, result } = await loadArtifact(artifactDirectory, "issue", configSha256);
  const github = new GitHubClient({ token, repository: context.repository });
  const issue = await github.getIssue(context.issue.number);
  if (issue.pull_request) throw new Error(`#${issue.number} is now a pull request`);
  if (issue.state !== "open") throw new Error(`#${issue.number} is not open`);
  if (context.issue.updatedAt && issue.updated_at !== context.issue.updatedAt) {
    throw new Error(`#${issue.number} changed after analysis; stale triage will not publish`);
  }

  const desired = new Set([issueTypeLabel(result.type), `ai-maintainer:priority-${result.priority}`, ...result.labels]);
  if (result.implementationRecommendation === "ai-ready") desired.add("ai-maintainer:ready");
  if (result.duplicateOf && result.duplicateConfidence === "high") desired.add("ai-maintainer:duplicate-candidate");
  const desiredLabels = [...desired];
  const comment = renderIssueTriage(result);

  if (dryRun) {
    log(`DRY RUN issue triage #${issue.number}`, { desiredLabels, comment });
    return { issue: issue.number, desiredLabels, dryRun: true };
  }

  await github.ensureLabels(config.labels, desiredLabels);
  await github.replaceManagedLabels(issue.number, desiredLabels, managedIssueLabels(config));
  await github.upsertMarkerComment(
    issue.number,
    ISSUE_TRIAGE_MARKER,
    comment,
    expectedAutomationIdentity()
  );

  if (result.duplicateOf === issue.number) {
    throw new Error(`Issue #${issue.number} cannot be its own duplicate`);
  }
  if (config.issues.closeExactDuplicates && result.duplicateOf && result.duplicateConfidence === "high") {
    const duplicate = await github.getIssue(result.duplicateOf);
    if (!duplicate.pull_request && duplicate.state === "open") {
      await github.createComment(issue.number, `Closing as a duplicate of #${duplicate.number}.`);
      await github.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
    }
  }
  return { issue: issue.number, desiredLabels };
}

function matchesAutomationActor(actor, identity) {
  return Boolean(
    actor?.type === "Bot" &&
    String(actor.login ?? "").trim().toLowerCase() === identity.login &&
    String(actor.id ?? "") === identity.id
  );
}

export function isTrustedMaintenanceIssue(issue, comments, { marker, botLogin, botId }) {
  const identity = normalizeAutomationIdentity({ login: botLogin, id: botId });
  return Boolean(
    identity &&
    typeof issue?.body === "string" &&
    issue.body.endsWith(marker) &&
    Array.isArray(comments) &&
    comments.some((comment) => isOwnedMarkerComment(comment, marker, identity))
  );
}

async function upsertMaintenanceFindings({ github, findings, config, runUrl, dryRun }) {
  const automationIdentity = expectedAutomationIdentity();
  const existing = await github.listMaintenanceIssues("ai-maintainer:maintenance");
  const published = [];
  for (const finding of findings.slice(0, config.audit.maximumIssuesPerRun)) {
    const fingerprint = findingFingerprint(finding);
    const marker = findingMarker(fingerprint);
    let match;
    for (const issue of existing) {
      if (typeof issue?.body !== "string" || !issue.body.endsWith(marker)) continue;
      const comments = await github.listIssueComments(issue.number);
      if (isTrustedMaintenanceIssue(issue, comments, {
        marker,
        botLogin: automationIdentity.login,
        botId: automationIdentity.id
      })) {
        match = issue;
        break;
      }
    }
    const labels = [...new Set([...findingLabels(finding), `ai-maintainer:priority-${finding.priority}`])];
    const title = singleLine(`[AI maintenance] ${finding.title}`) || "[AI maintenance] Repository finding";
    const body = renderMaintenanceIssue(finding, fingerprint, runUrl);

    if (match?.state === "closed") {
      published.push({ fingerprint, state: "acknowledged", issueNumber: match.number });
      continue;
    }
    if (dryRun) {
      published.push({ fingerprint, state: match ? "would-update" : "would-create", issueNumber: match?.number ?? null });
      continue;
    }
    await github.ensureLabels(config.labels, labels);
    if (match) {
      await github.updateIssue(match.number, { title, body });
      await github.replaceManagedLabels(match.number, labels, managedIssueLabels(config));
      published.push({ fingerprint, state: "updated", issueNumber: match.number });
    } else {
      const created = await github.createIssue({ title, body, labels });
      await github.createComment(created.number, marker);
      published.push({ fingerprint, state: "created", issueNumber: created.number });
      existing.push(created);
    }
  }
  return published;
}

function normalizeAutomationIdentity({ login, id }) {
  const normalizedLogin = String(login ?? "").trim().toLowerCase();
  const normalizedId = String(id ?? "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\[bot\]$/.test(normalizedLogin) || !/^[1-9]\d*$/.test(normalizedId)) {
    return null;
  }
  return { login: normalizedLogin, id: normalizedId };
}

function expectedAutomationIdentity() {
  const login = process.env.AI_MAINTAINER_AUTOMATION_BOT_LOGIN;
  const id = process.env.AI_MAINTAINER_AUTOMATION_BOT_ID;
  const identity = normalizeAutomationIdentity({ login, id });
  if (!identity) {
    throw new Error("AI_MAINTAINER_AUTOMATION_BOT_LOGIN and AI_MAINTAINER_AUTOMATION_BOT_ID must identify the configured GitHub App bot");
  }
  return identity;
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

async function publishPatchPullRequest({
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

  const existing = await findOpenRepairPull(github, fingerprint, config, context.mode);
  if (existing) return { created: false, reason: "Existing repair PR", pullRequest: existing.number, url: existing.html_url };

  if (currentHead() !== context.baseSha) {
    return { created: false, reason: `Default branch moved from ${context.baseSha} to ${currentHead()}` };
  }
  ensureClean();
  const patchPath = path.join(artifactDirectory, manifest.patch.fileName);
  const patchBytes = await readFile(patchPath);
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
  const freshPatchDirectory = await mkdtemp(path.join(os.tmpdir(), "ai-maintainer-publish-patch-"));
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
  const normalizedTitle = singleLine(title, 200) || "chore: apply bounded maintenance repair";
  const draft = !readyForReview || risk !== "low";
  const validationSummary = [
    ...(manifest.validation?.commands ?? []).map((item) => `- \`${item.command}\`: ${item.success ? "passed" : "failed"}`),
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
  pushBranch(branch, github.token);
  let pull;
  try {
    pull = await github.createPull({
      title: normalizedTitle,
      body: prBody,
      head: branch,
      base: context.defaultBranch ?? config.repository.defaultBranch,
      draft
    });
  } catch (error) {
    try {
      const existingPull = await github.findOpenPullByHead(branch);
      if (!existingPull) await github.deleteBranch(branch);
    } catch (cleanupError) {
      warn(`Could not remove orphaned automation branch ${branch}: ${cleanupError.message}`);
    }
    throw error;
  }
  const labels = new Set(["ai-maintainer:maintenance", `ai-maintainer:risk-${risk}`, "ai-maintainer:manual-review"]);
  if (finding) findingLabels(finding).forEach((label) => labels.add(label));
  await github.ensureLabels(config.labels, [...labels]);
  await github.replaceManagedLabels(pull.number, [...labels], managedIssueLabels(config));
  return {
    created: true,
    pullRequest: pull.number,
    url: pull.html_url,
    branch,
    draft,
    awaitingReview: true,
    reason: "Auto-merge is evaluated only after the current-head AI maintainer review publishes"
  };
}

export async function publishAudit({ artifactDirectory, config, configSha256, token, dryRun = false }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "audit", configSha256);
  const liveHead = currentHead();
  if (liveHead !== context.baseSha) {
    throw new Error(`Default branch moved from ${context.baseSha} to ${liveHead}; stale audit will not publish`);
  }
  const github = new GitHubClient({ token, repository: context.repository });
  const findings = await upsertMaintenanceFindings({
    github,
    findings: result.findings,
    config,
    runUrl: context.runUrl,
    dryRun
  });

  let repair = { created: false, reason: "No repair requested" };
  if (result.repair.requested) {
    const finding = result.findings[result.repair.findingIndex];
    const fingerprint = findingFingerprint(finding);
    const publishedFinding = findings.find((item) => item.fingerprint === fingerprint);
    repair = await publishPatchPullRequest({
      github,
      artifactDirectory,
      manifest,
      context,
      config,
      title: result.repair.title,
      summary: result.summary,
      body: result.repair.body,
      risk: result.repair.risk,
      readyForReview: result.repair.risk === "low",
      fingerprint,
      issueNumber: publishedFinding?.issueNumber ?? null,
      finding,
      dryRun
    });
    if (!dryRun && publishedFinding?.issueNumber && repair.url) {
      await github.createComment(publishedFinding.issueNumber, `A repair pull request was opened: ${repair.url}`);
    }
  }
  return { findings, repair, dryRun };
}

export async function publishFix({ artifactDirectory, config, configSha256, token, dryRun = false }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "fix", configSha256);
  const github = new GitHubClient({ token, repository: context.repository });
  const issue = await github.getIssue(context.issue.number);
  if (issue.state !== "open" || issue.pull_request) throw new Error(`Issue #${issue.number} is no longer eligible`);
  if (context.issue.updatedAt && issue.updated_at !== context.issue.updatedAt) {
    throw new Error(`Issue #${issue.number} changed after implementation started; stale patch will not publish`);
  }

  if (!manifest.patch?.valid) {
    const reason = result.noChangeReason || manifest.patch?.reasons?.join("; ") || "No valid patch was produced";
    if (!dryRun) {
      await github.createComment(issue.number, `AI maintainer did not open a PR. ${sanitizeMarkdown(reason)}\n<!-- ai-maintainer:fix-run=${context.runId} -->`);
    }
    return { created: false, reason, dryRun };
  }

  const fingerprint = sha256(`issue|${context.repository}|${issue.number}`);
  const repair = await publishPatchPullRequest({
    github,
    artifactDirectory,
    manifest,
    context,
    config,
    title: `fix: ${issue.title}`,
    summary: result.summary,
    body: result.changedSummary,
    risk: result.risk,
    readyForReview: result.readyForReview,
    fingerprint,
    issueNumber: issue.number,
    finding: null,
    dryRun
  });
  if (!dryRun && repair.url) {
    await github.createComment(issue.number, `AI maintainer opened a repair pull request: ${repair.url}`);
  }
  return repair;
}
