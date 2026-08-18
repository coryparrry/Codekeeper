export const SECURITY_FINDING_WITHHELD_CODE =
  "CODEKEEPER_SECURITY_FINDING_WITHHELD";
export const SECURITY_FINDING_WITHHELD_MESSAGE =
  "Codekeeper withheld a security-sensitive audit result for private maintainer review.";
export const REDACTED_CREDENTIAL = "[REDACTED]";

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const DIRECT_CREDENTIAL_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|glpat-[A-Za-z0-9_-]{20,255}|npm_[A-Za-z0-9]{20,255}|sk_(?:live|test)_[A-Za-z0-9]{8,255}|rk_live_[A-Za-z0-9]{8,255}|sk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,255}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,255}|ya29\.[A-Za-z0-9_-]{20,255}|xox[baprs]-[A-Za-z0-9-]{10,255}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const AUTHORIZATION_PATTERN =
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URI_USERINFO_PATTERN =
  /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/g;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(^|[^A-Za-z0-9_])((?:export\s+)?(?:["']?(?:AWS_SECRET_ACCESS_KEY|STRIPE_SECRET_KEY|[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|PASSWORD|PASSWD|SECRET|TOKEN)[A-Z0-9_]*|api[-_ ]?key|access[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|credential|password|passwd|private[-_ ]?key|secret|token)["']?)\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s,;]+))/gim;
const SECURITY_LABEL_PATTERN =
  /(?:^|[:/_-])(?:credentials?|secrets?|security|vulnerabilit(?:y|ies))(?:$|[:/_-])/i;
const SECURITY_SENSITIVE_PHRASE_PATTERNS = Object.freeze([
  /\b(?:authentication|authorization|access[- ]control|permissions?)\s+(?:bypass(?:es|ed|ing)?|failure|flaw)\b|\bbypass(?:es|ed|ing)?\s+(?:authentication|authorization|access[- ]controls?|permissions?)\b/gi,
  /\b(?:allows?|grants?|permits?)\s+(?:unauthenticated\s+)?(?:administrative|admin|root|privileged)\s+access\b|\bunauthenticated\s+(?:administrative|admin|privileged)\s+access\b|\baccount\s+takeover\b/gi,
  /\bprivilege(?:d)?\s+escalation\b|\bescalat(?:e|es|ed|ing)\s+(?:to\s+)?(?:administrator|admin|root|privileged?)\b/gi,
  /\bRCE\b|\bremote\s+code\s+execution\b|\barbitrary\s+(?:code|command)\s+execution\b|\bexecut(?:e|es|ed|ing)\s+arbitrary\s+(?:code|commands?)\b/gi,
  /\b(?:blind\s+)?(?:GraphQL|HTML|SQL|NoSQL|command|code|CRLF|header|LDAP|log|ORM|OS|shell|SMTP|template|XPath)\s+injection\b|\binjection\s+(?:attack|flaw|payload|vulnerabilit(?:y|ies))\b/gi,
  /\bSSRF\b|\bXSS\b|\bcross[- ]site\s+scripting\b|\bserver[- ]side\s+request\s+forgery\b/gi,
  /\b(?:path|directory)\s+traversal\b|\bXML\s+external\s+entit(?:y|ies)\b|\bXXE\b|\brequest\s+smuggling\b|\bprototype\s+pollution\b|\bunsafe\s+deserialization\b/gi,
  /\b(?:0-day|zero[- ]day|vulnerabilit(?:y|ies)|vulnerable)\b|\bexploit(?:able|ation|ed|ing|s)?\b|\bproof[- ]of[- ]concept\s+(?:attack|exploit|payload)\b/gi,
]);

function patternMatches(pattern, value) {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function unredactedAssignmentValue(match) {
  const value = match.slice(3).find((candidate) => candidate !== undefined) ?? "";
  const normalized = value.trim().toLowerCase();
  return normalized !== "" &&
    normalized !== REDACTED_CREDENTIAL.toLowerCase() &&
    normalized !== "<redacted>" &&
    normalized !== "masked" &&
    normalized !== "hidden" &&
    !/^\*{3,}$/.test(normalized);
}

function containsCredentialAssignment(value) {
  CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(CREDENTIAL_ASSIGNMENT_PATTERN)) {
    if (unredactedAssignmentValue(match)) return true;
  }
  return false;
}

export function containsCredentialShapedValue(value) {
  const text = String(value ?? "");
  return patternMatches(PRIVATE_KEY_PATTERN, text) ||
    patternMatches(DIRECT_CREDENTIAL_PATTERN, text) ||
    patternMatches(AUTHORIZATION_PATTERN, text) ||
    patternMatches(URI_USERINFO_PATTERN, text) ||
    containsCredentialAssignment(text);
}

export function containsSecuritySensitivePhrase(value) {
  const text = String(value ?? "");
  return SECURITY_SENSITIVE_PHRASE_PATTERNS.some((pattern) =>
    patternMatches(pattern, text),
  );
}

export function redactCredentialShapedValues(value) {
  return String(value ?? "")
    .replace(PRIVATE_KEY_PATTERN, REDACTED_CREDENTIAL)
    .replace(DIRECT_CREDENTIAL_PATTERN, REDACTED_CREDENTIAL)
    .replace(AUTHORIZATION_PATTERN, `$1 ${REDACTED_CREDENTIAL}`)
    .replace(URI_USERINFO_PATTERN, `$1${REDACTED_CREDENTIAL}@`)
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, (...match) => {
      if (!unredactedAssignmentValue(match)) return match[0];
      return `${match[1]}${match[2]}${REDACTED_CREDENTIAL}`;
    });
}

function containsSecuritySensitiveContent(value) {
  if (typeof value === "string") {
    return containsCredentialShapedValue(value) ||
      containsSecuritySensitivePhrase(value);
  }
  if (Array.isArray(value)) return value.some(containsSecuritySensitiveContent);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsSecuritySensitiveContent);
}

function hasSecurityLabel(findings) {
  return findings.some((finding) =>
    (Array.isArray(finding?.labels) ? finding.labels : []).some((label) =>
      SECURITY_LABEL_PATTERN.test(String(label ?? "").normalize("NFKC").trim()),
    ),
  );
}

export function isSecurityFindingWithheld(error) {
  return error?.code === SECURITY_FINDING_WITHHELD_CODE;
}

export function assertNoPublicSecurityFindings(result) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const publishableText = [
    result?.summary,
    findings,
    result?.repair,
    result?.noActionReason,
  ];
  if (
    findings.some((finding) => finding?.category === "security") ||
    hasSecurityLabel(findings) ||
    publishableText.some(containsSecuritySensitiveContent)
  ) {
    const error = new Error(SECURITY_FINDING_WITHHELD_MESSAGE);
    error.code = SECURITY_FINDING_WITHHELD_CODE;
    throw error;
  }
  return result;
}
