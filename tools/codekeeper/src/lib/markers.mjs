import { createHash } from "node:crypto";

export const REVIEW_MARKER = "<!-- codekeeper:review -->";
export const ISSUE_TRIAGE_MARKER = "<!-- codekeeper:issue-triage -->";
export const COMMAND_STATUS_MARKER = "<!-- codekeeper:command-status -->";
const ISSUE_TRIAGE_STATE_PREFIX = "<!-- codekeeper:issue-triage-state=v1:";
const ISSUE_TRIAGE_STATE_SUFFIX = " -->";
const ISSUE_TRIAGE_STATE_MAXIMUM_ITEM_LENGTH = 384;

function boundedStateText(value, maximum = ISSUE_TRIAGE_STATE_MAXIMUM_ITEM_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= maximum) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maximum - 1))}…`, truncated: true };
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

// The triage result can contain long reporter-facing strings. Keep the
// continuation state small enough to remain inside GitHub's comment limit,
// while retaining the exact validated-result digest and the information that
// authorizes a comment-triggered re-triage.
export function issueTriageStateMarker(result) {
  const missingInformation = [];
  let missingInformationTruncated = false;
  for (const item of result.missingInformation ?? []) {
    const bounded = boundedStateText(item);
    missingInformation.push(bounded.text);
    missingInformationTruncated ||= bounded.truncated;
  }
  const state = {
    version: 1,
    resultSha256: sha256(JSON.stringify(result)),
    actionable: result.actionable === true,
    implementationRecommendation: String(result.implementationRecommendation ?? ""),
    missingInformation,
    missingInformationTruncated
  };
  return `${ISSUE_TRIAGE_STATE_PREFIX}${base64UrlEncode(JSON.stringify(state))}${ISSUE_TRIAGE_STATE_SUFFIX}`;
}

export function parseIssueTriageStateMarker(body) {
  if (typeof body !== "string") return null;
  const matches = [...body.matchAll(/<!-- codekeeper:issue-triage-state=v1:([A-Za-z0-9_-]+) -->/g)];
  if (matches.length !== 1) return null;
  try {
    const state = JSON.parse(base64UrlDecode(matches[0][1]));
    if (!state || typeof state !== "object" || Array.isArray(state)) return null;
    const expectedKeys = [
      "version", "resultSha256", "actionable", "implementationRecommendation",
      "missingInformation", "missingInformationTruncated"
    ];
    if (Object.keys(state).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(state, key))) return null;
    if (state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.resultSha256)) return null;
    if (typeof state.actionable !== "boolean" || !["no", "manual", "ai-ready"].includes(state.implementationRecommendation)) return null;
    if (!Array.isArray(state.missingInformation) || state.missingInformation.length > 8
      || state.missingInformation.some((item) => typeof item !== "string" || !item || item.length > ISSUE_TRIAGE_STATE_MAXIMUM_ITEM_LENGTH)
      || typeof state.missingInformationTruncated !== "boolean") return null;
    return state;
  } catch {
    return null;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function findingFingerprint(finding) {
  return sha256(JSON.stringify({
    version: 1,
    category: String(finding.category ?? "").normalize("NFKC").trim().toLowerCase(),
    problemKey: String(finding.problemKey || finding.title || "").normalize("NFKC").trim(),
    owningPath: String(finding.owningPath || "repository").normalize("NFKC").trim()
  }));
}

export function findingMarker(fingerprint) {
  return `<!-- codekeeper:fingerprint=${fingerprint} -->`;
}

export function deferredReviewFingerprint(repository, pullNumber, sourceKeys) {
  const normalizedSourceKeys = [...new Set((Array.isArray(sourceKeys) ? sourceKeys : [sourceKeys])
    .map((sourceKey) => String(sourceKey ?? "").normalize("NFKC").trim().toLowerCase())
    .filter(Boolean))].sort();
  return sha256(JSON.stringify({
    version: 2,
    repository: String(repository ?? "").trim().toLowerCase(),
    pullNumber,
    sourceKeys: normalizedSourceKeys
  }));
}

export function deferredReviewMarker(fingerprint) {
  return `<!-- codekeeper:deferred=${fingerprint} -->`;
}

export function reviewFeedbackReplyMarker(fingerprint) {
  return `<!-- codekeeper:review-feedback-reply=${fingerprint} -->`;
}

export function automaticRepairMarker(headSha) {
  const normalized = String(headSha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error("Automatic repair marker requires a full head SHA");
  return `<!-- codekeeper:auto-repair-head=${normalized} -->`;
}

export function repairMarker(fingerprint) {
  return `<!-- codekeeper:repair=${fingerprint} -->`;
}

export function repairNotificationMarker(fingerprint) {
  return `<!-- codekeeper:repair-notification=${fingerprint} -->`;
}

export function fixRunMarker(runId) {
  return `<!-- codekeeper:fix-run=${runId} -->`;
}
