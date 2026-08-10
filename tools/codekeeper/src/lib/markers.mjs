import { createHash } from "node:crypto";

export const REVIEW_MARKER = "<!-- codekeeper:review -->";
export const ISSUE_TRIAGE_MARKER = "<!-- codekeeper:issue-triage -->";
export const COMMAND_STATUS_MARKER = "<!-- codekeeper:command-status -->";

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

export function repairMarker(fingerprint) {
  return `<!-- codekeeper:repair=${fingerprint} -->`;
}

export function repairNotificationMarker(fingerprint) {
  return `<!-- codekeeper:repair-notification=${fingerprint} -->`;
}

export function fixRunMarker(runId) {
  return `<!-- codekeeper:fix-run=${runId} -->`;
}
