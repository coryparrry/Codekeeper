#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SPDX_VERSION = "SPDX-2.3";
const SPDX_DATA_LICENSE = "CC0-1.0";
const NOASSERTION = "NOASSERTION";

function fail(message) {
  throw new Error(`Codekeeper SBOM generation failed: ${message}`);
}

function parseArgs(argv) {
  const locks = [];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag || "argument"} requires a value`);
    if (flag === "--lock") locks.push(path.resolve(value));
    else if (["--policy", "--output", "--report"].includes(flag)) {
      if (values.has(flag)) fail(`${flag} was provided more than once`);
      values.set(flag, path.resolve(value));
    } else fail(`unknown option ${flag}`);
    index += 1;
  }
  if (locks.length === 0) fail("at least one --lock is required");
  for (const flag of ["--policy", "--output", "--report"]) {
    if (!values.has(flag)) fail(`${flag} is required`);
  }
  return {
    locks,
    policy: values.get("--policy"),
    output: values.get("--output"),
    report: values.get("--report"),
  };
}

function exactObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function safePackageName(value, fallbackPath) {
  const declared = typeof value === "string" ? value.trim() : "";
  if (declared) return declared;
  const marker = "node_modules/";
  const index = fallbackPath.lastIndexOf(marker);
  if (index === -1) fail(`package entry ${fallbackPath} has no name`);
  return fallbackPath.slice(index + marker.length);
}

function licenseTokens(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [];
}

function packagePurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function packageId(name, version) {
  return `SPDXRef-Package-${createHash("sha256").update(`${name}\0${version}`).digest("hex").slice(0, 20)}`;
}

function normalizedRepository(value) {
  if (!value) return NOASSERTION;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.url === "string") return value.url;
  return NOASSERTION;
}

export function collectPackages(lock, sourcePath = "package-lock.json") {
  exactObject(lock, sourcePath);
  if (![2, 3].includes(lock.lockfileVersion)) fail(`${sourcePath} must use npm lockfile version 2 or 3`);
  const packages = exactObject(lock.packages, `${sourcePath}.packages`);
  const collected = new Map();
  for (const [packagePath, metadataValue] of Object.entries(packages)) {
    if (!packagePath || !packagePath.includes("node_modules/") || metadataValue?.link === true) continue;
    const metadata = exactObject(metadataValue, `${sourcePath}.packages.${packagePath}`);
    const name = safePackageName(metadata.name, packagePath);
    const version = typeof metadata.version === "string" ? metadata.version.trim() : "";
    if (!version) fail(`${sourcePath} package ${name} has no version`);
    const license = typeof metadata.license === "string" && metadata.license.trim()
      ? metadata.license.trim()
      : NOASSERTION;
    const key = `${name}\0${version}`;
    const previous = collected.get(key);
    const item = {
      name,
      version,
      license,
      repository: normalizedRepository(metadata.repository),
      resolved: typeof metadata.resolved === "string" && metadata.resolved ? metadata.resolved : NOASSERTION,
      dev: metadata.dev === true,
      optional: metadata.optional === true,
      sources: [sourcePath],
    };
    if (previous) {
      if (previous.license === NOASSERTION && license !== NOASSERTION) previous.license = license;
      if (!previous.sources.includes(sourcePath)) previous.sources.push(sourcePath);
      previous.dev &&= item.dev;
      previous.optional &&= item.optional;
    } else collected.set(key, item);
  }
  return [...collected.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function validatePolicy(value) {
  const policy = exactObject(value, "license policy");
  if (policy.version !== 1) fail("license policy version must be 1");
  if (!Array.isArray(policy.denyLicenses) || policy.denyLicenses.some((item) => typeof item !== "string" || !item.trim())) {
    fail("license policy denyLicenses must be a string array");
  }
  if (typeof policy.allowMissing !== "boolean") fail("license policy allowMissing must be boolean");
  return {
    denyLicenses: new Set(policy.denyLicenses.map((item) => item.trim().toUpperCase())),
    allowMissing: policy.allowMissing,
  };
}

export function evaluateLicenses(packages, policyValue) {
  const policy = validatePolicy(policyValue);
  const denied = [];
  const missing = [];
  for (const item of packages) {
    if (item.license === NOASSERTION) {
      missing.push({ name: item.name, version: item.version, sources: [...item.sources] });
      continue;
    }
    const matched = licenseTokens(item.license)
      .map((token) => token.toUpperCase())
      .filter((token) => policy.denyLicenses.has(token));
    if (matched.length > 0) {
      denied.push({
        name: item.name,
        version: item.version,
        license: item.license,
        matched: [...new Set(matched)].sort(),
        sources: [...item.sources],
      });
    }
  }
  return Object.freeze({
    denied: Object.freeze(denied),
    missing: Object.freeze(missing),
    valid: denied.length === 0 && (policy.allowMissing || missing.length === 0),
  });
}

function createdAt(environment = process.env) {
  const epoch = Number(environment.SOURCE_DATE_EPOCH ?? 0);
  if (!Number.isSafeInteger(epoch) || epoch < 0) fail("SOURCE_DATE_EPOCH must be a non-negative integer");
  return new Date(epoch * 1000).toISOString().replace(".000Z", "Z");
}

export function buildSpdxDocument(packages, { name = "Codekeeper source dependencies", environment = process.env } = {}) {
  const canonical = JSON.stringify(packages.map(({ sources: _sources, ...item }) => item));
  const digest = createHash("sha256").update(canonical).digest("hex");
  return {
    spdxVersion: SPDX_VERSION,
    dataLicense: SPDX_DATA_LICENSE,
    SPDXID: "SPDXRef-DOCUMENT",
    name,
    documentNamespace: `https://github.com/coryparrry/Codekeeper/sbom/${digest}`,
    creationInfo: {
      created: createdAt(environment),
      creators: ["Tool: Codekeeper source security"],
    },
    packages: packages.map((item) => ({
      SPDXID: packageId(item.name, item.version),
      name: item.name,
      versionInfo: item.version,
      downloadLocation: item.resolved,
      filesAnalyzed: false,
      licenseConcluded: item.license,
      licenseDeclared: item.license,
      homepage: item.repository,
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: packagePurl(item.name, item.version),
      }],
      annotations: [{
        annotationType: "OTHER",
        annotator: "Tool: Codekeeper source security",
        annotationDate: createdAt(environment),
        comment: JSON.stringify({ dev: item.dev, optional: item.optional, sources: item.sources }),
      }],
    })),
  };
}

async function readJson(filePath, name) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    fail(`${name} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${name} contains invalid JSON: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = await readJson(args.policy, "license policy");
  const all = new Map();
  for (const lockPath of args.locks) {
    const lock = await readJson(lockPath, lockPath);
    for (const item of collectPackages(lock, path.relative(process.cwd(), lockPath) || path.basename(lockPath))) {
      const key = `${item.name}\0${item.version}`;
      const existing = all.get(key);
      if (existing) {
        existing.sources = [...new Set([...existing.sources, ...item.sources])].sort();
        if (existing.license === NOASSERTION && item.license !== NOASSERTION) existing.license = item.license;
        existing.dev &&= item.dev;
        existing.optional &&= item.optional;
      } else all.set(key, item);
    }
  }
  const packages = [...all.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  const evaluation = evaluateLicenses(packages, policy);
  const document = buildSpdxDocument(packages);
  const report = {
    version: 1,
    packageCount: packages.length,
    valid: evaluation.valid,
    denied: evaluation.denied,
    missing: evaluation.missing,
  };
  await Promise.all([
    mkdir(path.dirname(args.output), { recursive: true }),
    mkdir(path.dirname(args.report), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(args.output, `${JSON.stringify(document, null, 2)}\n`, "utf8"),
    writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);
  if (!evaluation.valid) {
    const reasons = [
      evaluation.denied.length ? `${evaluation.denied.length} denied-license package(s)` : "",
      evaluation.missing.length && policy.allowMissing === false
        ? `${evaluation.missing.length} package(s) without declared licenses`
        : "",
    ].filter(Boolean);
    fail(reasons.join("; "));
  }
  process.stdout.write(`generated SPDX SBOM for ${packages.length} packages\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
