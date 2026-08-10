import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCENARIOS = new Set([
  "maintenance-dry-run",
  "review-introduced-defect",
  "issue-triage-related",
  "controlled-fix"
]);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const DISPATCH_REF = /^codekeeper-acceptance\/dispatch-[a-z0-9-]+-[0-9a-f]{12}-[0-9a-f-]{36}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_REPOSITORY_LENGTH = 140;
const MAX_URL_LENGTH = 2048;
const MAX_SERIALIZED_EVIDENCE_BYTES = 4 * 1024;

export class EvidenceError extends Error {}

function assert(condition, message) {
  if (!condition) throw new EvidenceError(message);
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} has unsupported fields`);
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === "string"
      && value.length > 0
      && value.length <= MAX_URL_LENGTH
      && url.protocol === "https:"
      && url.hostname === "github.com"
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function validRepository(value) {
  if (typeof value !== "string" || value.length > MAX_REPOSITORY_LENGTH || !REPOSITORY.test(value)) return false;
  const [owner, name] = value.split("/");
  return owner.length <= 39 && name.length <= 100;
}

function serializedEvidenceBytes(evidence) {
  try {
    return Buffer.byteLength(JSON.stringify(evidence), "utf8");
  } catch {
    throw new EvidenceError("evidence is not safely serializable");
  }
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertNoSymlinkComponents(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const entry = await lstat(current);
    assert(!entry.isSymbolicLink(), `${label} must not contain symbolic-link components`);
  }
}

async function canonicalExistingDirectory(target, label) {
  const resolved = path.resolve(target);
  const entry = await lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") throw new EvidenceError(`${label} must already exist`);
    throw error;
  });
  await assertNoSymlinkComponents(resolved, label);
  assert(entry.isDirectory(), `${label} must be a directory`);
  return { raw: resolved, canonical: await realpath(resolved) };
}

async function outputDoesNotExist(output) {
  try {
    await lstat(output);
    throw new EvidenceError("Evidence path already exists; refusing to overwrite local evidence");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function prepareEvidenceDestination({ evidencePath, fixtureCheckout }) {
  assert(typeof evidencePath === "string" && evidencePath.length > 0, "Evidence path is required");
  assert(typeof fixtureCheckout === "string" && fixtureCheckout.length > 0, "Fixture checkout path is required");
  const output = path.resolve(evidencePath);
  assert(path.extname(output) === ".json", "Evidence path must end in .json");
  const fixture = await canonicalExistingDirectory(fixtureCheckout, "Fixture checkout");
  const outputParent = await canonicalExistingDirectory(path.dirname(output), "Evidence output parent");
  await outputDoesNotExist(output);
  const canonicalOutput = path.join(outputParent.canonical, path.basename(output));
  assert(!containsPath(fixture.canonical, canonicalOutput), "Evidence path must be outside the target fixture checkout");
  return Object.freeze({
    output,
    outputParent: outputParent.raw,
    canonicalOutputParent: outputParent.canonical,
    canonicalOutput,
    fixtureCheckout: fixture.raw,
    canonicalFixtureCheckout: fixture.canonical
  });
}

async function recheckDestination(destination) {
  await assertNoSymlinkComponents(destination.fixtureCheckout, "Fixture checkout");
  await assertNoSymlinkComponents(destination.outputParent, "Evidence output parent");
  const canonicalFixture = await realpath(destination.fixtureCheckout);
  const canonicalParent = await realpath(destination.outputParent);
  assert(canonicalFixture === destination.canonicalFixtureCheckout, "Fixture checkout changed while preparing evidence");
  assert(canonicalParent === destination.canonicalOutputParent, "Evidence output parent changed while preparing evidence");
  assert(!containsPath(canonicalFixture, path.join(canonicalParent, path.basename(destination.output))), "Evidence path must remain outside the target fixture checkout");
  await outputDoesNotExist(destination.canonicalOutput);
}

function validateWorkflow(workflow) {
  if (workflow === null) return;
  exactKeys(workflow, ["id", "url", "conclusion"], "workflow");
  assert((typeof workflow.id === "string" || Number.isInteger(workflow.id)) && String(workflow.id).length <= 32, "workflow.id is invalid");
  assert(validUrl(workflow.url), "workflow.url must be a GitHub.com HTTPS URL");
  assert(typeof workflow.conclusion === "string" && workflow.conclusion.length > 0 && workflow.conclusion.length <= 32, "workflow.conclusion is invalid");
}

function validateResource(resource) {
  if (resource === null) return;
  exactKeys(resource, ["kind", "number", "url"], "resource");
  assert(resource.kind === "issue" || resource.kind === "pull_request", "resource.kind is invalid");
  assert(Number.isInteger(resource.number) && resource.number > 0, "resource.number is invalid");
  assert(validUrl(resource.url), "resource.url must be a GitHub.com HTTPS URL");
}

export function validateEvidence(evidence) {
  exactKeys(evidence, [
    "schemaVersion",
    "targetRepository",
    "scenario",
    "sourceSha",
    "dispatchRef",
    "workflow",
    "resource",
    "assertions",
    "passed",
    "startedAt",
    "completedAt"
  ], "evidence");
  assert(evidence.schemaVersion === 1, "evidence.schemaVersion must be 1");
  assert(validRepository(evidence.targetRepository), "evidence.targetRepository is invalid");
  assert(typeof evidence.scenario === "string" && SCENARIOS.has(evidence.scenario), "evidence.scenario is invalid");
  assert(typeof evidence.sourceSha === "string" && SHA.test(evidence.sourceSha), "evidence.sourceSha must be a full 40-character SHA");
  assert(evidence.dispatchRef === null || (typeof evidence.dispatchRef === "string" && evidence.dispatchRef.length <= 160 && DISPATCH_REF.test(evidence.dispatchRef)), "evidence.dispatchRef is invalid");
  validateWorkflow(evidence.workflow);
  validateResource(evidence.resource);
  assert(Array.isArray(evidence.assertions) && evidence.assertions.length > 0 && evidence.assertions.length <= 12, "evidence.assertions is invalid");
  for (const assertion of evidence.assertions) {
    exactKeys(assertion, ["expectation", "passed"], "assertion");
    assert(typeof assertion.expectation === "string" && assertion.expectation.length > 0 && assertion.expectation.length <= 180, "assertion.expectation is invalid");
    assert(typeof assertion.passed === "boolean", "assertion.passed is invalid");
  }
  assert(typeof evidence.passed === "boolean", "evidence.passed is invalid");
  assert(ISO_TIME.test(evidence.startedAt) && ISO_TIME.test(evidence.completedAt), "evidence timestamps are invalid");
  assert(serializedEvidenceBytes(evidence) <= MAX_SERIALIZED_EVIDENCE_BYTES, "evidence exceeds the bounded serialized size");
  return evidence;
}

export async function writeEvidenceAtomically({ evidence, destination, evidencePath, fixtureCheckout }) {
  validateEvidence(evidence);
  const prepared = destination ?? await prepareEvidenceDestination({ evidencePath, fixtureCheckout });
  await recheckDestination(prepared);
  const temporary = path.join(prepared.canonicalOutputParent, `.${path.basename(prepared.canonicalOutput)}.${randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);

  try {
    const handle = await open(temporary, flags, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await recheckDestination(prepared);
    await link(temporary, prepared.canonicalOutput);
    await unlink(temporary);
    return prepared.canonicalOutput;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
