#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  commandEnvironment,
  requireSuccess,
  runCommand,
  runLiteralNpxLifecycle,
} from "./release-candidate-lifecycle.mjs";

export { runLiteralNpxLifecycle } from "./release-candidate-lifecycle.mjs";

const PACKAGE_NAME = "@coryparry/codekeeper";
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SRI = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const REQUIRED_PATHS = Object.freeze([
  "assets/metadata.json",
  "assets/workflows/codekeeper.yml",
  "bin/codekeeper.mjs",
  "bin/verify-package.mjs",
  "release/actions/acquire-package/action.yml",
  "release/workflows/codekeeper-runtime.yml",
  "runtime/agents/pr-reviewer.md",
  "runtime/package-lock.json",
  "runtime/package.json",
  "runtime/presets/catalogue.mjs",
  "runtime/scripts/verify-tooling-artifact.mjs",
  "runtime/src/cli.mjs",
]);

function fail(message) {
  throw new Error(`Codekeeper release candidate verification failed: ${message}`);
}

function sha512(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizePackReport(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail("npm pack report is not valid JSON");
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) fail("npm pack report must contain exactly one entry");
    [value] = value;
  } else if (
    value &&
    typeof value === "object" &&
    !Object.hasOwn(value, "filename")
  ) {
    const entries = Object.values(value);
    if (entries.length !== 1) fail("npm pack report must contain exactly one entry");
    [value] = entries;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("npm pack report has an invalid shape");
  }
  return value;
}

function safeFilename(value) {
  return (
    typeof value === "string" &&
    value.endsWith(".tgz") &&
    path.basename(value) === value &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

async function requireRegularFile(target, label) {
  const information = await lstat(target);
  if (information.isSymbolicLink() || !information.isFile()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return information;
}

export async function verifyTarballReceipt({
  tarball,
  expectedFilename,
  expectedIntegrity,
}) {
  if (!safeFilename(expectedFilename)) fail("expected tarball filename is unsafe");
  if (!SRI.test(expectedIntegrity ?? "")) fail("expected tarball integrity is invalid");
  const resolved = path.resolve(tarball);
  if (path.basename(resolved) !== expectedFilename) {
    fail("tarball filename does not match the expected npm pack receipt");
  }
  await requireRegularFile(resolved, "candidate tarball");
  const bytes = await readFile(resolved);
  const actualIntegrity = sha512(bytes);
  if (actualIntegrity !== expectedIntegrity) {
    fail("candidate tarball integrity mismatch");
  }
  return Object.freeze({ bytes, integrity: actualIntegrity, tarball: resolved });
}

async function collectYamlFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (child === "node_modules" || child === "runtime/node_modules") continue;
    if (entry.isSymbolicLink()) fail(`candidate contains a symlink: ${child}`);
    if (entry.isDirectory()) files.push(...(await collectYamlFiles(root, child)));
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(child);
  }
  return files;
}

export async function assertRequiredCandidatePaths(root) {
  for (const relativePath of REQUIRED_PATHS) {
    await requireRegularFile(path.join(root, ...relativePath.split("/")), relativePath);
  }
  const yamlFiles = await collectYamlFiles(root);
  if (yamlFiles.length < 11) fail("candidate is missing packaged or generated workflow YAML");
  return yamlFiles;
}

async function parseCandidateYaml(root, yamlFiles, environment) {
  const ruby = await runCommand(
    "ruby",
    [
      "-e",
      'begin; require "yaml"; rescue LoadError => error; warn "Ruby/Psych is required: #{error.message}"; exit 2; end; ARGV.each { |file| YAML.load_file(file); puts "parsed #{file}" }',
      ...yamlFiles.map((file) => path.join(root, ...file.split("/"))),
    ],
    { env: environment },
  ).catch((error) => {
    if (error?.code === "ENOENT") {
      fail("Ruby/Psych is required to parse every packaged workflow YAML file");
    }
    throw error;
  });
  requireSuccess(ruby, "Ruby/Psych workflow parsing");
}

async function extractTarball(tarball, root, environment) {
  await mkdir(root, { recursive: true });
  const extracted = await runCommand(
    "tar",
    ["-xzf", tarball, "--strip-components=1", "-C", root],
    { env: environment },
  );
  requireSuccess(extracted, "candidate extraction");
}

async function writeIntegrityReceipt(root, integrity) {
  await writeFile(
    path.join(root, "release", "package-integrity.json"),
    `${JSON.stringify({ version: 1, algorithm: "sha512", integrity }, null, 2)}\n`,
    { flag: "wx" },
  );
}

async function runPackagedVerifier(root, expected, environment) {
  await writeIntegrityReceipt(root, expected.integrity);
  const result = await runCommand(
    process.execPath,
    [
      path.join(root, "bin", "verify-package.mjs"),
      "--root",
      root,
      "--expected-name",
      expected.name,
      "--expected-version",
      expected.version,
      "--expected-integrity",
      expected.integrity,
      "--expected-manifest-sha256",
      expected.manifestSha256,
      "--expected-source-commit",
      expected.sourceCommit,
    ],
    { cwd: root, env: environment },
  );
  requireSuccess(result, "packaged release verifier");
  if (!result.stdout.startsWith("CODEKEEPER_PACKAGE_VERIFIED ")) {
    fail("packaged release verifier returned an unexpected receipt");
  }
}

function successfulResult(stdout = "") {
  return {
    status: 0,
    signal: null,
    timedOut: false,
    truncated: false,
    stdout,
    stderr: "",
  };
}

async function exerciseProductionVerificationAdapters({
  candidateRoot,
  adapterStage,
  expected,
}) {
  const module = await import(
    `${pathToFileURL(path.join(candidateRoot, "src", "verification-adapters.mjs")).href}?candidate=${expected.integrity.slice(-12)}`
  );
  const metadata = JSON.parse(
    await readFile(path.join(candidateRoot, "assets", "metadata.json"), "utf8"),
  );
  const calls = [];
  const verificationId = "123e4567-e89b-42d3-a456-426614174000";
  const runner = {
    async run(command, args = []) {
      calls.push({ command, args: [...args] });
      if (["secret", "variable"].includes(args[0])) {
        fail("production verification attempted a secret or variable mutation call");
      }
      const commandLine = `${command} ${args.join(" ")}`;
      if (command === "node" && args.includes("ci")) return successfulResult();
      if (command === "node" && args.some((argument) => argument.endsWith("runtime/src/cli.mjs"))) {
        return successfulResult();
      }
      if (commandLine.startsWith("gh workflow run codekeeper.yml")) {
        if (!commandLine.includes("--field verify_app_credentials=true")) {
          fail("production credential verification did not select the App probe");
        }
        return successfulResult();
      }
      if (commandLine.includes("gh run list")) {
        return successfulResult(
          JSON.stringify([
            {
              databaseId: 501,
              displayTitle: `Codekeeper App credential verification ${verificationId}`,
            },
          ]),
        );
      }
      if (commandLine.startsWith("gh run watch 501 ")) return successfulResult();
      if (commandLine.startsWith("gh run view 501 ")) {
        return successfulResult(
          JSON.stringify({
            jobs: [
              {
                name: "Codekeeper App credential verification",
                conclusion: "success",
              },
            ],
          }),
        );
      }
      fail(`unexpected hermetic production verification command: ${commandLine}`);
    },
  };
  const installation = {
    policy: { repository: { defaultBranch: "main" } },
    releaseManifest: { source: metadata.source },
  };
  const exactReceipt = {
    name: expected.name,
    version: expected.version,
    integrity: expected.integrity,
  };
  const packageVerified = await module.verifyInstalledPackage(
    { packageRelease: exactReceipt, installation, root: candidateRoot },
    {
      runner,
      environment: {},
      platform: process.platform,
      resolveNpm: async () => "/hermetic/npm-cli.js",
      resolveRelease: async () => exactReceipt,
      stagePackage: async () => ({
        root: path.dirname(adapterStage),
        executable: path.join(adapterStage, "bin", "codekeeper.mjs"),
      }),
    },
  );
  if (!packageVerified) fail("production exact-package verification adapter rejected the candidate");
  const appVerified = await module.runAppCredentialProbe(
    {
      runner,
      root: candidateRoot,
      repository: "example/codekeeper-candidate",
      installation,
    },
    { wait: async () => {}, verificationId },
  );
  if (!appVerified) fail("production no-mutation App credential proof was not correlated");
  if (calls.some(({ args }) => ["secret", "variable"].includes(args[0]))) {
    fail("production verification issued a secret or variable mutation command");
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) fail("every argument requires a flag and value");
    const name = flag.slice(2);
    if (Object.hasOwn(values, name)) fail(`duplicate argument: ${flag}`);
    values[name] = value;
  }
  const allowed = new Set([
    "expected-filename",
    "expected-integrity",
    "expected-manifest-sha256",
    "expected-name",
    "expected-source-commit",
    "expected-version",
    "pack-report",
    "tarball",
    "tarball-directory",
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) fail(`unknown argument: --${name}`);
  }
  return values;
}

async function expectedCandidate(values) {
  let report = null;
  if (values["pack-report"]) {
    await requireRegularFile(values["pack-report"], "npm pack report");
    report = normalizePackReport(await readFile(values["pack-report"], "utf8"));
  }
  const expected = {
    filename: values["expected-filename"] ?? report?.filename,
    integrity: values["expected-integrity"] ?? report?.integrity,
    manifestSha256: values["expected-manifest-sha256"],
    name: values["expected-name"] ?? report?.name,
    sourceCommit: values["expected-source-commit"],
    version: values["expected-version"] ?? report?.version,
  };
  if (!safeFilename(expected.filename)) fail("an expected safe tarball filename is required");
  if (!SRI.test(expected.integrity ?? "")) fail("an expected SHA-512 integrity is required");
  if (expected.name !== PACKAGE_NAME) fail("expected package name is not Codekeeper");
  if (!FULL_COMMIT.test(expected.sourceCommit ?? "")) fail("an expected full source commit is required");
  if (!VERSION.test(expected.version ?? "")) fail("an expected semantic version is required");
  if (expected.manifestSha256 !== undefined && !SHA256.test(expected.manifestSha256)) {
    fail("expected release manifest SHA-256 is invalid");
  }
  const tarball = values.tarball ??
    (values["tarball-directory"]
      ? path.join(values["tarball-directory"], expected.filename)
      : null);
  if (!tarball) fail("--tarball or --tarball-directory is required");
  return { expected, tarball };
}

export async function verifyReleaseCandidate({ values }) {
  const { expected, tarball } = await expectedCandidate(values);
  const verifiedTarball = await verifyTarballReceipt({
    tarball,
    expectedFilename: expected.filename,
    expectedIntegrity: expected.integrity,
  });
  expected.shasum = createHash("sha1").update(verifiedTarball.bytes).digest("hex");

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-release-candidate-"),
  );
  const environment = commandEnvironment(temporaryRoot);
  try {
    await writeFile(path.join(temporaryRoot, "empty-npmrc"), "");
    const extractedRoot = path.join(temporaryRoot, "extracted");
    await extractTarball(verifiedTarball.tarball, extractedRoot, environment);
    const yamlFiles = await assertRequiredCandidatePaths(extractedRoot);
    const manifestBytes = await readFile(
      path.join(extractedRoot, "release", "manifest.json"),
    );
    const manifestSha256 = sha256(manifestBytes);
    if (expected.manifestSha256 && expected.manifestSha256 !== manifestSha256) {
      fail("release manifest SHA-256 does not match the expected build output");
    }
    expected.manifestSha256 = manifestSha256;
    await runPackagedVerifier(extractedRoot, expected, environment);
    await parseCandidateYaml(extractedRoot, yamlFiles, environment);

    const packageManifest = JSON.parse(
      await readFile(path.join(extractedRoot, "package.json"), "utf8"),
    );
    await runLiteralNpxLifecycle({
      bytes: verifiedTarball.bytes,
      expected,
      packageManifest,
      root: path.join(temporaryRoot, "npx"),
    });

    const installRoot = path.join(temporaryRoot, "installed");
    await mkdir(installRoot);
    const installed = await runCommand(
      "npm",
      [
        "install",
        "--prefix",
        installRoot,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        verifiedTarball.tarball,
      ],
      { cwd: installRoot, env: environment },
    );
    requireSuccess(installed, "exact candidate installation");
    const installedPackage = await realpath(
      path.join(installRoot, "node_modules", "@coryparry", "codekeeper"),
    );
    await assertRequiredCandidatePaths(installedPackage);
    await runPackagedVerifier(installedPackage, expected, environment);
    const runtimeInstall = await runCommand(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: path.join(installedPackage, "runtime"), env: environment },
    );
    requireSuccess(runtimeInstall, "nested runtime dependency installation");

    const adapterStage = path.join(temporaryRoot, "adapter", "package");
    await extractTarball(verifiedTarball.tarball, adapterStage, environment);
    await exerciseProductionVerificationAdapters({
      candidateRoot: installedPackage,
      adapterStage,
      expected,
    });
    return Object.freeze({
      filename: expected.filename,
      integrity: expected.integrity,
      manifestSha256,
      name: expected.name,
      sourceCommit: expected.sourceCommit,
      version: expected.version,
      yamlFiles: yamlFiles.length,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const receipt = await verifyReleaseCandidate({
    values: parseArguments(process.argv.slice(2)),
  });
  process.stdout.write(`CODEKEEPER_RELEASE_CANDIDATE_VERIFIED ${JSON.stringify(receipt)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
