import { createHash } from "node:crypto";
import path from "node:path";
import { SOURCE_REPOSITORY } from "../constants.mjs";
import { InstallerError } from "../errors.mjs";
import { normalizePackageIdentity, normalizePackageRelease } from "../package-release.mjs";
import { RELEASE_MANAGED_CATALOG } from "../repository-artifacts.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function parseReleaseManifest(
  source,
  { artifactCatalog = RELEASE_MANAGED_CATALOG } = {},
) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (cause) {
    throw new InstallerError("The existing Codekeeper release manifest is not valid JSON.", { code: "EXISTING_INSTALLATION_INVALID", cause });
  }
  const managedEntries = manifest?.managedFiles && typeof manifest.managedFiles === "object" && !Array.isArray(manifest.managedFiles)
    ? Object.entries(manifest.managedFiles)
    : [];
  if (
    ![1, 2].includes(manifest?.version)
    || manifest?.source?.repository !== SOURCE_REPOSITORY
    || !FULL_SHA.test(manifest?.source?.commit)
    || !managedEntries.length
    || managedEntries.length > artifactCatalog.targets.length
    || managedEntries.some(([target, digest]) => !artifactCatalog.artifactForTarget(target) || !SHA256.test(digest))
  ) {
    throw new InstallerError("The existing Codekeeper release manifest is invalid.", { code: "EXISTING_INSTALLATION_INVALID" });
  }
  try {
    if (manifest.version === 2) normalizePackageRelease(manifest.package, { expectedVersion: undefined });
    else
      normalizePackageIdentity(manifest.package, {
        expectedVersion: undefined
      });
  } catch (cause) {
    throw new InstallerError("The existing Codekeeper release manifest is invalid.", { code: "EXISTING_INSTALLATION_INVALID", cause });
  }
  return Object.freeze({
    version: manifest.version,
    package: Object.freeze({ ...manifest.package }),
    source: Object.freeze({ ...manifest.source }),
    managedFiles: Object.freeze(Object.fromEntries(managedEntries))
  });
}

export function isInstalledCodekeeperWorkflow(source, mode) {
  const activeUses = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:-\s+)?uses:/.test(line))
    .map((line) => line.replace(/^-\s+/, ""));
  if (Array.isArray(mode) && mode.length > 1) {
    return (
      activeUses.length === 5 &&
      activeUses.every((line) => line === "uses: ./.github/workflows/codekeeper-runtime.yml") &&
      /^\s*installed_modes:\s*(?:"[a-z]+(?:,[a-z]+)*"|[a-z]+(?:,[a-z]+)*)\s*$/m.test(source)
    );
  }
  if (Array.isArray(mode)) [mode] = mode;
  const actionPrefix = `uses: ${SOURCE_REPOSITORY}/tools/codekeeper@`;
  const workflowPrefix = `uses: ${SOURCE_REPOSITORY}/.github/workflows/codekeeper-${mode}.yml@`;
  const localBootstrap = "uses: ./.github/workflows/codekeeper-bootstrap.yml";
  const localWorkflow = `uses: ./.github/workflows/codekeeper-runtime-${mode}.yml`;
  if (activeUses.length === 1 && activeUses[0] === localWorkflow) return true;
  const appCredentialProbe =
    "uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3";
  if (
    mode === "assistant" &&
    activeUses.length === 2 &&
    activeUses.includes(appCredentialProbe) &&
    activeUses.includes(localWorkflow)
  ) {
    return true;
  }
  if (activeUses.length !== 2) return false;
  if (activeUses.includes(localBootstrap) && activeUses.includes(localWorkflow)) return true;
  const action = activeUses.find((line) => line.startsWith(actionPrefix));
  const workflow = activeUses.find((line) => line.startsWith(workflowPrefix));
  if (!action || !workflow) return false;
  const actionCommit = action.slice(actionPrefix.length);
  const workflowCommit = workflow.slice(workflowPrefix.length);
  return FULL_SHA.test(actionCommit) && actionCommit === workflowCommit;
}

async function exists(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function safeDirectoryEntries(fsImpl, target) {
  const stat = await exists(fsImpl, target);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new InstallerError(`${target} must be a regular directory, not a symlink.`, { code: "PATH_COLLISION" });
  }
  return fsImpl.readdir(target, { withFileTypes: true });
}

function caseEntry(entries, expected) {
  return entries.find((entry) => entry.name.toLowerCase() === expected.toLowerCase());
}

export async function readExactManagedTarget(
  root,
  target,
  fsImpl,
  { required = false } = {},
) {
  const parts = target.split("/");
  let parent = root;
  for (const [index, part] of parts.entries()) {
    const entries = await safeDirectoryEntries(fsImpl, parent);
    const entry = caseEntry(entries, part);
    if (!entry) {
      if (!required) return null;
      throw new InstallerError(
        `The managed Codekeeper artifact ${target} is missing.`,
        { code: "EXISTING_INSTALLATION_INVALID" },
      );
    }
    const final = index === parts.length - 1;
    if (
      entry.name !== part ||
      entry.isSymbolicLink() ||
      (final ? !entry.isFile() : !entry.isDirectory())
    ) {
      throw new InstallerError(
        `The managed Codekeeper artifact ${target} has a case collision or unsafe file type.`,
        { code: "PATH_COLLISION" },
      );
    }
    parent = path.join(parent, entry.name);
  }
  return fsImpl.readFile(parent, "utf8");
}

export async function assertManagedArtifacts(
  root,
  releaseManifest,
  fsImpl,
  artifactCatalog,
) {
  const managedFiles = releaseManifest?.managedFiles ?? {};
  for (const [target, digest] of Object.entries(managedFiles)) {
    const artifact = artifactCatalog.artifactForTarget(target);
    const source = await readExactManagedTarget(root, target, fsImpl, {
      required: true,
    });
    if (artifact.validation === "caller") {
      if (!isInstalledCodekeeperWorkflow(source, artifact.callerModes)) {
        throw new InstallerError(
          `Managed caller ${target} is not an installed Codekeeper workflow.`,
          { code: "EXISTING_INSTALLATION_INVALID" },
        );
      }
      continue;
    }
    if (sha256(source) !== digest) {
      throw new InstallerError(
        `Managed artifact ${target} no longer matches its installation manifest.`,
        { code: "EXISTING_INSTALLATION_INVALID" },
      );
    }
  }
  for (const artifact of artifactCatalog.artifacts) {
    if (
      artifact.validation !== "digest" ||
      Object.hasOwn(managedFiles, artifact.target)
    )
      continue;
    if (await readExactManagedTarget(root, artifact.target, fsImpl)) {
      throw new InstallerError(
        `The release-owned path ${artifact.target} is not recorded by this installation.`,
        { code: "PATH_COLLISION" },
      );
    }
  }
}
