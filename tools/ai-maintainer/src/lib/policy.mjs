import { matchesAny } from "./glob.mjs";

function unsafeRepositoryPath(filePath) {
  const value = String(filePath ?? "").replaceAll("\\", "/");
  if (!value) return "path is empty";
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return "path is absolute";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "path contains control characters";
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "path contains an unsafe segment";
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return "path targets Git metadata";
  return null;
}

export function validatePatch(changes, config) {
  const repair = config.audit.repair;
  const reasons = [];
  if (changes.files.length > repair.maximumFiles) {
    reasons.push(`Patch changes ${changes.files.length} files; maximum is ${repair.maximumFiles}`);
  }
  if (changes.changedLines > repair.maximumChangedLines) {
    reasons.push(`Patch changes ${changes.changedLines} lines; maximum is ${repair.maximumChangedLines}`);
  }
  if (!Number.isSafeInteger(changes.patchBytes) || changes.patchBytes < 0) {
    reasons.push("Patch byte size is unavailable");
  } else if (changes.patchBytes > repair.maximumPatchBytes) {
    reasons.push(`Patch is ${changes.patchBytes} bytes; maximum is ${repair.maximumPatchBytes}`);
  }
  for (const file of changes.files) {
    const unsafePath = unsafeRepositoryPath(file.path);
    if (unsafePath) reasons.push(`${file.path}: ${unsafePath}`);
    if (file.binary) reasons.push(`${file.path} is binary`);
    if (file.symlink) reasons.push(`${file.path} is a symbolic link`);
    if (file.specialMode) reasons.push(`${file.path} is not a regular file`);
    if (file.modeChanged) reasons.push(`${file.path} changes file mode`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      reasons.push(`${file.path} byte size is unavailable`);
    } else if (file.bytes > repair.maximumFileBytes) {
      reasons.push(`${file.path} is ${file.bytes} bytes; maximum is ${repair.maximumFileBytes}`);
    }
    if (matchesAny(file.path, repair.protectedPaths)) reasons.push(`${file.path} is protected`);
    if (!matchesAny(file.path, repair.allowedPaths)) reasons.push(`${file.path} is outside repair allowlist`);
    if (file.status.startsWith("A") && !repair.allowAdd) reasons.push(`${file.path} adds a file but additions are disabled`);
    if (file.status.startsWith("D")) reasons.push(`${file.path} deletes a file`);
    if (file.status.startsWith("R") || file.status.startsWith("C")) reasons.push(`${file.path} renames or copies a file`);
    if (file.status.startsWith("A") && file.newMode === "100755") {
      reasons.push(`${file.path} adds an executable file`);
    }
  }
  return {
    valid: reasons.length === 0,
    reasons,
    files: changes.files.map((file) => file.path),
    additions: changes.additions,
    deletions: changes.deletions,
    changedLines: changes.changedLines
  };
}

function hasCriticalFinding(result) {
  return [...(result?.blockingFindings ?? []), ...(result?.nonBlockingFindings ?? [])]
    .some((finding) => finding?.severity === "critical");
}

export function reviewLabels(result) {
  const labels = new Set(["ai-maintainer:reviewed", `ai-maintainer:risk-${result.risk}`, ...result.labels]);
  if (!result.tests.adequate) labels.add("ai-maintainer:needs-tests");
  if (result.blockingFindings.length > 0 || hasCriticalFinding(result) || result.mergeRecommendation === "block") {
    labels.add("ai-maintainer:blocked");
  } else if (result.mergeRecommendation === "auto") {
    labels.add("ai-maintainer:auto-merge");
  } else {
    labels.add("ai-maintainer:manual-review");
  }
  return [...labels];
}

export function issueTypeLabel(type) {
  const map = {
    bug: "ai-maintainer:type-bug",
    enhancement: "ai-maintainer:type-enhancement",
    documentation: "ai-maintainer:type-documentation",
    question: "ai-maintainer:type-question",
    security: "ai-maintainer:type-security",
    maintenance: "ai-maintainer:type-maintenance"
  };
  return map[type] ?? "ai-maintainer:type-maintenance";
}

export function findingLabels(finding) {
  const categoryMap = {
    docs: "ai-maintainer:type-documentation",
    dependency: "ai-maintainer:type-maintenance",
    cleanup: "ai-maintainer:type-maintenance",
    bug: "ai-maintainer:type-bug",
    security: "ai-maintainer:type-security",
    testing: "ai-maintainer:type-testing"
  };
  return [...new Set(["ai-maintainer:maintenance", categoryMap[finding.category], ...finding.labels])];
}

export function evaluateAutoMerge({
  config,
  pullRequest,
  files,
  reviewResult = null,
  reviewContextComplete = false,
  automationBotLogin = process.env.AI_MAINTAINER_AUTOMATION_BOT_LOGIN ?? ""
}) {
  const policy = config.merge;
  const reasons = [];
  if (!policy.enabled) reasons.push("Auto-merge is disabled by policy");
  if (pullRequest.draft) reasons.push("Pull request is a draft");
  if (pullRequest.state !== "open") reasons.push(`Pull request state is ${pullRequest.state}`);
  if (pullRequest.head?.repo?.full_name !== pullRequest.base?.repo?.full_name) reasons.push("Pull request comes from a fork");

  const automationBranch = String(pullRequest.head?.ref ?? "").startsWith(config.repository.automationBranchPrefix);
  const pullAuthor = pullRequest.user?.login ?? "";
  const automationAuthor = pullRequest.user?.type === "Bot" && pullAuthor.endsWith("[bot]");
  const configuredAutomationAuthor = String(automationBotLogin).trim().toLowerCase();
  const userAuthor = config.merge.allowedUserAuthors.includes(pullAuthor);
  if (automationBranch) {
    if (!automationAuthor) reasons.push("Automation branch was not opened by a GitHub App bot");
    if (!configuredAutomationAuthor) {
      reasons.push("Configured automation bot login is unavailable");
    } else if (pullAuthor.toLowerCase() !== configuredAutomationAuthor) {
      reasons.push(`Automation pull request author ${pullAuthor || "unknown"} is not the configured automation bot`);
    }
    if (!policy.allowAutomationPullRequests) reasons.push("Automation pull requests are not allowed to auto-merge");
  } else if (!(policy.allowUserPullRequests && userAuthor)) {
    reasons.push("Pull request author/branch is not allowed to auto-merge");
  }

  if (files.length > policy.maximumFiles) reasons.push(`Pull request changes ${files.length} files; maximum is ${policy.maximumFiles}`);
  const changedLines = files.reduce((sum, file) => sum + Number(file.additions ?? 0) + Number(file.deletions ?? 0), 0);
  if (changedLines > policy.maximumChangedLines) {
    reasons.push(`Pull request changes ${changedLines} lines; maximum is ${policy.maximumChangedLines}`);
  }
  for (const file of files) {
    const filePath = file.filename ?? file.path;
    if (matchesAny(filePath, policy.blockedPaths)) reasons.push(`${filePath} is blocked from auto-merge`);
    if (!matchesAny(filePath, policy.allowedPaths)) reasons.push(`${filePath} is outside the auto-merge allowlist`);
  }

  if (!reviewResult) {
    reasons.push("No current-head AI review decision is available");
  } else {
    if (reviewResult.risk !== "low") reasons.push(`AI review risk is ${reviewResult.risk}`);
    if (reviewResult.blockingFindings.length > 0) reasons.push("AI review has blocking findings");
    if (hasCriticalFinding(reviewResult)) reasons.push("AI review has a critical finding");
    if (!reviewResult.tests.adequate) reasons.push("AI review says test coverage is inadequate");
    if (reviewResult.mergeRecommendation !== "auto") reasons.push(`AI merge recommendation is ${reviewResult.mergeRecommendation}`);
  }
  if (!reviewContextComplete) {
    reasons.push("Frozen review diff context is incomplete");
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    changedLines,
    automationBranch
  };
}
