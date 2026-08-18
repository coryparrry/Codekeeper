#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FULL_SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^codekeeper-v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_TAG_DEPTH = 8;

function fail(message) {
  throw new Error(`Release tag integrity: ${message}`);
}

function required(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) fail(`${name} is required`);
  return normalized;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) fail(`unexpected argument ${flag}`);
    const name = flag.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`--${name} requires a value`);
    if (values.has(name)) fail(`--${name} was provided more than once`);
    values.set(name, value);
    index += 1;
  }
  const allowed = new Set(["repository", "tag", "expected-commit"]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) fail(`unknown option --${name}`);
  }
  return {
    repository: required(values.get("repository"), "--repository"),
    tag: required(values.get("tag"), "--tag"),
    expectedCommit: required(values.get("expected-commit"), "--expected-commit").toLowerCase(),
  };
}

function exactObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function gitObject(value, name) {
  const object = exactObject(value, name);
  if (!new Set(["commit", "tag"]).has(object.type) || !FULL_SHA.test(String(object.sha ?? "").toLowerCase())) {
    fail(`${name} has an invalid Git object`);
  }
  return { type: object.type, sha: object.sha.toLowerCase() };
}

export async function resolveReleaseTagCommit({ repository, tag, fetchJson }) {
  if (!REPOSITORY.test(repository)) fail("repository must be owner/name");
  if (!RELEASE_TAG.test(tag)) fail("tag must use codekeeper-vX.Y.Z");
  if (typeof fetchJson !== "function") fail("fetchJson must be a function");

  const reference = exactObject(
    await fetchJson(`repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`),
    "tag reference",
  );
  if (reference.ref !== `refs/tags/${tag}`) fail("GitHub returned a different tag reference");

  let object = gitObject(reference.object, "tag reference object");
  const visited = new Set();
  for (let depth = 0; depth <= MAX_TAG_DEPTH; depth += 1) {
    if (object.type === "commit") return object.sha;
    if (visited.has(object.sha)) fail("annotated tag chain contains a cycle");
    if (depth === MAX_TAG_DEPTH) fail(`annotated tag chain exceeds ${MAX_TAG_DEPTH} objects`);
    visited.add(object.sha);
    const annotated = exactObject(
      await fetchJson(`repos/${repository}/git/tags/${object.sha}`),
      `annotated tag ${object.sha}`,
    );
    object = gitObject(annotated.object, `annotated tag ${object.sha} target`);
  }
  fail("tag target could not be resolved");
}

function ghFetchJson(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  if (result.error) fail(`could not start GitHub CLI: ${result.error.message}`);
  if (result.status !== 0) fail(`GitHub API request failed for ${endpoint}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`GitHub returned invalid JSON for ${endpoint}`);
  }
}

export async function verifyReleaseTag({ repository, tag, expectedCommit, fetchJson = ghFetchJson }) {
  const normalizedExpected = String(expectedCommit ?? "").trim().toLowerCase();
  if (!FULL_SHA.test(normalizedExpected)) fail("expected commit must be a full 40-character SHA");
  const resolvedCommit = await resolveReleaseTagCommit({ repository, tag, fetchJson });
  if (resolvedCommit !== normalizedExpected) {
    fail(`tag ${tag} resolves to ${resolvedCommit}, expected ${normalizedExpected}`);
  }
  return Object.freeze({ repository, tag, commit: resolvedCommit, verified: true });
}

async function main() {
  const result = await verifyReleaseTag(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
