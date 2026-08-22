import { sha256 } from "../markers.mjs";

export const ENVELOPE_SCHEMA_VERSION = 1;
export const ENVELOPE_STATES = Object.freeze([
  "created",
  "compute-complete",
  "validation-complete",
  "validation-not-required",
  "sealed",
  "published",
]);

const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PACKAGE_NAME = "@coryparry/codekeeper";
const PACKAGE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MODE = /^[a-z][a-z0-9-]{0,31}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/;
const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUESTED_BY = /^[^\u0000\r\n]{1,256}$/;

const ENVELOPE_KEYS = [
  "schemaVersion",
  "state",
  "mode",
  "run",
  "package",
  "request",
  "repository",
  "digests",
];
const RUN_KEYS = ["repository", "runId", "attempt"];
const PACKAGE_KEYS = ["name", "version", "integrity", "sourceCommit"];
const REQUEST_KEYS = ["eventName", "targetNumber", "requestedBy"];
const REPOSITORY_KEYS = ["defaultBranch", "baseSha", "headSha"];
const DIGEST_KEYS = [
  "modePlan",
  "policy",
  "profile",
  "context",
  "workspaceResult",
  "candidate",
  "validationReceipt",
];
const CORE_DIGEST_KEYS = [
  "modePlan",
  "policy",
  "profile",
  "context",
  "workspaceResult",
  "candidate",
];
const IMMUTABLE_KEYS = [
  "schemaVersion",
  "mode",
  "run",
  "package",
  "request",
  "repository",
];
const ENVELOPE_SCHEMA_ORDER = {
  keys: ENVELOPE_KEYS,
  children: {
    run: { keys: RUN_KEYS },
    package: { keys: PACKAGE_KEYS },
    request: { keys: REQUEST_KEYS },
    repository: { keys: REPOSITORY_KEYS },
    digests: { keys: DIGEST_KEYS },
  },
};

function assertPlainObject(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${name} must be a plain object`);
  }
  return value;
}

function exactObject(value, name, keys) {
  assertPlainObject(value, name);
  const expected = new Set(keys);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw new Error(`${name} contains unexpected or missing properties`);
  }
  return value;
}

function stringValue(value, name, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000")
  ) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value))
    throw new Error(`${name} has an invalid value`);
  return value;
}

function digestValue(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new Error(`${name} must be a SHA-256 digest`);
  return value;
}

function assertTargetNumber(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Request targetNumber must be a positive integer or null");
  }
}

function assertCommit(value, name, nullable = false) {
  if (nullable && value === null) return null;
  stringValue(value, name);
  if (!COMMIT.test(value)) throw new Error(`${name} must be a full commit SHA`);
  return value;
}

function orderedClone(value, schema = undefined) {
  if (Array.isArray(value))
    return value.map((item) => orderedClone(item, schema?.item));
  if (value && typeof value === "object") {
    const keys = schema?.keys ?? Object.keys(value).sort();
    const ordered = {};
    for (const key of keys) {
      if (Object.hasOwn(value, key))
        ordered[key] = orderedClone(value[key], schema?.children?.[key]);
    }
    return ordered;
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(orderedClone(value, ENVELOPE_SCHEMA_ORDER))}\n`;
}

function deeplyFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deeplyFreeze(child);
  }
  return value;
}

function freezeClone(value) {
  return deeplyFreeze(structuredClone(value));
}

function validateEnvelope(value) {
  exactObject(value, "Run envelope", ENVELOPE_KEYS);
  if (value.schemaVersion !== ENVELOPE_SCHEMA_VERSION)
    throw new Error("Unsupported run envelope schema version");
  if (!ENVELOPE_STATES.includes(value.state))
    throw new Error(`Unsupported run envelope state: ${value.state}`);
  stringValue(value.mode, "Envelope mode", MODE);

  exactObject(value.run, "Envelope run", RUN_KEYS);
  stringValue(value.run.repository, "Run repository", REPOSITORY);
  stringValue(value.run.runId, "Run ID", RUN_ID);
  if (!Number.isSafeInteger(value.run.attempt) || value.run.attempt < 1)
    throw new Error("Run attempt must be a positive integer");
  exactObject(value.package, "Envelope package", PACKAGE_KEYS);
  if (value.package.name !== PACKAGE_NAME)
    throw new Error(`Envelope package must be ${PACKAGE_NAME}`);
  stringValue(value.package.version, "Package version", PACKAGE_VERSION);
  stringValue(value.package.integrity, "Package integrity");
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(value.package.integrity))
    throw new Error("Package integrity must be a SHA-512 integrity value");
  assertCommit(value.package.sourceCommit, "Package sourceCommit");

  exactObject(value.request, "Envelope request", REQUEST_KEYS);
  stringValue(value.request.eventName, "Request eventName", EVENT_NAME);
  assertTargetNumber(value.request.targetNumber);
  stringValue(value.request.requestedBy, "Request requestedBy", REQUESTED_BY);

  exactObject(value.repository, "Envelope repository", REPOSITORY_KEYS);
  stringValue(
    value.repository.defaultBranch,
    "Repository defaultBranch",
    BRANCH,
  );
  assertCommit(value.repository.baseSha, "Repository baseSha");
  assertCommit(value.repository.headSha, "Repository headSha", true);

  exactObject(value.digests, "Envelope digests", DIGEST_KEYS);
  for (const key of DIGEST_KEYS)
    digestValue(value.digests[key], `Envelope digest ${key}`, true);
  if (value.state === "created") {
    for (const key of ["modePlan", "policy", "profile", "context"]) {
      if (!value.digests[key])
        throw new Error(`Created envelope requires ${key}`);
    }
    for (const key of ["workspaceResult", "candidate", "validationReceipt"]) {
      if (value.digests[key] !== null)
        throw new Error(`Created envelope cannot contain ${key}`);
    }
  }
  if (value.state !== "created") {
    for (const key of CORE_DIGEST_KEYS) {
      if (!value.digests[key])
        throw new Error(`${value.state} envelope requires ${key}`);
    }
  }
  if (value.state === "compute-complete") {
    if (value.digests.validationReceipt !== null)
      throw new Error(
        "Compute-complete envelope cannot contain a validation receipt",
      );
  }
  if (
    value.state === "validation-not-required" &&
    value.digests.validationReceipt !== null
  ) {
    throw new Error(
      "Validation-not-required envelope cannot contain a validation receipt",
    );
  }
  if (
    value.state === "validation-complete" &&
    !value.digests.validationReceipt
  ) {
    throw new Error(
      "Validation-complete envelope requires a validation receipt",
    );
  }
  if (
    ["sealed", "published"].includes(value.state) &&
    !value.digests.candidate
  ) {
    throw new Error(`${value.state} envelope requires a candidate digest`);
  }
  return value;
}

export function assertEnvelope(value) {
  return freezeClone(validateEnvelope(value));
}

export function parseEnvelope(value) {
  const rawBytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid run envelope JSON: ${error.message}`);
  }
  const envelope = assertEnvelope(parsed);
  if (Buffer.compare(rawBytes, envelopeBytes(envelope)) !== 0)
    throw new Error("Run envelope is not in canonical schema order");
  return envelope;
}

export function envelopeBytes(envelope) {
  assertEnvelope(envelope);
  return Buffer.from(canonicalJson(envelope), "utf8");
}

export function envelopeSha256(envelope) {
  return sha256(envelopeBytes(envelope));
}

export function createEnvelope(input) {
  assertPlainObject(input, "Envelope input");
  if (Object.hasOwn(input, "state") || Object.hasOwn(input, "schemaVersion")) {
    throw new Error("Envelope input cannot override state or schemaVersion");
  }
  const { digests = {}, ...rest } = input;
  assertPlainObject(digests, "Envelope input digests");
  if (Reflect.ownKeys(digests).some((key) => !DIGEST_KEYS.includes(key)))
    throw new Error("Envelope input digests contain an unknown property");
  const envelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    state: "created",
    ...rest,
    digests: {
      modePlan: digests.modePlan ?? null,
      policy: digests.policy ?? null,
      profile: digests.profile ?? null,
      context: digests.context ?? null,
      workspaceResult: digests.workspaceResult ?? null,
      candidate: digests.candidate ?? null,
      validationReceipt: digests.validationReceipt ?? null,
    },
  };
  return assertEnvelope(envelope);
}

function assertImmutable(previous, next) {
  for (const key of IMMUTABLE_KEYS) {
    if (
      JSON.stringify(orderedClone(previous[key])) !==
      JSON.stringify(orderedClone(next[key]))
    )
      throw new Error(`Envelope ${key} changed during transition`);
  }
}

const TRANSITIONS = Object.freeze({
  created: ["compute-complete"],
  "compute-complete": ["validation-complete", "validation-not-required"],
  "validation-complete": ["sealed"],
  "validation-not-required": ["sealed"],
  sealed: ["published"],
  published: [],
});

const TRANSITION_DIGEST_KEYS = Object.freeze({
  "created->compute-complete": Object.freeze(["workspaceResult", "candidate"]),
  "compute-complete->validation-complete": Object.freeze(["validationReceipt"]),
  "compute-complete->validation-not-required": Object.freeze([]),
  "validation-complete->sealed": Object.freeze([]),
  "validation-not-required->sealed": Object.freeze([]),
  "sealed->published": Object.freeze([]),
});

export function allowedEnvelopeTransitions(state) {
  if (!ENVELOPE_STATES.includes(state))
    throw new Error(`Unsupported run envelope state: ${state}`);
  return [...TRANSITIONS[state]];
}

export function advanceEnvelope(envelope, nextState, updates = {}) {
  const previous = assertEnvelope(envelope);
  if (!allowedEnvelopeTransitions(previous.state).includes(nextState)) {
    throw new Error(
      `Invalid run envelope transition: ${previous.state} -> ${nextState}`,
    );
  }
  assertPlainObject(updates, "Envelope transition updates");
  const suppliedKeys = Reflect.ownKeys(updates);
  if (
    suppliedKeys.some((key) => !["digests", "validationRequired"].includes(key))
  )
    throw new Error("Envelope transition contains an unknown property");
  if (
    previous.state === "compute-complete" &&
    !Object.hasOwn(updates, "validationRequired")
  ) {
    throw new Error("Compute transition requires explicit validationRequired");
  }
  if (
    Object.hasOwn(updates, "validationRequired") &&
    typeof updates.validationRequired !== "boolean"
  ) {
    throw new Error("validationRequired must be a boolean");
  }
  if (
    previous.state === "compute-complete" &&
    updates.validationRequired !== (nextState === "validation-complete")
  ) {
    throw new Error(
      "validationRequired does not match the requested validation state",
    );
  }
  if (
    previous.state !== "compute-complete" &&
    Object.hasOwn(updates, "validationRequired")
  ) {
    throw new Error(
      "validationRequired is only valid for the compute transition",
    );
  }
  const suppliedDigests = Object.hasOwn(updates, "digests")
    ? updates.digests
    : {};
  assertPlainObject(suppliedDigests, "Envelope transition digests");
  if (
    Reflect.ownKeys(suppliedDigests).some((key) => !DIGEST_KEYS.includes(key))
  ) {
    throw new Error("Envelope transition contains an unknown digest");
  }
  const transitionKey = `${previous.state}->${nextState}`;
  const allowedDigestKeys = TRANSITION_DIGEST_KEYS[transitionKey] ?? [];
  if (
    Reflect.ownKeys(suppliedDigests).some(
      (key) => !allowedDigestKeys.includes(key),
    )
  ) {
    throw new Error(
      `Envelope transition ${transitionKey} does not allow digest ${Reflect.ownKeys(suppliedDigests).find((key) => !allowedDigestKeys.includes(key))}`,
    );
  }
  for (const [key, value] of Object.entries(suppliedDigests)) {
    if (previous.digests[key] !== null && value !== previous.digests[key]) {
      throw new Error(`Envelope digest ${key} changed during transition`);
    }
  }
  const next = {
    ...previous,
    state: nextState,
    digests: { ...previous.digests, ...suppliedDigests },
  };
  assertImmutable(previous, next);
  return assertEnvelope(next);
}

export const RUN_ENVELOPE_PACKAGE_NAME = PACKAGE_NAME;
