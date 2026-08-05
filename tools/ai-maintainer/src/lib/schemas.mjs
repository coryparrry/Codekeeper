const LIMITS = Object.freeze({
  title: 512,
  summary: 12000,
  body: 20000,
  path: 2048,
  key: 512,
  label: 128,
  command: 2000,
  result: 8000
});

function stringSchema({ minLength = 1, maxLength = LIMITS.summary } = {}) {
  return { type: "string", minLength, maxLength };
}

function nullableString(maxLength = LIMITS.summary) {
  return { anyOf: [stringSchema({ minLength: 0, maxLength }), { type: "null" }] };
}

function nullableInteger() {
  return { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] };
}

function object(properties, required = Object.keys(properties)) {
  return { type: "object", additionalProperties: false, properties, required };
}

function findingSchema(config) {
  return object({
    title: stringSchema({ maxLength: LIMITS.title }),
    evidence: stringSchema({ maxLength: LIMITS.body }),
    category: { enum: ["docs", "dependency", "cleanup", "bug", "security", "testing"] },
    priority: { enum: ["p1", "p2", "p3"] },
    owningPath: stringSchema({ maxLength: LIMITS.path }),
    problemKey: stringSchema({ maxLength: LIMITS.key }),
    proposedAction: stringSchema({ maxLength: LIMITS.body }),
    labels: {
      type: "array",
      items: { enum: config.review.allowedLabels },
      maxItems: 6
    }
  });
}

function reviewFindingSchema() {
  return object({
    title: stringSchema({ maxLength: LIMITS.title }),
    explanation: stringSchema({ maxLength: LIMITS.body }),
    severity: { enum: ["critical", "high", "medium", "low"] },
    confidence: { enum: ["high", "medium", "low"] },
    file: nullableString(LIMITS.path),
    line: nullableInteger()
  });
}

export function reviewSchema(config) {
  return object({
      mode: { const: "review" },
      summary: stringSchema({ maxLength: LIMITS.summary }),
      risk: { enum: ["low", "medium", "high"] },
      labels: {
        type: "array",
        items: { enum: config.review.allowedLabels },
        maxItems: config.review.allowedLabels.length
      },
      blockingFindings: {
        type: "array",
        items: reviewFindingSchema(),
        maxItems: config.review.maximumBlockingFindings
      },
      nonBlockingFindings: {
        type: "array",
        items: reviewFindingSchema(),
        maxItems: config.review.maximumNonBlockingFindings
      },
      tests: object({
        adequate: { type: "boolean" },
        notes: stringSchema({ minLength: 0, maxLength: LIMITS.summary })
      }),
      mergeRecommendation: { enum: ["block", "manual", "auto"] },
      noActionReason: nullableString(LIMITS.summary)
    });
}

export function auditSchema(config) {
  return object({
      mode: { const: "audit" },
      summary: stringSchema({ maxLength: LIMITS.summary }),
      findings: {
        type: "array",
        items: findingSchema(config),
        maxItems: config.audit.maximumIssuesPerRun
      },
      repair: object({
        requested: { type: "boolean" },
        findingIndex: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        title: stringSchema({ minLength: 0, maxLength: LIMITS.title }),
        body: stringSchema({ minLength: 0, maxLength: LIMITS.body }),
        risk: { enum: ["low", "medium", "high"] },
        validationSummary: stringSchema({ minLength: 0, maxLength: LIMITS.summary })
      }),
      noActionReason: nullableString(LIMITS.summary)
    });
}

export function issueSchema(config) {
  return object({
      mode: { const: "issue" },
      summary: stringSchema({ maxLength: LIMITS.summary }),
      type: { enum: ["bug", "enhancement", "documentation", "question", "security", "maintenance"] },
      priority: { enum: ["p1", "p2", "p3"] },
      labels: {
        type: "array",
        items: { enum: config.review.allowedLabels },
        maxItems: config.review.allowedLabels.length
      },
      actionable: { type: "boolean" },
      missingInformation: {
        type: "array",
        items: stringSchema({ maxLength: 4000 }),
        maxItems: 8
      },
      duplicateOf: nullableInteger(),
      duplicateConfidence: { enum: ["none", "low", "medium", "high"] },
      implementationRecommendation: { enum: ["no", "manual", "ai-ready"] },
      comment: stringSchema({ maxLength: LIMITS.body })
    });
}

export function fixSchema() {
  return object({
      mode: { const: "fix" },
      summary: stringSchema({ maxLength: LIMITS.summary }),
      risk: { enum: ["low", "medium", "high"] },
      issueNumber: { type: "integer", minimum: 1 },
      changedSummary: stringSchema({ minLength: 0, maxLength: LIMITS.body }),
      testsRun: {
        type: "array",
        items: object({
          command: stringSchema({ maxLength: LIMITS.command }),
          result: stringSchema({ maxLength: LIMITS.result })
        }),
        maxItems: 20
      },
      readyForReview: { type: "boolean" },
      noChangeReason: nullableString(LIMITS.body)
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid Codex result: ${message}`);
}

function assertObject(value, name) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
}

function assertExactKeys(value, allowed, name) {
  assertObject(value, name);
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) assert(expected.has(key), `${name} contains unsupported field ${key}`);
  for (const key of expected) assert(Object.hasOwn(value, key), `${name} is missing required field ${key}`);
}

function assertString(value, name, { allowEmpty = false, maxLength = LIMITS.summary } = {}) {
  assert(typeof value === "string", `${name} must be a string`);
  if (!allowEmpty) assert(value.trim().length > 0, `${name} must not be empty`);
  assert(value.length <= maxLength, `${name} exceeds ${maxLength} characters`);
}

function assertNullableString(value, name, maxLength = LIMITS.summary) {
  assert(value === null || typeof value === "string", `${name} must be string or null`);
  if (typeof value === "string") assertString(value, name, { allowEmpty: true, maxLength });
}

function assertUniqueStrings(value, name, { allowed = null, maximum = Number.MAX_SAFE_INTEGER, itemMaximum = LIMITS.label } = {}) {
  assert(Array.isArray(value), `${name} must be an array`);
  assert(value.length <= maximum, `${name} has too many entries`);
  const seen = new Set();
  for (const item of value) {
    assertString(item, `${name} item`, { maxLength: itemMaximum });
    assert(!seen.has(item), `${name} contains duplicate ${item}`);
    if (allowed) assert(allowed.includes(item), `${name} contains unsupported value ${item}`);
    seen.add(item);
  }
}

function assertEnum(value, allowed, name) {
  assert(allowed.includes(value), `${name} must be one of ${allowed.join(", ")}`);
}

function validateReviewFinding(finding, name, { blocking = false } = {}) {
  assertExactKeys(finding, ["title", "explanation", "severity", "confidence", "file", "line"], name);
  assertString(finding.title, `${name}.title`, { maxLength: LIMITS.title });
  assertString(finding.explanation, `${name}.explanation`, { maxLength: LIMITS.body });
  assertEnum(finding.severity, ["critical", "high", "medium", "low"], `${name}.severity`);
  assertEnum(finding.confidence, ["high", "medium", "low"], `${name}.confidence`);
  assertNullableString(finding.file, `${name}.file`, LIMITS.path);
  assert(finding.line === null || (Number.isInteger(finding.line) && finding.line > 0), `${name}.line must be positive integer or null`);
  if (blocking) {
    assert(finding.confidence !== "low", `${name} cannot block with low confidence`);
    assert(finding.severity !== "low", `${name} cannot block with low severity`);
  }
}

export function validateReviewResult(result, config) {
  assertExactKeys(result, [
    "mode", "summary", "risk", "labels", "blockingFindings", "nonBlockingFindings",
    "tests", "mergeRecommendation", "noActionReason"
  ], "result");
  assert(result.mode === "review", "mode must be review");
  assertString(result.summary, "summary", { maxLength: LIMITS.summary });
  assertEnum(result.risk, ["low", "medium", "high"], "risk");
  assertUniqueStrings(result.labels, "labels", {
    allowed: config.review.allowedLabels,
    maximum: config.review.allowedLabels.length
  });
  assert(Array.isArray(result.blockingFindings), "blockingFindings must be an array");
  assert(result.blockingFindings.length <= config.review.maximumBlockingFindings, "too many blocking findings");
  result.blockingFindings.forEach((finding, index) =>
    validateReviewFinding(finding, `blockingFindings[${index}]`, { blocking: true })
  );
  assert(Array.isArray(result.nonBlockingFindings), "nonBlockingFindings must be an array");
  assert(result.nonBlockingFindings.length <= config.review.maximumNonBlockingFindings, "too many non-blocking findings");
  result.nonBlockingFindings.forEach((finding, index) => {
    const name = `nonBlockingFindings[${index}]`;
    validateReviewFinding(finding, name);
    assert(finding.severity !== "critical", `${name} cannot contain a critical finding`);
  });
  assertExactKeys(result.tests, ["adequate", "notes"], "tests");
  assert(typeof result.tests.adequate === "boolean", "tests.adequate must be boolean");
  assertString(result.tests.notes, "tests.notes", { allowEmpty: true, maxLength: LIMITS.summary });
  assertEnum(result.mergeRecommendation, ["block", "manual", "auto"], "mergeRecommendation");
  assertNullableString(result.noActionReason, "noActionReason", LIMITS.summary);
  if (result.blockingFindings.length > 0) {
    assert(result.mergeRecommendation === "block", "blocking findings require mergeRecommendation=block");
  }
  if (result.mergeRecommendation === "auto") {
    assert(result.risk === "low", "auto recommendation requires low risk");
    assert(result.blockingFindings.length === 0, "auto recommendation cannot have blockers");
    assert(result.tests.adequate, "auto recommendation requires adequate tests");
  }
  return result;
}

function validateFinding(finding, config, name) {
  assertExactKeys(finding, [
    "title", "evidence", "category", "priority", "owningPath", "problemKey", "proposedAction", "labels"
  ], name);
  assertString(finding.title, `${name}.title`, { maxLength: LIMITS.title });
  assertString(finding.evidence, `${name}.evidence`, { maxLength: LIMITS.body });
  assertEnum(finding.category, ["docs", "dependency", "cleanup", "bug", "security", "testing"], `${name}.category`);
  assertEnum(finding.priority, ["p1", "p2", "p3"], `${name}.priority`);
  assertString(finding.owningPath, `${name}.owningPath`, { maxLength: LIMITS.path });
  assertString(finding.problemKey, `${name}.problemKey`, { maxLength: LIMITS.key });
  assertString(finding.proposedAction, `${name}.proposedAction`, { maxLength: LIMITS.body });
  assertUniqueStrings(finding.labels, `${name}.labels`, {
    allowed: config.review.allowedLabels,
    maximum: 6
  });
}

export function validateAuditResult(result, config) {
  assertExactKeys(result, ["mode", "summary", "findings", "repair", "noActionReason"], "result");
  assert(result.mode === "audit", "mode must be audit");
  assertString(result.summary, "summary", { maxLength: LIMITS.summary });
  assert(Array.isArray(result.findings), "findings must be an array");
  assert(result.findings.length <= config.audit.maximumIssuesPerRun, "too many findings");
  const findingKeys = new Set();
  result.findings.forEach((finding, index) => {
    validateFinding(finding, config, `findings[${index}]`);
    const key = `${finding.category}|${finding.problemKey}|${finding.owningPath}`.toLowerCase();
    assert(!findingKeys.has(key), `findings contains duplicate stable key ${key}`);
    findingKeys.add(key);
  });
  assertExactKeys(result.repair, ["requested", "findingIndex", "title", "body", "risk", "validationSummary"], "repair");
  assert(typeof result.repair.requested === "boolean", "repair.requested must be boolean");
  assert(result.repair.findingIndex === null || (Number.isInteger(result.repair.findingIndex) && result.repair.findingIndex >= 0), "repair.findingIndex invalid");
  assertString(result.repair.title, "repair.title", { allowEmpty: true, maxLength: LIMITS.title });
  assertString(result.repair.body, "repair.body", { allowEmpty: true, maxLength: LIMITS.body });
  assertEnum(result.repair.risk, ["low", "medium", "high"], "repair.risk");
  assertString(result.repair.validationSummary, "repair.validationSummary", { allowEmpty: true, maxLength: LIMITS.summary });
  assertNullableString(result.noActionReason, "noActionReason", LIMITS.summary);
  if (result.repair.requested) {
    assert(result.repair.findingIndex !== null, "repair requires findingIndex");
    assert(result.repair.findingIndex < result.findings.length, "repair findingIndex is out of range");
    assertString(result.repair.title, "repair.title", { maxLength: LIMITS.title });
    assertString(result.repair.body, "repair.body", { maxLength: LIMITS.body });
  } else {
    assert(result.repair.findingIndex === null, "repair.findingIndex must be null when no repair is requested");
  }
  return result;
}

export function validateIssueResult(result, config) {
  assertExactKeys(result, [
    "mode", "summary", "type", "priority", "labels", "actionable", "missingInformation",
    "duplicateOf", "duplicateConfidence", "implementationRecommendation", "comment"
  ], "result");
  assert(result.mode === "issue", "mode must be issue");
  assertString(result.summary, "summary", { maxLength: LIMITS.summary });
  assertEnum(result.type, ["bug", "enhancement", "documentation", "question", "security", "maintenance"], "type");
  assertEnum(result.priority, ["p1", "p2", "p3"], "priority");
  assertUniqueStrings(result.labels, "labels", {
    allowed: config.review.allowedLabels,
    maximum: config.review.allowedLabels.length
  });
  assert(typeof result.actionable === "boolean", "actionable must be boolean");
  assertUniqueStrings(result.missingInformation, "missingInformation", { maximum: 8, itemMaximum: 4000 });
  assert(result.duplicateOf === null || (Number.isInteger(result.duplicateOf) && result.duplicateOf > 0), "duplicateOf invalid");
  assertEnum(result.duplicateConfidence, ["none", "low", "medium", "high"], "duplicateConfidence");
  assertEnum(result.implementationRecommendation, ["no", "manual", "ai-ready"], "implementationRecommendation");
  assertString(result.comment, "comment", { maxLength: LIMITS.body });
  if (result.duplicateOf === null) {
    assert(result.duplicateConfidence === "none", "duplicateConfidence must be none without duplicateOf");
  } else {
    assert(result.duplicateConfidence !== "none", "duplicateConfidence cannot be none with duplicateOf");
  }
  if (result.implementationRecommendation === "ai-ready") {
    assert(result.actionable, "ai-ready requires actionable=true");
    assert(result.missingInformation.length === 0, "ai-ready cannot have missing information");
    assert(result.duplicateOf === null, "ai-ready cannot be a duplicate");
  }
  return result;
}

export function validateFixResult(result, issueNumber) {
  assertExactKeys(result, [
    "mode", "summary", "risk", "issueNumber", "changedSummary", "testsRun", "readyForReview", "noChangeReason"
  ], "result");
  assert(result.mode === "fix", "mode must be fix");
  assertString(result.summary, "summary", { maxLength: LIMITS.summary });
  assertEnum(result.risk, ["low", "medium", "high"], "risk");
  assert(result.issueNumber === issueNumber, "issueNumber does not match requested issue");
  assertString(result.changedSummary, "changedSummary", { allowEmpty: true, maxLength: LIMITS.body });
  assert(Array.isArray(result.testsRun), "testsRun must be an array");
  assert(result.testsRun.length <= 20, "testsRun has too many entries");
  for (const [index, test] of result.testsRun.entries()) {
    assertExactKeys(test, ["command", "result"], `testsRun[${index}]`);
    assertString(test.command, `testsRun[${index}].command`, { maxLength: LIMITS.command });
    assertString(test.result, `testsRun[${index}].result`, { maxLength: LIMITS.result });
  }
  assert(typeof result.readyForReview === "boolean", "readyForReview must be boolean");
  assertNullableString(result.noChangeReason, "noChangeReason", LIMITS.body);
  if (result.noChangeReason !== null) {
    assert(!result.readyForReview, "no-change result cannot be ready for review");
  }
  return result;
}
