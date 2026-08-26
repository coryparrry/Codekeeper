import path from "node:path";
import { sha256 } from "../markers.mjs";
const frozenWords = (value) => Object.freeze(value.split(" "));

export const LINEAGE_SCHEMA_VERSION = 1;
export const TRUSTED_INTENT_SOURCE_KINDS = frozenWords(
  "pr-body linked-issue accepted-thread repository-guidance architecture tests original-diff",
);
export const FINDING_STATUSES = frozenWords(
  "resolved unresolved regressed new",
);
export const LINEAGE_STATUSES = frozenWords(
  "unreviewed reviewed-clean reviewed-blocked awaiting-human repair-dispatched repair-validated rereview-resolved rereview-unresolved rereview-regressed stopped",
);
export const DECISION_CATEGORIES = frozenWords(
  "purpose-change behavior-change security data operations tradeoff",
);

const HEAD = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_ID = /^repair-attempt-[0-9a-f]{64}$/;
const MARKER = /<!-- codekeeper:review-lineage=v1:([A-Za-z0-9_-]+) -->/g;
const MAX_TEXT = 8192;
const MAX_ITEMS = 256;
const MAX_CONTRACT_BYTES = 48000;
const INTENT_KEYS = frozenWords(
  "goal acceptanceCriteria explicitDecisions nonGoals authorizedPaths authorizedEffects originalBaseSha originalHeadSha sourceRefs intentDigest",
);
const SOURCE_KEYS = frozenWords("kind ref digest author authority");
const FINDING_KEYS = frozenWords(
  "findingId fingerprint intentDigest firstHeadSha currentHeadSha status",
);
const ATTEMPT_KEYS = frozenWords(
  "attemptId findingId intentDigest firstHeadSha attemptNumber",
);
const STATE_KEYS = frozenWords(
  "schemaVersion intentDigest firstHeadSha currentHeadSha appOwnedThreadIds status findings evidenceAdded evidenceRetired attemptLinks stateDigest",
);

function invalid(message) {
  throw new TypeError(`Invalid PR lineage: ${message}`);
}

function plainObject(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid(`${name} must be a plain object`);
  return value;
}

function exact(value, keys, name) {
  plainObject(value, name);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    invalid(`${name} contains unexpected or missing properties`);
  }
}

function allowed(value, keys, name) {
  plainObject(value, name);
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${name} contains unexpected properties`);
  }
}

function boundedText(value, name, maximum = MAX_TEXT) {
  if (typeof value !== "string" || /\0/.test(value))
    invalid(`${name} must be bounded non-empty text`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum)
    invalid(`${name} must be bounded non-empty text`);
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedBytes(value, name) {
  if (Buffer.byteLength(canonical(value), "utf8") > MAX_CONTRACT_BYTES) {
    invalid(`${name} exceeds the contract size limit`);
  }
}

function boundedList(value, name, { empty = true, sort = false, normalize } = {}) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ITEMS ||
    (!empty && value.length === 0)
  ) {
    invalid(`${name} must be a bounded list`);
  }
  const normalizeItem =
    normalize ?? ((item, index) => boundedText(item, `${name}[${index}]`));
  const normalized = value.map((item, index) => normalizeItem(item, index));
  if (new Set(normalized).size !== normalized.length)
    invalid(`${name} contains duplicates`);
  const result = sort
    ? [...normalized].sort((left, right) => left.localeCompare(right))
    : normalized;
  boundedBytes(result, name);
  return result;
}

function commit(value, name) {
  if (typeof value !== "string" || !HEAD.test(value.toLowerCase())) {
    invalid(`${name} must be a full commit SHA`);
  }
  return value.toLowerCase();
}

function digest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value))
    invalid(`${name} must be a sha256 digest`);
  return value;
}

function digestOf(value) {
  return `sha256:${sha256(canonical(value))}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function repositoryPath(value, name) {
  const normalized = path.posix.normalize(
    boundedText(value, name).replaceAll("\\", "/"),
  );
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  )
    invalid(`${name} must be a safe repository-relative path`);
  return normalized;
}

function sourceRef(value, index, authorizedMaintainers) {
  exact(value, SOURCE_KEYS, `sourceRefs[${index}]`);
  if (!TRUSTED_INTENT_SOURCE_KINDS.includes(value.kind))
    invalid(`sourceRefs[${index}].kind is untrusted`);
  const acceptedThread = value.kind === "accepted-thread";
  const author =
    value.author === null
      ? null
      : boundedText(value.author, "source author", 256).toLowerCase();
  const authority =
    value.authority === null
      ? null
      : boundedText(value.authority, "source authority", 128);
  if (
    acceptedThread &&
    (!author || !["maintainer", "repository-owner"].includes(authority))
  ) {
    invalid(
      "accepted-thread provenance requires verified maintainer authority",
    );
  }
  if (
    acceptedThread &&
    (!Array.isArray(authorizedMaintainers) ||
      !authorizedMaintainers.some(
        (login) => String(login).trim().toLowerCase() === author,
      ))
  ) {
    invalid("accepted-thread author is not an authorized maintainer");
  }
  if (!acceptedThread && (author !== null || authority !== null)) {
    invalid("only accepted-thread provenance may carry human authority");
  }
  return {
    kind: value.kind,
    ref: boundedText(value.ref, "source ref", 2048),
    digest: digest(value.digest, "source digest"),
    author,
    authority,
  };
}

function intentPayload(
  input,
  { authorizedMaintainers, verifyAuthors = false } = {},
) {
  plainObject(input, "intent input");
  if (
    !Array.isArray(input.sourceRefs) ||
    input.sourceRefs.length === 0 ||
    input.sourceRefs.length > MAX_ITEMS
  ) {
    invalid("sourceRefs must be a bounded non-empty list");
  }
  const sources = input.sourceRefs
    .map((value, index) =>
      sourceRef(
        value,
        index,
        verifyAuthors ? authorizedMaintainers : [value.author],
      ),
    )
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  if (new Set(sources.map(canonical)).size !== sources.length)
    invalid("sourceRefs contains duplicates");
  const payload = {
    goal: boundedText(input.goal, "goal"),
    acceptanceCriteria: boundedList(
      input.acceptanceCriteria,
      "acceptanceCriteria",
    ),
    explicitDecisions: boundedList(
      input.explicitDecisions,
      "explicitDecisions",
    ),
    nonGoals: boundedList(input.nonGoals, "nonGoals"),
    authorizedPaths: boundedList(input.authorizedPaths, "authorizedPaths", {
      sort: true,
      normalize: (item, index) =>
        repositoryPath(item, `authorizedPaths[${index}]`),
    }),
    authorizedEffects: boundedList(
      input.authorizedEffects,
      "authorizedEffects",
      { sort: true },
    ),
    originalBaseSha: commit(input.originalBaseSha, "originalBaseSha"),
    originalHeadSha: commit(input.originalHeadSha, "originalHeadSha"),
    sourceRefs: sources,
  };
  boundedBytes(payload, "frozen intent");
  return payload;
}

export function freezeIntent(input, { authorizedMaintainers = [] } = {}) {
  const payload = intentPayload(input, {
    authorizedMaintainers,
    verifyAuthors: true,
  });
  return deepFreeze({ ...payload, intentDigest: digestOf(payload) });
}

export function assertFrozenIntent(intent) {
  exact(intent, INTENT_KEYS, "frozen intent");
  const payload = intentPayload(intent);
  if (intent.intentDigest !== digestOf(payload))
    invalid("intent digest does not match contents");
  return deepFreeze({ ...payload, intentDigest: intent.intentDigest });
}

export function assertIntentPreserved(original, replacement) {
  const frozen = assertFrozenIntent(original);
  const candidate = assertFrozenIntent(replacement);
  if (candidate.intentDigest !== frozen.intentDigest) {
    invalid("replacement changes frozen intent");
  }
  return frozen;
}

function boundIntentDigest(value) {
  return typeof value === "string"
    ? digest(value, "intentDigest")
    : assertFrozenIntent(value).intentDigest;
}

export function findingFingerprint({
  rootCause,
  owningPath,
  behavior,
  intent,
  intentDigest,
}) {
  return digestOf({
    version: 1,
    rootCause: boundedText(rootCause, "rootCause").toLowerCase(),
    owningPath: repositoryPath(owningPath, "owningPath"),
    behavior: boundedText(behavior, "behavior").toLowerCase(),
    intentDigest: boundIntentDigest(intent ?? intentDigest),
  });
}

export function createFindingLineage({
  rootCause,
  owningPath,
  behavior,
  intent,
  intentDigest,
  firstHeadSha,
  currentHeadSha = firstHeadSha,
  status = "new",
}) {
  if (!FINDING_STATUSES.includes(status)) invalid("finding status is invalid");
  const resolvedDigest = boundIntentDigest(intent ?? intentDigest);
  const fingerprint = findingFingerprint({
    rootCause,
    owningPath,
    behavior,
    intentDigest: resolvedDigest,
  });
  return deepFreeze({
    findingId: `finding-${fingerprint.slice(7)}`,
    fingerprint,
    intentDigest: resolvedDigest,
    firstHeadSha: commit(firstHeadSha, "finding firstHeadSha"),
    currentHeadSha: commit(currentHeadSha, "finding currentHeadSha"),
    status,
  });
}

export function assertFindingLineage(finding) {
  exact(finding, FINDING_KEYS, "finding lineage");
  digest(finding.fingerprint, "finding fingerprint");
  digest(finding.intentDigest, "finding intentDigest");
  if (finding.findingId !== `finding-${finding.fingerprint.slice(7)}`)
    invalid("finding ID is forged");
  commit(finding.firstHeadSha, "finding firstHeadSha");
  commit(finding.currentHeadSha, "finding currentHeadSha");
  if (!FINDING_STATUSES.includes(finding.status))
    invalid("finding status is invalid");
  return deepFreeze(structuredClone(finding));
}

export function repairAttemptId({
  findingId,
  intentDigest,
  firstHeadSha,
  attemptNumber,
}) {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1)
    invalid("attemptNumber must be positive");
  return `repair-attempt-${sha256(
    canonical({
      version: 1,
      findingId: boundedText(findingId, "findingId", 256),
      intentDigest: boundIntentDigest(intentDigest),
      firstHeadSha: commit(firstHeadSha, "attempt firstHeadSha"),
      attemptNumber,
    }),
  )}`;
}

export function createRepairAttempt({
  findingId,
  intent,
  intentDigest,
  firstHeadSha,
  attemptNumber = 1,
}) {
  const payload = {
    findingId: boundedText(findingId, "findingId", 256),
    intentDigest: boundIntentDigest(intent ?? intentDigest),
    firstHeadSha: commit(firstHeadSha, "attempt firstHeadSha"),
    attemptNumber,
  };
  return deepFreeze({ attemptId: repairAttemptId(payload), ...payload });
}

function assertRepairAttempt(attempt) {
  exact(attempt, ATTEMPT_KEYS, "repair attempt");
  if (!ATTEMPT_ID.test(attempt.attemptId)) invalid("attempt ID is invalid");
  if (attempt.attemptId !== repairAttemptId(attempt))
    invalid("attempt ID is forged");
  return deepFreeze(structuredClone(attempt));
}

function uniqueBy(values, key, name) {
  if (new Set(values.map((value) => value[key])).size !== values.length)
    invalid(`${name} contains duplicates`);
}

function statePayload(input) {
  return {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    intentDigest: input.intentDigest,
    firstHeadSha: input.firstHeadSha,
    currentHeadSha: input.currentHeadSha,
    appOwnedThreadIds: input.appOwnedThreadIds,
    status: input.status,
    findings: input.findings,
    evidenceAdded: input.evidenceAdded,
    evidenceRetired: input.evidenceRetired,
    attemptLinks: input.attemptLinks,
  };
}

function buildState(input) {
  const payload = statePayload(input);
  boundedBytes(payload, "lineage state");
  return deepFreeze({ ...payload, stateDigest: digestOf(payload) });
}

function validatedStateParts(input) {
  if (!Array.isArray(input.findings) || !Array.isArray(input.attemptLinks))
    invalid("state ledgers must be arrays");
  const findings = input.findings.map(assertFindingLineage);
  uniqueBy(findings, "findingId", "findings");
  for (const finding of findings) {
    if (finding.intentDigest !== input.intentDigest)
      invalid("finding intent is not bound to state");
    if (finding.currentHeadSha !== input.currentHeadSha)
      invalid("finding head is not current");
  }
  const attemptLinks = input.attemptLinks.map(assertRepairAttempt);
  uniqueBy(attemptLinks, "attemptId", "attemptLinks");
  for (const attempt of attemptLinks) {
    if (attempt.intentDigest !== input.intentDigest)
      invalid("attempt intent is not bound to state");
    if (!findings.some(({ findingId }) => findingId === attempt.findingId))
      invalid("attempt finding is unknown");
  }
  const evidenceAdded = boundedList(input.evidenceAdded, "evidenceAdded", {
    sort: true,
  });
  const evidenceRetired = boundedList(
    input.evidenceRetired,
    "evidenceRetired",
    { sort: true },
  );
  if (evidenceAdded.some((item) => evidenceRetired.includes(item))) {
    invalid("evidence cannot be added and retired at the same head");
  }
  return { findings, attemptLinks, evidenceAdded, evidenceRetired };
}

export function createLineageState({
  intent,
  currentHeadSha,
  appOwnedThreadIds = [],
  status = "unreviewed",
  findings = [],
  evidenceAdded = [],
  evidenceRetired = [],
  attemptLinks = [],
}) {
  const frozenIntent = assertFrozenIntent(intent);
  const currentHead = commit(
    currentHeadSha ?? frozenIntent.originalHeadSha,
    "currentHeadSha",
  );
  if (currentHead !== frozenIntent.originalHeadSha)
    invalid("initial lineage head must equal the frozen intent head");
  if (!LINEAGE_STATUSES.includes(status)) invalid("lineage status is invalid");
  const base = {
    intentDigest: frozenIntent.intentDigest,
    firstHeadSha: frozenIntent.originalHeadSha,
    currentHeadSha: currentHead,
    appOwnedThreadIds: boundedList(appOwnedThreadIds, "appOwnedThreadIds", {
      sort: true,
    }),
    status,
    findings,
    evidenceAdded,
    evidenceRetired,
    attemptLinks,
  };
  const parts = validatedStateParts(base);
  const children = [...parts.findings, ...parts.attemptLinks];
  if (
    children.some(
      ({ firstHeadSha }) => firstHeadSha !== frozenIntent.originalHeadSha,
    )
  ) {
    invalid("initial lineage children must bind the frozen intent head");
  }
  return buildState({ ...base, ...parts });
}

export function assertLineageState(state, { intent, currentHeadSha } = {}) {
  exact(state, STATE_KEYS, "lineage state");
  if (state.schemaVersion !== LINEAGE_SCHEMA_VERSION)
    invalid("unsupported lineage schema version");
  const firstHeadSha = commit(state.firstHeadSha, "state firstHeadSha");
  const currentHead = commit(state.currentHeadSha, "state currentHeadSha");
  const intentDigest = digest(state.intentDigest, "state intentDigest");
  if (intent) {
    const frozenIntent = assertFrozenIntent(intent);
    if (intentDigest !== frozenIntent.intentDigest)
      invalid("lineage intent is stale");
    if (firstHeadSha !== frozenIntent.originalHeadSha)
      invalid("lineage first head is not bound to intent");
  }
  if (
    currentHeadSha &&
    currentHead !== commit(currentHeadSha, "currentHeadSha")
  )
    invalid("lineage head is stale");
  if (!LINEAGE_STATUSES.includes(state.status))
    invalid("lineage status is invalid");
  const base = {
    intentDigest,
    firstHeadSha,
    currentHeadSha: currentHead,
    appOwnedThreadIds: boundedList(
      state.appOwnedThreadIds,
      "appOwnedThreadIds",
      { sort: true },
    ),
    status: state.status,
    findings: state.findings,
    evidenceAdded: state.evidenceAdded,
    evidenceRetired: state.evidenceRetired,
    attemptLinks: state.attemptLinks,
  };
  const normalized = buildState({ ...base, ...validatedStateParts(base) });
  if (state.stateDigest !== normalized.stateDigest)
    invalid("lineage state digest is forged");
  return normalized;
}

export function advanceLineageState(state, transition = {}) {
  allowed(
    transition,
    [
      "currentHeadSha",
      "status",
      "findingUpdates",
      "newFindings",
      "newAttempts",
      "appOwnedThreadIds",
      "evidenceAdded",
      "evidenceRetired",
    ],
    "lineage transition",
  );
  const {
    currentHeadSha,
    status = state?.status,
    findingUpdates = [],
    newFindings = [],
    newAttempts = [],
    appOwnedThreadIds = [],
    evidenceAdded = [],
    evidenceRetired = [],
  } = transition;
  const prior = assertLineageState(state);
  const nextHead = commit(currentHeadSha, "currentHeadSha");
  if (!LINEAGE_STATUSES.includes(status)) invalid("lineage status is invalid");
  const updates = new Map();
  for (const [index, update] of findingUpdates.entries()) {
    exact(update, ["findingId", "status"], `findingUpdates[${index}]`);
    if (updates.has(update.findingId))
      invalid("findingUpdates contains duplicates");
    if (!FINDING_STATUSES.includes(update.status))
      invalid("finding status is invalid");
    updates.set(update.findingId, update.status);
  }
  const findings = prior.findings.map((finding) => ({
    ...finding,
    currentHeadSha: nextHead,
    status: updates.get(finding.findingId) ?? finding.status,
  }));
  if (
    [...updates.keys()].some(
      (id) => !findings.some(({ findingId }) => findingId === id),
    )
  ) {
    invalid("finding update references unknown lineage");
  }
  for (const finding of newFindings.map(assertFindingLineage)) {
    if (
      finding.intentDigest !== prior.intentDigest ||
      finding.firstHeadSha !== nextHead ||
      finding.currentHeadSha !== nextHead
    )
      invalid("new finding is not bound to the current lineage head");
    findings.push(finding);
  }
  uniqueBy(findings, "findingId", "findings");
  const attempts = [...prior.attemptLinks];
  for (const attempt of newAttempts.map(assertRepairAttempt)) {
    if (
      attempt.intentDigest !== prior.intentDigest ||
      attempt.firstHeadSha !== nextHead
    ) {
      invalid("new attempt is not bound to the current lineage head");
    }
    attempts.push(attempt);
  }
  uniqueBy(attempts, "attemptId", "attemptLinks");
  const base = {
    intentDigest: prior.intentDigest,
    firstHeadSha: prior.firstHeadSha,
    currentHeadSha: nextHead,
    appOwnedThreadIds: boundedList(
      [...prior.appOwnedThreadIds, ...appOwnedThreadIds],
      "appOwnedThreadIds",
      { sort: true },
    ),
    status,
    findings,
    evidenceAdded,
    evidenceRetired,
    attemptLinks: attempts,
  };
  return buildState({ ...base, ...validatedStateParts(base) });
}

export function serializeLineageState(state, options = {}) {
  return `${canonical(assertLineageState(state, options))}\n`;
}

function normalizedAppIdentity(value) {
  plainObject(value, "App identity");
  return {
    login: boundedText(value.login, "App login", 256).toLowerCase(),
    id: boundedText(value.id, "App ID", 64),
  };
}

function isAppOwned(comment, expected) {
  const author = comment?.user ?? comment?.author;
  return (
    String(author?.login ?? "").toLowerCase() === expected.login &&
    String(author?.id ?? author?.databaseId ?? "") === expected.id &&
    String(author?.type ?? "") === "Bot"
  );
}

export function lineageStateMarker(state, options = {}) {
  const encoded = Buffer.from(
    serializeLineageState(state, options),
    "utf8",
  ).toString("base64url");
  return `<!-- codekeeper:review-lineage=v1:${encoded} -->`;
}

export function parseLineageStateMarker(
  comment,
  { appIdentity, intent, currentHeadSha } = {},
) {
  const frozenIntent = assertFrozenIntent(intent);
  const expectedHead = commit(currentHeadSha, "currentHeadSha");
  const expected = normalizedAppIdentity(appIdentity);
  if (!isAppOwned(comment, expected))
    invalid("lineage marker is not App-owned");
  const body = String(comment?.body ?? "");
  const matches = [...body.matchAll(MARKER)];
  if (matches.length !== 1 || !body.trimEnd().endsWith(matches[0][0])) {
    invalid("lineage marker is missing, duplicated, or not terminal");
  }
  let serialized;
  let parsed;
  try {
    serialized = Buffer.from(matches[0][1], "base64url").toString("utf8");
    parsed = JSON.parse(serialized);
  } catch {
    invalid("lineage marker state is invalid");
  }
  const state = assertLineageState(parsed, {
    intent: frozenIntent,
    currentHeadSha: expectedHead,
  });
  if (serialized !== `${canonical(state)}\n`) {
    invalid("lineage marker state is not canonical");
  }
  return state;
}

export function decisionFingerprint({
  category,
  question,
  intent,
  intentDigest,
}) {
  if (!DECISION_CATEGORIES.includes(category))
    invalid("decision category is invalid");
  return digestOf({
    version: 1,
    category,
    question: boundedText(question, "decision question").toLowerCase(),
    intentDigest: boundIntentDigest(intent ?? intentDigest),
  });
}

export function createDecisionIdentity(input) {
  const fingerprint = decisionFingerprint(input);
  return deepFreeze({
    decisionId: `decision-${fingerprint.slice(7)}`,
    decisionFingerprint: fingerprint,
  });
}

function authorityFor(author, authorizedAuthors) {
  if (!Array.isArray(authorizedAuthors) || authorizedAuthors.length === 0) {
    invalid("authorized decision authors are required");
  }
  const login = author.toLowerCase();
  const match = authorizedAuthors.find(
    (entry) => String(entry?.login ?? entry).toLowerCase() === login,
  );
  if (!match) return null;
  return typeof match === "object"
    ? boundedText(match.authority, "author authority", 128)
    : "maintainer";
}

function authorizedDecisionAuthor(author, authorizedAuthors, appIdentity) {
  const expected = normalizedAppIdentity(appIdentity);
  const login = boundedText(author, "decision author", 256).toLowerCase();
  if (login === expected.login)
    invalid("App-authored decision is not authorized");
  const authority = authorityFor(login, authorizedAuthors);
  if (!authority) invalid("decision author is not authorized");
  return { login, authority };
}

export function bindHumanDecision({
  decision,
  decisionFingerprint: suppliedFingerprint,
  author,
  response,
  currentHeadSha,
  authorizedAuthors,
  appIdentity,
}) {
  const { login, authority } = authorizedDecisionAuthor(
    author,
    authorizedAuthors,
    appIdentity,
  );
  const fingerprint = digest(
    suppliedFingerprint ?? decision?.decisionFingerprint,
    "decisionFingerprint",
  );
  return deepFreeze({
    decisionFingerprint: fingerprint,
    author: login,
    authorAuthority: authority,
    response: boundedText(response, "decision response"),
    currentHeadSha: commit(currentHeadSha, "currentHeadSha"),
  });
}

export function assertHumanDecision(
  binding,
  {
    decision,
    decisionFingerprint: suppliedFingerprint,
    currentHeadSha,
    authorizedAuthors,
    appIdentity,
  } = {},
) {
  exact(
    binding,
    [
      "decisionFingerprint",
      "author",
      "authorAuthority",
      "response",
      "currentHeadSha",
    ],
    "human decision",
  );
  const { authority } = authorizedDecisionAuthor(
    binding.author,
    authorizedAuthors,
    appIdentity,
  );
  const fingerprint = digest(
    suppliedFingerprint ?? decision?.decisionFingerprint,
    "decisionFingerprint",
  );
  if (binding.decisionFingerprint !== fingerprint)
    invalid("decision fingerprint is stale");
  if (binding.authorAuthority !== authority)
    invalid("decision author authority is stale");
  if (
    commit(binding.currentHeadSha, "decision currentHeadSha") !==
    commit(currentHeadSha, "currentHeadSha")
  ) {
    invalid("decision answer is bound to a stale head");
  }
  boundedText(binding.response, "decision response");
  return deepFreeze(structuredClone(binding));
}
