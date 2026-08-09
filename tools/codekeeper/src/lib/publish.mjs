import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyPatch, collectWorkingTreeChanges, configureAutomationIdentity, createBranchAndCommit, createPatch, currentHead, ensureClean, gitText, pushBranch } from "./git.mjs";
import { GitHubClient, isOwnedMarkerComment } from "./github.mjs";
import { readRegularFile, log, warn } from "./io.mjs";
import { ISSUE_TRIAGE_MARKER, REVIEW_MARKER, findingFingerprint, findingMarker, sha256 } from "./markers.mjs";
import { evaluateAutoMerge, findingLabels, issueTypeLabel, reviewLabels, validatePatch } from "./policy.mjs";
import { renderIssueTriage, renderMaintenanceIssue, renderRepairPullRequest, renderReviewComment, sanitizeMarkdown } from "./render.mjs";
import { validateAuditResult, validateFixResult, validateIssueResult, validateReviewResult } from "./schemas.mjs";

function singleLine(value, maximum = 256) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maximum);
}

function parseArtifactJson(bytes, name) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in sealed artifact ${name}: ${error.message}`);
  }
}

function validateArtifactResult(mode, result, context, config) {
  if (mode === "review") return validateReviewResult(result, config);
  if (mode === "audit") return validateAuditResult(result, config);
  if (mode === "issue") return validateIssueResult(result, config);
  if (mode === "fix") return validateFixResult(result, context.issue?.number);
  throw new Error(`Unsupported artifact mode: ${mode}`);
}

async function loadArtifact(artifactDirectory, expectedMode, config, configSha256, expectedManifestSha256) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedManifestSha256 ?? ""))) {
    throw new Error("Publisher requires the trusted sealed manifest SHA-256");
  }
  const manifestBytes = await readRegularFile(path.join(artifactDirectory, "manifest.json"));
  if (sha256(manifestBytes) !== expectedManifestSha256) {
    throw new Error("Sealed artifact manifest changed after sealing");
  }
  const manifest = parseArtifactJson(manifestBytes, "manifest.json");
  if (manifest.version !== 2) throw new Error("Unsupported artifact manifest version");
  if (manifest.sealed !== true) throw new Error("Only sealed artifacts may be published");
  if (!/^[a-f0-9]{64}$/i.test(String(configSha256 ?? ""))) {
    throw new Error("Publisher requires the SHA-256 of its frozen configuration");
  }

  const [contextBytes, resultBytes, configBytes, validationBytes] = await Promise.all([
    readRegularFile(path.join(artifactDirectory, "context.json")),
    readRegularFile(path.join(artifactDirectory, "result.json")),
    readRegularFile(path.join(artifactDirectory, "config.json")),
    readRegularFile(path.join(artifactDirectory, "validation.json"))
  ]);
  if (
    sha256(contextBytes) !== manifest.contextSha256 ||
    sha256(resultBytes) !== manifest.resultSha256 ||
    sha256(configBytes) !== manifest.configFileSha256 ||
    sha256(validationBytes) !== manifest.validationSha256
  ) {
    throw new Error("Sealed artifact component changed after sealing");
  }

  const context = parseArtifactJson(contextBytes, "context.json");
  const result = parseArtifactJson(resultBytes, "result.json");
  const artifactConfig = parseArtifactJson(configBytes, "config.json");
  const validation = parseArtifactJson(validationBytes, "validation.json");
  if (manifest.configSha256 !== configSha256 || context.configSha256 !== configSha256) {
    throw new Error("Artifact configuration does not match the publisher's frozen configuration");
  }
  if (JSON.stringify(artifactConfig) !== JSON.stringify(config)) {
    throw new Error("Sealed artifact configuration differs from the trusted publisher configuration");
  }
  if (manifest.mode !== expectedMode || context.mode !== expectedMode || result.mode !== expectedMode) {
    throw new Error(`Artifact mode mismatch; expected ${expectedMode}`);
  }
  if (manifest.repository !== context.repository) throw new Error("Artifact repository fields do not match");
  if (JSON.stringify(manifest.context) !== JSON.stringify(context)) {
    throw new Error("Artifact context does not match its trusted manifest");
  }
  if (JSON.stringify(manifest.validation) !== JSON.stringify(validation)) {
    throw new Error("Artifact validation does not match its trusted manifest");
  }
  if (manifest.patch?.valid) {
    const patchBytes = await readRegularFile(path.join(artifactDirectory, "patch.diff"));
    if (sha256(patchBytes) !== manifest.patchSha256 || sha256(patchBytes) !== manifest.patch.sha256) {
      throw new Error("Sealed artifact patch changed after sealing");
    }
  } else if (manifest.patchSha256 !== null) {
    throw new Error("Sealed artifact contains an unexpected patch hash");
  }
  validateArtifactResult(expectedMode, result, context, config);
  if (process.env.GITHUB_REPOSITORY && context.repository !== process.env.GITHUB_REPOSITORY) {
    throw new Error(`Artifact targets ${context.repository}; workflow repository is ${process.env.GITHUB_REPOSITORY}`);
  }
  return { manifest, context, result };
}

function managedIssueLabels(config) {
  return config.issues.managedLabels;
}

async function currentOpenIssue(github, frozenIssue, staleAction) {
  const issue = await github.getIssue(frozenIssue.number);
  if (issue.pull_request) throw new Error(`Issue #${issue.number} is no longer eligible`);
  if (issue.state !== "open") throw new Error(`Issue #${issue.number} is not open`);
  if (frozenIssue.updatedAt && issue.updated_at !== frozenIssue.updatedAt) {
    throw new Error(`Issue #${issue.number} changed after ${staleAction}; stale action will not publish`);
  }
  return issue;
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

export async function publishReview({ artifactDirectory, config, configSha256, expectedManifestSha256, token, dryRun = false }) {
  const { context, result } = await loadArtifact(artifactDirectory, "review", config, configSha256, expectedManifestSha256);
  const github = new GitHubClient({ token, repository: context.repository });
  const pull = await currentReviewPull(github, context, config);
  const files = await github.listPullFiles(pull.number, config.merge.maximumFiles + 1);
  const automationBotLogin = String(process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN ?? "").trim().toLowerCase();
  const reviewContextComplete = context.pullRequest?.diff?.truncated === false && context.pullRequest.diff.disabled !== true;
  const autoMerge = evaluateAutoMerge({ config, pullRequest: pull, files, reviewResult: result, reviewContextComplete, automationBotLogin });
  const desiredSet = new Set(reviewLabels(result));
  desiredSet.delete("codekeeper:auto-merge");
  desiredSet.delete("codekeeper:manual-review");
  const critical = [...result.blockingFindings, ...result.nonBlockingFindings].some((finding) => finding.severity === "critical");
  if (result.blockingFindings.length > 0 || critical || result.mergeRecommendation === "block") {
    desiredSet.add("codekeeper:blocked");
  } else if (autoMerge.eligible) {
    desiredSet.add("codekeeper:auto-merge");
  } else {
    desiredSet.add("codekeeper:manual-review");
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
  const currentAutoMerge = evaluateAutoMerge({ config, pullRequest: currentPull, files, reviewResult: result, reviewContextComplete, automationBotLogin: automationIdentity.login });
  const autoMergeResult = await reconcileAutoMerge(github, currentPull, config, currentAutoMerge);
  return { pullRequest: pull.number, desiredLabels, autoMerge: currentAutoMerge, autoMergeResult, blocking };
}

export async function publishIssue({ artifactDirectory, config, configSha256, expectedManifestSha256, token, dryRun = false }) {
  const { context, result } = await loadArtifact(artifactDirectory, "issue", config, configSha256, expectedManifestSha256);
  const github = new GitHubClient({ token, repository: context.repository });
  const currentIssue = () => currentOpenIssue(github, context.issue, "analysis");
  const issue = await currentIssue();

  const desired = new Set([issueTypeLabel(result.type), `codekeeper:priority-${result.priority}`, ...result.labels]);
  if (result.implementationRecommendation === "ai-ready") desired.add("codekeeper:ready");
  if (result.duplicateOf && result.duplicateConfidence === "high") desired.add("codekeeper:duplicate-candidate");
  const desiredLabels = [...desired];
  const comment = renderIssueTriage(result);

  if (dryRun) {
    log(`DRY RUN issue triage #${issue.number}`, { desiredLabels, comment });
    return { issue: issue.number, desiredLabels, dryRun: true };
  }

  // GitHub does not expose an atomic compare-and-mutate for issue updates. These
  // checks fail closed on observed drift immediately before each mutation boundary.
  await currentIssue();
  await github.ensureLabels(config.labels, desiredLabels);
  await currentIssue();
  await github.replaceManagedLabels(issue.number, desiredLabels, managedIssueLabels(config));
  await currentIssue();
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
    const duplicateContext = { number: result.duplicateOf };
    await currentIssue();
    const duplicate = await currentOpenIssue(github, duplicateContext, "duplicate assessment");
    await github.createComment(issue.number, `Closing as a duplicate of #${duplicate.number}.`);
    await currentIssue();
    await currentOpenIssue(github, duplicateContext, "duplicate assessment");
    await github.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
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
    matchesAutomationActor(issue?.user, identity) &&
    typeof issue?.body === "string" &&
    issue.body.endsWith(marker) &&
    Array.isArray(comments) &&
    comments.some((comment) => isOwnedMarkerComment(comment, marker, identity))
  );
}

async function upsertMaintenanceFindings({ github, findings, config, runUrl, dryRun }) {
  const automationIdentity = expectedAutomationIdentity();
  const existing = await github.listMaintenanceIssues("codekeeper:maintenance");
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
    const labels = [...new Set([...findingLabels(finding), `codekeeper:priority-${finding.priority}`])];
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
  const login = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  const id = process.env.CODEKEEPER_AUTOMATION_BOT_ID;
  const identity = normalizeAutomationIdentity({ login, id });
  if (!identity) {
    throw new Error("CODEKEEPER_AUTOMATION_BOT_LOGIN and CODEKEEPER_AUTOMATION_BOT_ID must identify the configured GitHub App bot");
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
    typeof pull?.body === "string" &&
    pull.body.endsWith(`<!-- codekeeper:repair=${fingerprint} -->`) &&
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
  revalidateBeforeMutation = null,
  dryRun = false
}) {
  if (!manifest.patch?.valid || !manifest.patch.fileName) {
    return { created: false, reason: manifest.patch?.reasons?.join("; ") || "No validated patch" };
  }

  const labels = new Set(["codekeeper:maintenance", `codekeeper:risk-${risk}`, "codekeeper:manual-review"]);
  if (finding) findingLabels(finding).forEach((label) => labels.add(label));
  const existing = await findOpenRepairPull(github, fingerprint, config, context.mode);
  if (existing) {
    if (!dryRun) {
      if (revalidateBeforeMutation) await revalidateBeforeMutation();
      await github.ensureLabels(config.labels, [...labels]);
      if (revalidateBeforeMutation) await revalidateBeforeMutation();
      await github.replaceManagedLabels(existing.number, [...labels], managedIssueLabels(config));
    }
    return { created: false, reason: "Existing repair PR", pullRequest: existing.number, url: existing.html_url };
  }

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
  if (revalidateBeforeMutation) await revalidateBeforeMutation();
  let remote;
  try {
    remote = (await github.request("GET", github.repoPath(`/branches/${encodeURIComponent(branch)}`))).data;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (remote) {
    if (
      remote.commit?.commit?.tree?.sha !== gitText(["rev-parse", "HEAD^{tree}"]) ||
      remote.commit?.parents?.length !== 1 ||
      remote.commit.parents[0]?.sha !== context.baseSha
    ) {
      throw new Error(`Automation branch ${branch} already exists with unexpected content`);
    }
  } else {
    pushBranch(branch, github.token);
  }
  let pull;
  try {
    if (revalidateBeforeMutation) await revalidateBeforeMutation();
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
  if (revalidateBeforeMutation) await revalidateBeforeMutation();
  await github.ensureLabels(config.labels, [...labels]);
  if (revalidateBeforeMutation) await revalidateBeforeMutation();
  await github.replaceManagedLabels(pull.number, [...labels], managedIssueLabels(config));
  return {
    created: true,
    pullRequest: pull.number,
    url: pull.html_url,
    branch,
    draft,
    awaitingReview: true,
    reason: "Auto-merge is evaluated only after the current-head Codekeeper review publishes"
  };
}

export async function publishAudit({ artifactDirectory, config, configSha256, expectedManifestSha256, token, dryRun = false }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "audit", config, configSha256, expectedManifestSha256);
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
      await github.upsertMarkerComment(
        publishedFinding.issueNumber,
        `<!-- codekeeper:repair-notification=${fingerprint} -->`,
        `A repair pull request was opened: ${repair.url}`,
        expectedAutomationIdentity()
      );
    }
  }
  return { findings, repair, dryRun };
}

export async function publishFix({ artifactDirectory, config, configSha256, expectedManifestSha256, token, dryRun = false }) {
  const { manifest, context, result } = await loadArtifact(artifactDirectory, "fix", config, configSha256, expectedManifestSha256);
  const github = new GitHubClient({ token, repository: context.repository });
  const currentIssue = () => currentOpenIssue(github, context.issue, "implementation started");
  const issue = await currentIssue();

  if (!manifest.patch?.valid) {
    const reason = result.noChangeReason || manifest.patch?.reasons?.join("; ") || "No valid patch was produced";
    if (!dryRun) {
      await currentIssue();
      await github.createComment(issue.number, `Codekeeper did not open a PR. ${sanitizeMarkdown(reason)}\n<!-- codekeeper:fix-run=${context.runId} -->`);
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
    revalidateBeforeMutation: currentIssue,
    dryRun
  });
  if (!dryRun && repair.url) {
    await currentIssue();
    await github.createComment(issue.number, `Codekeeper opened a repair pull request: ${repair.url}`);
  }
  return repair;
}
