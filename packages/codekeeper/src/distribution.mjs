import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  GENERIC_RUNTIME_WORKFLOW,
  PACKAGE_ACQUIRE_ACTION,
  SOURCE_REPOSITORY,
  UNIFIED_CALLER_WORKFLOW,
} from "./constants.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;

export const GENERATED_ASSET_METADATA_PATH = "assets/metadata.json";
export const GENERATED_ASSET_METADATA_SOURCE_PATH = "generated/assets/metadata.json";
export const GENERATED_CALLER_WORKFLOW_PATH = UNIFIED_CALLER_WORKFLOW.packagePath;
export const DISTRIBUTION_PROVENANCE_SOURCES = Object.freeze({
  presetCatalogue: "tools/codekeeper/presets/catalogue.mjs",
  toolingManifest: "tools/codekeeper/tooling-manifest.json",
});

function fail(message, cause) {
  throw new Error(`Codekeeper distribution: ${message}`, cause ? { cause } : undefined);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestRecord(bytes, sourcePath, packagePath) {
  const record = {
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    sourcePath,
  };
  if (packagePath) record.packagePath = packagePath;
  return record;
}

export function isGeneratedAssetRelativePath(relativePath) {
  return relativePath === "metadata.json" || relativePath.startsWith("workflows/");
}

export function distributionAssetSpecs() {
  return Object.freeze([
    ...AGENT_PROFILE_IDS.map((id) => {
      const asset = AGENT_PROFILES[id].asset;
      return Object.freeze({
        asset,
        sourcePath: `tools/codekeeper/${asset}`,
        bytesFrom: `packages/codekeeper/assets/${asset}`,
      });
    }),
    Object.freeze({
      asset: "policies/mixed.json",
      sourcePath: ".github/codekeeper.json",
      bytesFrom: "packages/codekeeper/assets/policies/mixed.json",
    }),
    Object.freeze({
      asset: "policies/openai.json",
      sourcePath: ".github/codekeeper.json#preset=openai",
      bytesFrom: "packages/codekeeper/assets/policies/openai.json",
    }),
    Object.freeze({
      asset: "repository/README.md",
      sourcePath: "packages/codekeeper/assets/repository/README.md",
      bytesFrom: "packages/codekeeper/assets/repository/README.md",
    }),
    Object.freeze({
      asset: UNIFIED_CALLER_WORKFLOW.asset,
      sourcePath: UNIFIED_CALLER_WORKFLOW.sourcePath,
      bytesFrom: UNIFIED_CALLER_WORKFLOW.sourcePath,
    }),
    Object.freeze({
      asset: PACKAGE_ACQUIRE_ACTION.asset,
      sourcePath: PACKAGE_ACQUIRE_ACTION.sourcePath,
      packagePath: PACKAGE_ACQUIRE_ACTION.packagePath,
      bytesFrom: PACKAGE_ACQUIRE_ACTION.sourcePath,
    }),
    Object.freeze({
      asset: GENERIC_RUNTIME_WORKFLOW.asset,
      sourcePath: GENERIC_RUNTIME_WORKFLOW.sourcePath,
      packagePath: GENERIC_RUNTIME_WORKFLOW.packagePath,
      bytesFrom: GENERIC_RUNTIME_WORKFLOW.sourcePath,
    }),
  ]);
}

export const SOURCE_RESOLVED_ASSETS = Object.freeze([
  PACKAGE_ACQUIRE_ACTION,
  GENERIC_RUNTIME_WORKFLOW,
  UNIFIED_CALLER_WORKFLOW,
]);

async function requireRegularFile(root, relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  let information;
  try {
    information = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`missing canonical file: ${relativePath}`);
    throw error;
  }
  if (information.isSymbolicLink() || !information.isFile()) {
    fail(`canonical file is not a regular non-symlink file: ${relativePath}`);
  }
  return readFile(target);
}

export function resolveRepositoryHead(repositoryRoot) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!FULL_SHA.test(head)) fail("repository HEAD is not a full commit");
  return head;
}

export function resolveDistributionCommit(sourceCommit, repositoryRoot) {
  if (sourceCommit !== undefined) {
    if (!FULL_SHA.test(sourceCommit)) fail("an explicit full source commit is required");
    return sourceCommit;
  }
  return resolveRepositoryHead(repositoryRoot);
}

export async function buildDistributionMetadata({
  repositoryRoot,
  sourceCommit,
} = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    fail("repositoryRoot is required");
  }
  const commit = resolveDistributionCommit(sourceCommit, repositoryRoot);
  const assets = {};
  for (const spec of distributionAssetSpecs()) {
    const bytes = await requireRegularFile(repositoryRoot, spec.bytesFrom);
    assets[spec.asset] = digestRecord(bytes, spec.sourcePath, spec.packagePath);
  }
  const provenance = {};
  for (const [name, sourcePath] of Object.entries(DISTRIBUTION_PROVENANCE_SOURCES)) {
    const bytes = await requireRegularFile(repositoryRoot, sourcePath);
    provenance[name] = digestRecord(bytes, sourcePath);
  }
  return {
    version: 1,
    source: {
      repository: SOURCE_REPOSITORY,
      commit,
    },
    assets,
    provenance,
  };
}

export function distributionMetadataSource(metadata) {
  return Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
}

export async function generateCodekeeperDistribution({
  repositoryRoot,
  destination,
  sourceCommit,
} = {}) {
  if (typeof destination !== "string" || destination.length === 0) fail("destination is required");
  const metadata = await buildDistributionMetadata({ repositoryRoot, sourceCommit });
  const callerBytes = await requireRegularFile(repositoryRoot, UNIFIED_CALLER_WORKFLOW.sourcePath);
  const metadataBytes = distributionMetadataSource(metadata);
  await mkdir(path.join(destination, "assets", "workflows"), { recursive: true });
  await writeFile(path.join(destination, ...GENERATED_CALLER_WORKFLOW_PATH.split("/")), callerBytes, { flag: "wx" });
  await writeFile(path.join(destination, ...GENERATED_ASSET_METADATA_PATH.split("/")), metadataBytes, { flag: "wx" });
  return {
    metadata,
    files: [
      {
        path: GENERATED_CALLER_WORKFLOW_PATH,
        sourcePath: UNIFIED_CALLER_WORKFLOW.sourcePath,
        role: "production",
        sha256: sha256(callerBytes),
      },
      {
        path: GENERATED_ASSET_METADATA_PATH,
        sourcePath: GENERATED_ASSET_METADATA_SOURCE_PATH,
        role: "production",
        sha256: sha256(metadataBytes),
      },
    ],
  };
}
