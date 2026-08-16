import { execFileSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodekeeperPackageStage,
  verifyCodekeeperPackageStage,
} from "./build-codekeeper-package.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const DEFAULT_BRANCH = "main";
const PRODUCTION_SOURCE_PATHS = Object.freeze([
  "tools/codekeeper",
  ".github/workflows/codekeeper-assistant.yml",
  ".github/workflows/codekeeper-fix.yml",
  ".github/workflows/codekeeper-issues.yml",
  ".github/workflows/codekeeper-maintain.yml",
  ".github/workflows/codekeeper-review.yml",
]);

function fail(message) {
  throw new Error(`Codekeeper package pack failed: ${message}`);
}

function packageManagerVersion(packageManager) {
  const match = /^npm@(\d+\.\d+\.\d+)$/.exec(packageManager ?? "");
  if (!match)
    fail("the repository packageManager must pin an exact npm version");
  return match[1];
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function releaseDefaultBranchRef(repositoryRoot) {
  const refs = git(repositoryRoot, [
    "for-each-ref",
    "--format=%(refname)",
    `refs/remotes/*/${DEFAULT_BRANCH}`,
  ])
    .split("\n")
    .filter(Boolean);
  if (refs.length !== 1) {
    fail(
      `exactly one fetched remote ${DEFAULT_BRANCH} ref is required; found ${refs.length}`,
    );
  }
  return refs[0];
}

export function verifyReleaseAuthority(
  repositoryRoot,
  { releaseCommit, pinnedSourceCommit },
) {
  if (!FULL_COMMIT.test(releaseCommit ?? ""))
    fail("the release commit must be a full commit");
  if (!FULL_COMMIT.test(pinnedSourceCommit ?? ""))
    fail("the installer source pin must be a full commit");
  const defaultBranchRef = releaseDefaultBranchRef(repositoryRoot);
  try {
    git(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      releaseCommit,
      defaultBranchRef,
    ]);
    git(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      pinnedSourceCommit,
      releaseCommit,
    ]);
  } catch {
    fail(
      "the release snapshot and installer source pin must be reachable from the fetched default branch",
    );
  }
  const latestProductionCheckpoint = git(repositoryRoot, [
    "rev-list",
    "-1",
    defaultBranchRef,
    "--",
    ...PRODUCTION_SOURCE_PATHS,
  ]);
  if (pinnedSourceCommit !== latestProductionCheckpoint) {
    fail(
      "the installer source pin does not match the latest production checkpoint on the fetched default branch",
    );
  }
  return { defaultBranchRef, latestProductionCheckpoint, releaseCommit };
}

export function normalizeNpmPackReport(output) {
  const parsed = JSON.parse(output);
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1)
      fail("npm pack returned an invalid number of reports");
    return normalizeNpmPackReportValue(parsed[0]);
  }
  if (parsed === null || typeof parsed !== "object")
    fail("npm pack returned an invalid report");
  if (Array.isArray(parsed.files)) return normalizeNpmPackReportValue(parsed);
  const reports = Object.values(parsed);
  if (reports.length !== 1)
    fail("npm pack returned an invalid number of reports");
  return normalizeNpmPackReportValue(reports[0]);
}

function normalizeNpmPackReportValue(report) {
  if (
    report === null ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    !Array.isArray(report.files)
  ) {
    fail("npm pack returned an invalid report");
  }
  return report;
}

async function requirePackDestination(
  destination,
  repositoryRoot,
  packageVersion,
) {
  let existingAncestor = path.resolve(destination);
  const missingSegments = [];
  while (true) {
    try {
      await lstat(existingAncestor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  destination = path.join(
    await realpath(existingAncestor),
    ...missingSegments.reverse(),
  );
  if (
    destination === repositoryRoot ||
    destination.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    fail("the pack destination must be outside the source repository");
  }
  await mkdir(destination, { recursive: true });
  const information = await lstat(destination);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    fail("the pack destination must be a regular directory");
  }
  destination = await realpath(destination);
  if (
    destination === repositoryRoot ||
    destination.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    fail("the pack destination must be outside the source repository");
  }
  const tarball = path.join(destination, `codekeeper-${packageVersion}.tgz`);
  try {
    await lstat(tarball);
  } catch (error) {
    if (error?.code === "ENOENT") return destination;
    throw error;
  }
  fail("the pack destination already contains this release tarball");
}

function validatePackReport(report, manifest, packageManifest) {
  if (
    report.name !== manifest.package.name ||
    report.version !== manifest.package.version ||
    report.filename !== `codekeeper-${manifest.package.version}.tgz`
  ) {
    fail("npm pack returned the wrong package identity");
  }
  const files = report.files.map((entry) => entry?.path);
  if (files.some((entry) => typeof entry !== "string"))
    fail("npm pack returned an invalid file inventory");
  if (
    files.includes("package-lock.json") ||
    files.includes("npm-shrinkwrap.json")
  ) {
    fail("npm pack included a project-root lockfile that npm 12 cannot honor");
  }
  const productFiles = files
    .filter((entry) => !entry.startsWith("node_modules/"))
    .sort();
  const expectedProductFiles = [
    ...manifest.files.map((entry) => entry.path),
    "release/manifest.json",
  ].sort();
  if (
    productFiles.length !== expectedProductFiles.length ||
    productFiles.some((entry, index) => entry !== expectedProductFiles[index])
  ) {
    fail("npm pack product inventory does not match the release manifest");
  }
  const bundled = new Set(report.bundled ?? []);
  if (
    !packageManifest.bundleDependencies.every((dependency) =>
      bundled.has(dependency),
    )
  ) {
    fail("npm pack did not bundle every installer dependency");
  }
}

export async function packCodekeeperPackage({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  destination,
  sourceCommit,
  requireClean = true,
  npmCommand = process.platform === "win32" ? "npm.cmd" : "npm",
  environment = process.env,
} = {}) {
  if (typeof destination !== "string" || destination.length === 0)
    fail("a pack destination is required");
  repositoryRoot = await realpath(path.resolve(repositoryRoot));
  const repositoryManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const packageManifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "packages/codekeeper/package.json"),
      "utf8",
    ),
  );
  const packageMetadata = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "packages/codekeeper/assets/metadata.json"),
      "utf8",
    ),
  );
  const requiredNpmVersion = packageManagerVersion(
    repositoryManifest.packageManager,
  );
  const actualNpmVersion = execFileSync(npmCommand, ["--version"], {
    encoding: "utf8",
    env: environment,
  }).trim();
  if (actualNpmVersion !== requiredNpmVersion) {
    fail(
      `npm ${requiredNpmVersion} is required; found ${actualNpmVersion || "unknown"}`,
    );
  }
  const releaseCommit =
    sourceCommit ?? git(repositoryRoot, ["rev-parse", "HEAD"]);
  if (requireClean) {
    verifyReleaseAuthority(repositoryRoot, {
      releaseCommit,
      pinnedSourceCommit: packageMetadata.source?.commit,
    });
  }
  destination = await requirePackDestination(
    destination,
    repositoryRoot,
    packageManifest.version,
  );
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-package-pack-"),
  );
  const stage = path.join(temporaryRoot, "package");
  try {
    const { manifest } = await buildCodekeeperPackageStage({
      repositoryRoot,
      destination: stage,
      sourceCommit: releaseCommit,
      requireClean,
    });
    const sourceLock = path.join(
      repositoryRoot,
      "packages/codekeeper/package-lock.json",
    );
    const lockInformation = await lstat(sourceLock);
    if (lockInformation.isSymbolicLink() || !lockInformation.isFile()) {
      fail("the installer package lock must be a regular file");
    }
    await copyFile(sourceLock, path.join(stage, "package-lock.json"));
    execFileSync(
      npmCommand,
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      {
        cwd: stage,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await rm(path.join(stage, "package-lock.json"));
    await verifyCodekeeperPackageStage(stage);
    const tarball = path.join(
      destination,
      `codekeeper-${packageManifest.version}.tgz`,
    );
    try {
      const output = execFileSync(
        npmCommand,
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          destination,
        ],
        {
          cwd: stage,
          encoding: "utf8",
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const report = normalizeNpmPackReport(output);
      validatePackReport(report, manifest, packageManifest);
      return { manifest, output, report };
    } catch (error) {
      await rm(tarball, { force: true });
      throw error;
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function destinationArgument(args) {
  if (args.length !== 2 || args[0] !== "--destination" || !args[1]) {
    fail(
      "usage: node scripts/pack-codekeeper-package.mjs --destination DIRECTORY",
    );
  }
  return path.resolve(args[1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  packCodekeeperPackage({
    destination: destinationArgument(process.argv.slice(2)),
  })
    .then(({ output }) => process.stdout.write(output))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
