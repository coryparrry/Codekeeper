const LIMITS = Object.freeze({
  title: 512,
  summary: 2000,
  body: 6000,
  path: 2048,
  key: 512,
  label: 128,
  command: 500,
  result: 2000,
  diagram: 4000
});

const ROOT_CAUSE_TAG_PATTERN = "^[a-z0-9]+(?:[._:/-][a-z0-9]+)*$";
const REPOSITORY_RELATIVE_PATH_PATTERN = "^(?!/)(?![A-Za-z]:)(?!.*:)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+$";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function providerConstType(value) {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? "integer" : "number";
  }
  throw new Error("Provider schema projection supports only JSON primitive const values");
}

function providerConstSchema(source) {
  const inferredType = providerConstType(source.const);
  if (Object.hasOwn(source, "enum") && (!Array.isArray(source.enum) || source.enum.length !== 1 || !Object.is(source.enum[0], source.const))) {
    throw new Error("Provider schema projection const requires an identical singleton enum");
  }
  if (!Object.hasOwn(source, "type")) return { type: inferredType, enum: [cloneJson(source.const)] };
  if (typeof source.type !== "string" || !["string", "boolean", "null", "number", "integer"].includes(source.type)) {
    throw new Error("Provider schema projection requires a supported primitive type for const");
  }
  const typeMatches = source.type === inferredType || (source.type === "number" && inferredType === "integer");
  if (!typeMatches) throw new Error("Provider schema projection const does not match its type");
  return { type: source.type, enum: [cloneJson(source.const)] };
}

// The Codex workspace action consumes this file through its provider's strict
// output-schema API. The local validators continue to use the source schemas;
// this creates only the provider-wire representation it requires. OpenAI
// structured outputs reject uniqueItems, so uniqueness stays a local check.
// They also reject regex lookaround and other `(?` constructs, so those
// patterns stay a local check.
export function providerCompatibleJsonSchema(value) {
  if (Array.isArray(value)) return value.map((item) => providerCompatibleJsonSchema(item));
  if (!isPlainObject(value)) return cloneJson(value);
  const hasConst = Object.hasOwn(value, "const");
  const projected = hasConst ? providerConstSchema(value) : {};
  for (const [key, item] of Object.entries(value)) {
    if (hasConst && (key === "const" || key === "enum" || key === "type")) continue;
    if (key === "uniqueItems") continue;
    if (
      key === "pattern" &&
      typeof item === "string" &&
      item.includes("(?")
    ) {
      continue;
    }
    projected[key] = providerCompatibleJsonSchema(item);
  }
  if (
    !hasConst &&
    Object.hasOwn(projected, "enum") &&
    !Object.hasOwn(projected, "type") &&
    Array.isArray(projected.enum) &&
    projected.enum.every((item) => typeof item === "string")
  ) {
    projected.type = "string";
  }
  return projected;
}

function stringSchema({ minLength = 1, maxLength = LIMITS.summary } = {}) {
  return { type: "string", minLength, maxLength };
}

function nullableString(maxLength = LIMITS.summary) {
  return { anyOf: [stringSchema({ minLength: 0, maxLength }), { type: "null" }] };
}

function nullableInteger() {
  return { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] };
}

function nullableRepositoryPath() {
  return {
    anyOf: [
      {
        type: "string",
        minLength: 1,
        maxLength: LIMITS.path,
        pattern: REPOSITORY_RELATIVE_PATH_PATTERN
      },
      { type: "null" }
    ]
  };
}

function object(properties, required = Object.keys(properties)) {
  return { type: "object", additionalProperties: false, properties, required };
}

function labelArraySchema(labels, maxItems) {
  return {
    type: "array",
    items: { type: "string", enum: labels },
    maxItems: maxItems ?? labels.length
  };
}

function issueAllowedLabels(config) {
  // Production callers pass a normalized policy. Fail closed for direct
  // callers that skip normalization instead of falling back to PR labels.
  return Array.isArray(config?.issues?.allowedLabels) ? config.issues.allowedLabels : [];
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
    labels: labelArraySchema(config.review.allowedLabels, 6)
  });
}

function reviewFindingSchema() {
  return object({
    title: stringSchema({ maxLength: LIMITS.title }),
    explanation: stringSchema({ maxLength: LIMITS.body }),
    severity: { enum: ["critical", "high", "medium", "low"] },
    confidence: { enum: ["high", "medium", "low"] },
    classification: { enum: ["current", "stale", "already-fixed", "pre-existing", "preference-only", "not-actionable"] },
    validation: stringSchema({ maxLength: LIMITS.body }),
    preventionTest: stringSchema({ maxLength: LIMITS.summary }),
    rootCauseTags: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
        maxLength: LIMITS.label,
        pattern: ROOT_CAUSE_TAG_PATTERN
      },
      minItems: 1,
      maxItems: 8,
      uniqueItems: true
    },
    reproductionTest: nullableRepositoryPath(),
    file: nullableString(LIMITS.path),
    line: nullableInteger()
  });
}

function reviewFeedbackSchema() {
  return object({
    problemKey: stringSchema({ maxLength: LIMITS.key }),
    disposition: { enum: ["fix_now", "fix_if_cheap", "defer", "ignore"] },
    type: { enum: ["bug", "enhancement", "documentation", "question", "security", "maintenance", "testing"] },
    explanation: stringSchema({ maxLength: LIMITS.body }),
    validation: stringSchema({ maxLength: LIMITS.body }),
    sourceKeys: {
      type: "array",
      items: stringSchema({ maxLength: LIMITS.key }),
      minItems: 1,
      maxItems: 128
    },
    threadIds: {
      type: "array",
      items: stringSchema({ maxLength: LIMITS.key }),
      maxItems: 128
    }
  });
}

export function reviewSchema(config) {
  return object({
      mode: { const: "review" },
      summary: stringSchema({ maxLength: LIMITS.summary }),
      risk: { enum: ["low", "medium", "high"] },
      labels: labelArraySchema(config.review.allowedLabels),
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
      reviewFeedback: {
        type: "array",
        items: reviewFeedbackSchema(),
        maxItems: 128
      },
      tests: object({
        adequate: { type: "boolean" },
        notes: stringSchema({ minLength: 0, maxLength: LIMITS.summary }),
        missingTest: {
          ...nullableString(LIMITS.summary),
          description: "A concrete repository-local test that can run in the current checkout, including its target, trigger or input, expected behavior, and the changed behavior it proves; null for unavailable external-source evidence."
        }
      }),
      diagram: nullableString(LIMITS.diagram),
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
      labels: labelArraySchema(issueAllowedLabels(config)),
      actionable: { type: "boolean" },
      missingInformation: {
        type: "array",
        items: stringSchema({ maxLength: 4000 }),
        maxItems: 8
      },
      duplicateOf: nullableInteger(),
      duplicateConfidence: { enum: ["none", "low", "medium", "high"] },
      implementationRecommendation: { enum: ["no", "manual", "ai-ready"] },
      decision: object({
        required: { type: "boolean" },
        question: stringSchema({ minLength: 0, maxLength: LIMITS.summary }),
        rationale: stringSchema({ minLength: 0, maxLength: LIMITS.summary }),
        options: {
          type: "array",
          maxItems: 3,
          items: object({
            label: stringSchema({ maxLength: LIMITS.title }),
            description: stringSchema({ maxLength: LIMITS.summary }),
            recommended: { type: "boolean" }
          })
        }
      }),
      comment: stringSchema({ maxLength: LIMITS.body })
    });
}

export function fixSchema(target = null) {
  const targetKind = target?.kind;
  const targetNumber = target?.number;
  if (target !== null && (!["issue", "pull_request"].includes(targetKind) || !Number.isSafeInteger(targetNumber) || targetNumber <= 0)) {
    throw new Error("Fix schema requires a valid frozen target");
  }
  return object({
      mode: { const: "fix" },
      summary: stringSchema({ maxLength: LIMITS.summary }),
      risk: { enum: ["low", "medium", "high"] },
      targetKind: target ? { const: targetKind } : { enum: ["issue", "pull_request"] },
      targetNumber: target ? { const: targetNumber } : { type: "integer", minimum: 1 },
      changedSummary: stringSchema({ minLength: 0, maxLength: LIMITS.body }),
      testsRun: {
        type: "array",
        items: object({
          command: stringSchema({ maxLength: LIMITS.command }),
          result: stringSchema({ maxLength: LIMITS.result })
        }),
        maxItems: 8
      },
      resolvedReviewThreadIds: {
        type: "array",
        items: stringSchema({ maxLength: LIMITS.key }),
        maxItems: 128
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

export function assertRootCauseTags(value, name) {
  assert(Array.isArray(value), `${name} must be an array`);
  assert(value.length >= 1 && value.length <= 8, `${name} must contain 1 through 8 tags`);
  const seen = new Set();
  for (const tag of value) {
    assertString(tag, `${name} item`, { maxLength: LIMITS.label });
    assert(tag === tag.normalize("NFKC") && tag === tag.toLowerCase(), `${name} items must be normalized lowercase tags`);
    assert(new RegExp(ROOT_CAUSE_TAG_PATTERN).test(tag), `${name} contains an unstable tag ${tag}`);
    assert(!seen.has(tag), `${name} contains duplicate ${tag}`);
    seen.add(tag);
  }
}

export function assertRepositoryRelativePath(value, name) {
  assertNullableString(value, name, LIMITS.path);
  if (value === null) return;
  assert(value.length > 0, `${name} must be null or a non-empty repository-relative path`);
  assert(!value.startsWith("/") && !/^[A-Za-z]:/.test(value), `${name} must be repository-relative`);
  assert(!value.includes(":"), `${name} must not be a URL or drive path`);
  assert(!value.includes("\\"), `${name} must use repository-relative separators`);
  assert(!value.split("/").includes(".."), `${name} must not traverse parent directories`);
  assert(!/[\u0000-\u001f]/.test(value), `${name} contains unsupported control characters`);
}

function validateReviewFinding(finding, name, { blocking = false } = {}) {
  assertExactKeys(finding, ["title", "explanation", "severity", "confidence", "classification", "validation", "preventionTest", "rootCauseTags", "reproductionTest", "file", "line"], name);
  assertString(finding.title, `${name}.title`, { maxLength: LIMITS.title });
  assertString(finding.explanation, `${name}.explanation`, { maxLength: LIMITS.body });
  assertEnum(finding.severity, ["critical", "high", "medium", "low"], `${name}.severity`);
  assertEnum(finding.confidence, ["high", "medium", "low"], `${name}.confidence`);
  assertEnum(finding.classification, ["current", "stale", "already-fixed", "pre-existing", "preference-only", "not-actionable"], `${name}.classification`);
  assertString(finding.validation, `${name}.validation`, { maxLength: LIMITS.body });
  assertString(finding.preventionTest, `${name}.preventionTest`, { maxLength: LIMITS.summary });
  assertRootCauseTags(finding.rootCauseTags, `${name}.rootCauseTags`);
  assertRepositoryRelativePath(finding.reproductionTest, `${name}.reproductionTest`);
  assertNullableString(finding.file, `${name}.file`, LIMITS.path);
  assert(finding.line === null || (Number.isInteger(finding.line) && finding.line > 0), `${name}.line must be positive integer or null`);
  if (blocking) {
    assert(finding.classification === "current", `${name} must be a current validated finding before it can block`);
    assert(finding.confidence !== "low", `${name} cannot block with low confidence`);
  }
}

export function validateReviewResult(result, config) {
  if (result && typeof result === "object" && !Object.hasOwn(result, "diagram")) result.diagram = null;
  if (result && typeof result === "object" && !Object.hasOwn(result, "reviewFeedback")) result.reviewFeedback = [];
  assertExactKeys(result, [
    "mode", "summary", "risk", "labels", "blockingFindings", "nonBlockingFindings",
    "reviewFeedback", "tests", "diagram", "mergeRecommendation", "noActionReason"
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
  assert(Array.isArray(result.reviewFeedback), "reviewFeedback must be an array");
  assert(result.reviewFeedback.length <= 128, "too many review feedback groups");
  const problemKeys = new Set();
  const sourceKeys = new Set();
  result.reviewFeedback.forEach((feedback, index) => {
    const name = `reviewFeedback[${index}]`;
    assertExactKeys(feedback, ["problemKey", "disposition", "type", "explanation", "validation", "sourceKeys", "threadIds"], name);
    assertString(feedback.problemKey, `${name}.problemKey`, { maxLength: LIMITS.key });
    const normalizedProblemKey = feedback.problemKey.normalize("NFKC").trim().toLowerCase();
    assert(!problemKeys.has(normalizedProblemKey), `duplicate review feedback problemKey ${feedback.problemKey}`);
    problemKeys.add(normalizedProblemKey);
    assertEnum(feedback.disposition, ["fix_now", "fix_if_cheap", "defer", "ignore"], `${name}.disposition`);
    assertEnum(feedback.type, ["bug", "enhancement", "documentation", "question", "security", "maintenance", "testing"], `${name}.type`);
    assertString(feedback.explanation, `${name}.explanation`, { maxLength: LIMITS.body });
    assertString(feedback.validation, `${name}.validation`, { maxLength: LIMITS.body });
    assertUniqueStrings(feedback.sourceKeys, `${name}.sourceKeys`, { maximum: 128, itemMaximum: LIMITS.key });
    assert(feedback.sourceKeys.length > 0, `${name}.sourceKeys must not be empty`);
    for (const sourceKey of feedback.sourceKeys) {
      assert(!sourceKeys.has(sourceKey), `review feedback source ${sourceKey} is classified more than once`);
      sourceKeys.add(sourceKey);
    }
    assertUniqueStrings(feedback.threadIds, `${name}.threadIds`, { maximum: 128, itemMaximum: LIMITS.key });
  });
  assertExactKeys(result.tests, ["adequate", "notes", "missingTest"], "tests");
  assert(typeof result.tests.adequate === "boolean", "tests.adequate must be boolean");
  assertString(result.tests.notes, "tests.notes", { allowEmpty: true, maxLength: LIMITS.summary });
  assertNullableString(result.tests.missingTest, "tests.missingTest", LIMITS.summary);
  assert(!result.tests.adequate || result.tests.missingTest === null, "adequate tests cannot name a missing test");
  assertNullableString(result.diagram, "diagram", LIMITS.diagram);
  if (result.diagram !== null) {
    result.diagram = result.diagram.trim().replace(/^graph\s+LR\b/, "flowchart LR");
    assert(/^flowchart\s+LR\b/.test(result.diagram), "diagram must use a left-to-right Mermaid flowchart");
    assert(!/```|%%\{|\bclick\b|\bhref\b|javascript:/i.test(result.diagram), "diagram contains unsupported Mermaid content");
  }
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
    "duplicateOf", "duplicateConfidence", "implementationRecommendation", "decision", "comment"
  ], "result");
  assert(result.mode === "issue", "mode must be issue");
  assertString(result.summary, "summary", { maxLength: LIMITS.summary });
  assertEnum(result.type, ["bug", "enhancement", "documentation", "question", "security", "maintenance"], "type");
  assertEnum(result.priority, ["p1", "p2", "p3"], "priority");
  const allowedIssueLabels = issueAllowedLabels(config);
  assertUniqueStrings(result.labels, "labels", {
    allowed: allowedIssueLabels,
    maximum: allowedIssueLabels.length
  });
  assert(typeof result.actionable === "boolean", "actionable must be boolean");
  assertUniqueStrings(result.missingInformation, "missingInformation", { maximum: 8, itemMaximum: 4000 });
  assert(result.duplicateOf === null || (Number.isInteger(result.duplicateOf) && result.duplicateOf > 0), "duplicateOf invalid");
  assertEnum(result.duplicateConfidence, ["none", "low", "medium", "high"], "duplicateConfidence");
  assertEnum(result.implementationRecommendation, ["no", "manual", "ai-ready"], "implementationRecommendation");
  assertExactKeys(result.decision, ["required", "question", "rationale", "options"], "decision");
  assert(typeof result.decision.required === "boolean", "decision.required must be boolean");
  assertString(result.decision.question, "decision.question", { allowEmpty: true, maxLength: LIMITS.summary });
  assertString(result.decision.rationale, "decision.rationale", { allowEmpty: true, maxLength: LIMITS.summary });
  assert(Array.isArray(result.decision.options) && result.decision.options.length <= 3, "decision.options is invalid");
  for (const [index, option] of result.decision.options.entries()) {
    assertExactKeys(option, ["label", "description", "recommended"], `decision.options[${index}]`);
    assertString(option.label, `decision.options[${index}].label`, { maxLength: LIMITS.title });
    assertString(option.description, `decision.options[${index}].description`, { maxLength: LIMITS.summary });
    assert(typeof option.recommended === "boolean", `decision.options[${index}].recommended must be boolean`);
  }
  if (result.decision.required) {
    assertString(result.decision.question, "decision.question", { maxLength: LIMITS.summary });
    assertString(result.decision.rationale, "decision.rationale", { maxLength: LIMITS.summary });
    assert(result.decision.options.length > 0, "a required decision needs options");
    assert(result.decision.options.filter((option) => option.recommended).length === 1, "a required decision needs one recommendation");
    assert(result.implementationRecommendation !== "ai-ready", "a required maintainer decision cannot be AI-ready");
  } else {
    assert(result.decision.question === "" && result.decision.rationale === "" && result.decision.options.length === 0, "an unused decision must be empty");
  }
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

export function validateFixResult(result, target) {
  if (result && typeof result === "object" && !Object.hasOwn(result, "resolvedReviewThreadIds")) result.resolvedReviewThreadIds = [];
  assertExactKeys(result, [
    "mode", "summary", "risk", "targetKind", "targetNumber", "changedSummary", "testsRun", "resolvedReviewThreadIds", "readyForReview", "noChangeReason"
  ], "result");
  assert(result.mode === "fix", "mode must be fix");
  assertString(result.summary, "summary", { maxLength: LIMITS.summary });
  assertEnum(result.risk, ["low", "medium", "high"], "risk");
  assertEnum(result.targetKind, ["issue", "pull_request"], "targetKind");
  assert(Number.isSafeInteger(result.targetNumber) && result.targetNumber > 0, "targetNumber must be a positive integer");
  if (target !== undefined) {
    assert(target && typeof target === "object" && !Array.isArray(target), "trusted target must be an object");
    assert(result.targetKind === target.kind, "targetKind does not match requested target");
    assert(result.targetNumber === target.number, "targetNumber does not match requested target");
  }
  assertString(result.changedSummary, "changedSummary", { allowEmpty: true, maxLength: LIMITS.body });
  assert(Array.isArray(result.testsRun), "testsRun must be an array");
  assert(result.testsRun.length <= 8, "testsRun has too many entries");
  for (const [index, test] of result.testsRun.entries()) {
    assertExactKeys(test, ["command", "result"], `testsRun[${index}]`);
    assertString(test.command, `testsRun[${index}].command`, { maxLength: LIMITS.command });
    assertString(test.result, `testsRun[${index}].result`, { maxLength: LIMITS.result });
    assert(
      !/^did not run(?:\b|:)/i.test(test.result.trim()),
      `testsRun[${index}].result must describe a command that actually ran`,
    );
  }
  assertUniqueStrings(result.resolvedReviewThreadIds, "resolvedReviewThreadIds", { maximum: 128, itemMaximum: LIMITS.key });
  const allowedReviewThreadIds = new Set(target?.reviewThreadIds ?? []);
  assert(
    result.resolvedReviewThreadIds.every((threadId) => allowedReviewThreadIds.has(threadId)),
    "resolvedReviewThreadIds contains a thread outside the frozen repair request"
  );
  if (result.resolvedReviewThreadIds.length > 0) {
    assert(result.targetKind === "pull_request", "only pull request repair can resolve review threads");
  }
  assert(typeof result.readyForReview === "boolean", "readyForReview must be boolean");
  assertNullableString(result.noChangeReason, "noChangeReason", LIMITS.body);
  if (result.noChangeReason !== null) {
    assert(!result.readyForReview, "no-change result cannot be ready for review");
  }
  return result;
}
