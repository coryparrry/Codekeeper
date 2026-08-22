import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../markers.mjs";
import { assertEnvelope, envelopeBytes, envelopeSha256, parseEnvelope } from "./envelope.mjs";

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_MANIFEST_FILE = "handoff.json";
export const HANDOFF_ENVELOPE_FILE = "envelope.json";
export const HANDOFF_KINDS = Object.freeze(["compute", "validation", "sealed"]);

const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*\u0000)(?!.*(?:^|\/)\.\.?\/?)(?!.*(?:^|\/)\.)[^/]+(?:\/[^/]+)*$/;
const MANIFEST_KEYS = ["schemaVersion", "kind", "state", "run", "envelopeSha256", "inventorySha256", "files"];
const RUN_KEYS = ["repository", "runId", "attempt"];
const FILE_KEYS = ["path", "bytes", "sha256"];
const KIND_STATES = Object.freeze({
  compute: ["compute-complete"],
  validation: ["validation-complete", "validation-not-required"],
  sealed: ["sealed"],
});
const DIGEST_PATHS = Object.freeze({
  modePlan: "mode-plan.json",
  policy: "policy.json",
  profile: "profile.json",
  context: "context.json",
  workspaceResult: "workspace-result.json",
  candidate: "candidate.json",
  validationReceipt: "validation-receipt.json",
});

function assertPlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${name} must be a plain object`);
  }
  return value;
}

function assertPlainArray(value, name) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${name} must be a plain array`);
  return value;
}

function exactObject(value, name, keys) {
  assertPlainObject(value, name);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) throw new Error(`${name} contains unexpected or missing properties`);
  return value;
}

function safeRelativePath(value, name = "Handoff path") {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || path.posix.normalize(value) !== value) {
    throw new Error(`${name} is unsafe`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment.startsWith("."))) throw new Error(`${name} is unsafe`);
  return value;
}

function canonical(value) {
  return `${JSON.stringify(value)}\n`;
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

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function assertHandoffRoot(directory) {
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("Handoff root must be a regular directory");
}

function inventoryDigest(files) {
  return sha256(Buffer.from(JSON.stringify(files), "utf8"));
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
}

function assertRun(run, envelope) {
  exactObject(run, "Handoff run", RUN_KEYS);
  if (JSON.stringify(run) !== JSON.stringify(envelope.run)) throw new Error("Handoff run does not match its envelope");
}

function expectedPayloadFiles(envelope) {
  const files = [HANDOFF_ENVELOPE_FILE];
  for (const [digestName, relativePath] of Object.entries(DIGEST_PATHS)) {
    if (envelope.digests[digestName] !== null) files.push(relativePath);
  }
  return files.sort();
}

function assertManifest(manifest, envelope) {
  exactObject(manifest, "Handoff manifest", MANIFEST_KEYS);
  if (manifest.schemaVersion !== HANDOFF_SCHEMA_VERSION) throw new Error("Unsupported handoff manifest schema version");
  if (!HANDOFF_KINDS.includes(manifest.kind)) throw new Error(`Unsupported handoff kind: ${manifest.kind}`);
  if (!KIND_STATES[manifest.kind].includes(manifest.state)) throw new Error(`Handoff kind ${manifest.kind} cannot carry state ${manifest.state}`);
  if (manifest.state !== envelope.state) throw new Error("Handoff state does not match its envelope");
  assertRun(manifest.run, envelope);
  assertDigest(manifest.envelopeSha256, "Handoff envelopeSha256");
  assertDigest(manifest.inventorySha256, "Handoff inventorySha256");
  assertPlainArray(manifest.files, "Handoff files");
  const seen = new Set();
  for (const [index, file] of manifest.files.entries()) {
    exactObject(file, `Handoff file ${index}`, FILE_KEYS);
    safeRelativePath(file.path, `Handoff file ${index} path`);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error(`Handoff file ${index} bytes must be a non-negative integer`);
    assertDigest(file.sha256, `Handoff file ${index} sha256`);
    if (seen.has(file.path)) throw new Error(`Handoff contains duplicate file: ${file.path}`);
    seen.add(file.path);
  }
  const paths = manifest.files.map((file) => file.path);
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort(comparePaths))) throw new Error("Handoff files must be sorted");
  if (!seen.has(HANDOFF_ENVELOPE_FILE)) throw new Error("Handoff is missing envelope.json");
  if (envelope.state === "validation-not-required" && seen.has(DIGEST_PATHS.validationReceipt)) {
    throw new Error("Validation receipt is forbidden when validation is not required");
  }
  if (envelope.state === "validation-complete" && !seen.has(DIGEST_PATHS.validationReceipt)) {
    throw new Error("Validation-complete handoff is missing validation-receipt.json");
  }
  return freezeClone(manifest);
}

async function walkDirectory(root, current = "") {
  const entries = [];
  const absolute = path.join(root, current);
  const children = await readdir(absolute, { withFileTypes: true });
  if (children.length === 0 && current !== "") throw new Error(`Handoff contains an unexpected empty directory: ${current}`);
  for (const child of children.sort((left, right) => comparePaths(left.name, right.name))) {
    const relative = current ? path.posix.join(current, child.name) : child.name;
    safeRelativePath(relative, "Handoff entry path");
    const absoluteChild = path.join(root, relative);
    if (child.isSymbolicLink()) throw new Error(`Handoff must not contain symlinks: ${relative}`);
    if (child.isDirectory()) {
      entries.push(...await walkDirectory(root, relative));
      continue;
    }
    if (!child.isFile()) throw new Error(`Handoff must contain only regular files: ${relative}`);
    const information = await lstat(absoluteChild);
    if (!information.isFile() || information.isSymbolicLink()) throw new Error(`Handoff file is not regular: ${relative}`);
    const bytes = await readFile(absoluteChild);
    entries.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return entries;
}

export async function collectHandoffInventory(directory) {
  await assertHandoffRoot(directory);
  const entries = await walkDirectory(directory);
  const manifestEntries = entries.filter(({ path: relativePath }) => relativePath !== HANDOFF_MANIFEST_FILE).sort((left, right) => comparePaths(left.path, right.path));
  return manifestEntries;
}

function normalizeFiles(files) {
  if (files === undefined) return [];
  if (Array.isArray(files)) return assertPlainArray(files, "Handoff file inputs").map((file) => {
    exactObject(file, "Handoff file input", ["path", "contents"]);
    return file;
  });
  assertPlainObject(files, "Handoff files");
  return Object.entries(files).map(([relativePath, contents]) => ({ path: relativePath, contents }));
}

async function fileContents(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("Handoff file contents must be bytes or text");
}

async function assertNoSymlinkParents(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink()) throw new Error(`Handoff payload parent is a symlink: ${relativePath}`);
      if (!information.isDirectory()) throw new Error(`Handoff payload parent is not a directory: ${relativePath}`);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
}

async function writePayloadFiles(directory, files) {
  const seen = new Set();
  for (const file of normalizeFiles(files)) {
    safeRelativePath(file.path, "Handoff file input path");
    if (file.path === HANDOFF_MANIFEST_FILE || file.path === HANDOFF_ENVELOPE_FILE) throw new Error(`Reserved handoff path: ${file.path}`);
    if (seen.has(file.path)) throw new Error(`Duplicate handoff file input: ${file.path}`);
    seen.add(file.path);
    await assertNoSymlinkParents(directory, file.path);
    const absolute = path.join(directory, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, await fileContents(file.contents), { flag: "wx" });
  }
}

function expectedFileSet(expectedFiles, envelope) {
  const values = expectedFiles ?? expectedPayloadFiles(envelope);
  assertPlainArray(values, "Expected handoff files");
  const normalized = values.map((value) => safeRelativePath(value, "Expected handoff path")).sort(comparePaths);
  if (new Set(normalized).size !== normalized.length) throw new Error("Expected handoff files contain duplicates");
  return normalized;
}

function assertDigestBindings(envelope, inventory) {
  for (const [digestName, relativePath] of Object.entries(DIGEST_PATHS)) {
    const expectedDigest = envelope.digests[digestName];
    const entry = inventory.find((file) => file.path === relativePath);
    if (expectedDigest === null && entry) throw new Error(`Handoff contains unexpected ${relativePath}`);
    if (expectedDigest !== null && (!entry || entry.sha256 !== expectedDigest)) throw new Error(`Handoff ${relativePath} is missing or stale`);
  }
}

function assertFileSet(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((item) => !actual.includes(item));
    const extra = actual.filter((item) => !expected.includes(item));
    throw new Error(`Handoff file inventory mismatch${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; unexpected: ${extra.join(", ")}` : ""}`);
  }
}

export async function createHandoff({ directory, envelope, kind, files = undefined, expectedFiles = undefined }) {
  const trustedEnvelope = assertEnvelope(envelope);
  if (!HANDOFF_KINDS.includes(kind) || !KIND_STATES[kind].includes(trustedEnvelope.state)) throw new Error(`Handoff kind ${kind} cannot carry state ${trustedEnvelope.state}`);
  await mkdir(directory, { recursive: true });
  await assertHandoffRoot(directory);
  const existing = await readdir(directory);
  if (existing.length > 0) throw new Error("Handoff directory must be empty before creation");
  await writeFile(path.join(directory, HANDOFF_ENVELOPE_FILE), envelopeBytes(trustedEnvelope), { flag: "wx" });
  await writePayloadFiles(directory, files);
  const inventory = await collectHandoffInventory(directory);
  assertFileSet(inventory.map((file) => file.path), expectedFileSet(expectedFiles, trustedEnvelope));
  assertDigestBindings(trustedEnvelope, inventory);
  const manifest = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    kind,
    state: trustedEnvelope.state,
    run: structuredClone(trustedEnvelope.run),
    envelopeSha256: envelopeSha256(trustedEnvelope),
    inventorySha256: inventoryDigest(inventory),
    files: inventory,
  };
  await writeFile(path.join(directory, HANDOFF_MANIFEST_FILE), Buffer.from(canonical(manifest), "utf8"), { flag: "wx" });
  const frozenManifest = freezeClone(manifest);
  return { manifest: frozenManifest, envelope: trustedEnvelope, envelopeSha256: manifest.envelopeSha256, inventorySha256: manifest.inventorySha256 };
}

function expectedEnvelopeMatch(actual, expected) {
  if (!expected) return;
  const expectedEnvelope = expected.envelope ?? expected;
  if (expectedEnvelope && JSON.stringify(actual) !== JSON.stringify(expectedEnvelope)) throw new Error("Handoff envelope does not match the trusted expected envelope");
}

export async function verifyHandoff(input, options = undefined) {
  const args = typeof input === "string" ? { directory: input, ...(options ?? {}) } : input;
  assertPlainObject(args, "Handoff verification options");
  if (typeof args.directory !== "string") throw new Error("Handoff directory is required");
  const directory = args.directory;
  await assertHandoffRoot(directory);
  const envelopePath = path.join(directory, HANDOFF_ENVELOPE_FILE);
  const manifestPath = path.join(directory, HANDOFF_MANIFEST_FILE);
  const envelopeInformation = await lstat(envelopePath);
  if (!envelopeInformation.isFile() || envelopeInformation.isSymbolicLink()) throw new Error("Handoff envelope must be a regular file");
  const envelopeBytesOnDisk = await readFile(envelopePath);
  const envelope = parseEnvelope(envelopeBytesOnDisk);
  if (Buffer.compare(envelopeBytesOnDisk, envelopeBytes(envelope)) !== 0) throw new Error("Envelope is not in canonical form");
  expectedEnvelopeMatch(envelope, args.expectedEnvelope ?? args.expected);
  const manifestInformation = await lstat(manifestPath);
  if (!manifestInformation.isFile() || manifestInformation.isSymbolicLink()) throw new Error("Handoff manifest must be a regular file");
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid handoff manifest JSON: ${error.message}`);
  }
  manifest = assertManifest(manifest, envelope);
  if (Buffer.compare(manifestBytes, Buffer.from(canonical(manifest), "utf8")) !== 0) throw new Error("Handoff manifest is not in canonical form");
  if (manifest.envelopeSha256 !== envelopeSha256(envelope)) throw new Error("Handoff envelope digest mismatch");
  const inventory = await collectHandoffInventory(directory);
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.files)) throw new Error("Handoff file digest or inventory mismatch");
  if (inventoryDigest(inventory) !== manifest.inventorySha256) throw new Error("Handoff inventory digest mismatch");
  assertFileSet(inventory.map((file) => file.path), expectedFileSet(args.expectedFiles, envelope));
  assertDigestBindings(envelope, manifest.files);
  if (args.expectedKind && manifest.kind !== args.expectedKind) throw new Error("Handoff kind does not match the trusted expected kind");
  if (args.expectedState && manifest.state !== args.expectedState) throw new Error("Handoff state does not match the trusted expected state");
  if (args.expectedRun && JSON.stringify(manifest.run) !== JSON.stringify(args.expectedRun)) throw new Error("Handoff run does not match the trusted run");
  if (args.expectedPackage && JSON.stringify(envelope.package) !== JSON.stringify(args.expectedPackage)) throw new Error("Handoff package identity does not match the trusted package");
  if (args.expectedSourceCommit && envelope.package.sourceCommit !== args.expectedSourceCommit) throw new Error("Handoff source commit does not match the trusted source");
  return { manifest, envelope, files: freezeClone(inventory), envelopeSha256: manifest.envelopeSha256, inventorySha256: manifest.inventorySha256 };
}

export function assertHandoffManifest(manifest, envelope) {
  return assertManifest(manifest, assertEnvelope(envelope));
}

export function handoffInventoryDigest(files) {
  assertPlainArray(files, "Handoff inventory");
  return inventoryDigest(files);
}

export const HANDOFF_DIGEST_PATHS = DIGEST_PATHS;
