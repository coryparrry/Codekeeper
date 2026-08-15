const ALLOWED_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "by",
  "for",
  "from",
  "has",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "when",
  "with",
]);
const GENERIC_WORDS = new Set([
  "bug",
  "call",
  "change",
  "code",
  "data",
  "error",
  "fail",
  "failure",
  "incorrect",
  "issue",
  "logic",
  "missing",
  "return",
  "set",
  "state",
  "test",
  "use",
  "value",
  "wrong",
]);

function extractText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  for (const key of ["content", "output", "choices", "message"]) {
    const text = extractText(value[key]);
    if (text) return text;
  }
  return "";
}

function parseOutput(output) {
  if (
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    output.caseId
  ) {
    return output;
  }
  const raw = extractText(output).trim();
  const text = raw.startsWith(String.fromCharCode(96, 96, 96))
    ? raw.replace(/^.{3}json\s*/i, "").replace(/.{3}\s*$/, "")
    : raw;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[ab]\//, "")
    .replace(/^\.\//, "");
}

function stem(word) {
  const aliases = {
    awaited: "await",
    awaiting: "await",
    authorization: "auth",
    authorized: "auth",
    unauthorised: "auth",
    unauthorized: "auth",
    concurrency: "race",
    concurrent: "race",
    incorrectly: "incorrect",
    inverted: "reverse",
    inversion: "reverse",
    reversed: "reverse",
  };
  if (aliases[word]) return aliases[word];
  if (word.length > 6 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokens(value) {
  return new Set(
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
      .map(stem),
  );
}

function intersection(left, right) {
  return [...left].filter((value) => right.has(value));
}

function semanticEvidence(finding, issue) {
  const predicted = tokens(`${finding.title} ${finding.reason}`);
  const expectedTitle = tokens(issue.title);
  const expectedAll = tokens(`${issue.title} ${issue.description}`);
  const titleOverlap = intersection(predicted, expectedTitle);
  const allOverlap = intersection(predicted, expectedAll);
  const anchors = titleOverlap.filter((word) => !GENERIC_WORDS.has(word));
  const dice =
    (2 * allOverlap.length) / Math.max(1, predicted.size + expectedAll.size);
  return { anchors: anchors.length, overlap: allOverlap.length, dice };
}

function lineDistance(line, issue) {
  const start = Number(issue.start_line);
  const end = Number(issue.end_line);
  if (!Number.isInteger(start) || !Number.isInteger(end))
    return Number.POSITIVE_INFINITY;
  if (line >= start && line <= end) return 0;
  return Math.min(Math.abs(line - start), Math.abs(line - end));
}

function candidateMatch(finding, issue) {
  if (normalizePath(finding.file) !== normalizePath(issue.file_path))
    return null;
  const distance = lineDistance(finding.line, issue);
  if (distance > 3) return null;
  const semantic = semanticEvidence(finding, issue);
  const supported =
    semantic.anchors >= 2 ||
    (distance === 0 && semantic.anchors >= 1) ||
    (semantic.overlap >= 2 && semantic.dice >= 0.08) ||
    semantic.dice >= 0.16;
  if (!supported) return null;
  return (
    10 - distance + semantic.anchors * 2 + semantic.overlap + semantic.dice
  );
}

function matchFindings(findings, issues) {
  const candidates = [];
  for (
    let findingIndex = 0;
    findingIndex < findings.length;
    findingIndex += 1
  ) {
    for (let issueIndex = 0; issueIndex < issues.length; issueIndex += 1) {
      const score = candidateMatch(findings[findingIndex], issues[issueIndex]);
      if (score !== null) candidates.push({ findingIndex, issueIndex, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const usedFindings = new Set();
  const usedIssues = new Set();
  const matches = [];
  for (const candidate of candidates) {
    if (
      usedFindings.has(candidate.findingIndex) ||
      usedIssues.has(candidate.issueIndex)
    )
      continue;
    usedFindings.add(candidate.findingIndex);
    usedIssues.add(candidate.issueIndex);
    matches.push(candidate);
  }
  return { matches, usedFindings, usedIssues };
}

function validFinding(finding) {
  return (
    finding &&
    typeof finding === "object" &&
    typeof finding.file === "string" &&
    normalizePath(finding.file).length > 0 &&
    Number.isInteger(finding.line) &&
    finding.line > 0 &&
    ALLOWED_SEVERITIES.has(finding.severity) &&
    typeof finding.title === "string" &&
    finding.title.trim().length > 0 &&
    typeof finding.reason === "string" &&
    finding.reason.trim().length > 0
  );
}

function metric(name, score, metadata) {
  return { name, score: Number.isFinite(score) ? score : 0, metadata };
}

function failedMetrics(reason) {
  const metadata = { error: reason };
  return [
    metric("Qodo output contract", 0, metadata),
    metric("Qodo functional recall", 0, metadata),
    metric("Qodo overall recall", 0, metadata),
    metric("Qodo precision", 0, metadata),
    metric("Qodo F1", 0, metadata),
    metric("Qodo impact recall", 0, metadata),
  ];
}

function handler({ output, expected }) {
  const result = parseOutput(output);
  if (!result || !expected || typeof expected !== "object") {
    return failedMetrics("valid JSON output and expected record required");
  }
  const findings = result.findings;
  const issues = expected.issues;
  if (
    result.caseId !== expected.caseId ||
    !Array.isArray(findings) ||
    findings.length > 15 ||
    !findings.every(validFinding) ||
    !Array.isArray(issues) ||
    issues.length === 0
  ) {
    return failedMetrics("case identity or output contract mismatch");
  }

  const { matches, usedFindings, usedIssues } = matchFindings(findings, issues);
  const functionalIndices = issues
    .map((issue, index) => (issue.rule_name === null ? index : null))
    .filter((index) => index !== null);
  const matchedFunctional = functionalIndices.filter((index) =>
    usedIssues.has(index),
  ).length;
  const recall = matches.length / issues.length;
  const functionalRecall =
    matchedFunctional / Math.max(1, functionalIndices.length);
  const precision =
    findings.length === 0 ? 0 : matches.length / findings.length;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  const totalWeight = issues.reduce(
    (sum, issue) => sum + (issue.rule_name === null ? 2 : 1),
    0,
  );
  const matchedWeight = matches.reduce(
    (sum, match) => sum + (issues[match.issueIndex].rule_name === null ? 2 : 1),
    0,
  );
  const shared = {
    caseId: expected.caseId,
    expected: issues.length,
    predicted: findings.length,
    matched: matches.length,
    matchedIssueIds: matches.map((match) => issues[match.issueIndex].id),
    missedIssueIds: issues
      .filter((_, index) => !usedIssues.has(index))
      .map((issue) => issue.id),
    unmatchedFindingIndexes: findings
      .map((_, index) => index)
      .filter((index) => !usedFindings.has(index)),
  };
  return [
    metric("Qodo output contract", 1, shared),
    metric("Qodo functional recall", functionalRecall, shared),
    metric("Qodo overall recall", recall, shared),
    metric("Qodo precision", precision, shared),
    metric("Qodo F1", f1, shared),
    metric("Qodo impact recall", matchedWeight / totalWeight, shared),
  ];
}
