import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  MODES,
  RELEASE_MANIFEST_TARGET
} from "../constants.mjs";
import { renderInstallFiles, sha256 } from "../assets.mjs";

export function renderPlannedInstallFiles({
  bundle,
  answers,
  snapshot,
  modes,
  displayName,
  ownerLogins,
  capabilities,
  models,
  tracing,
  maintenanceScheduled,
  policySource,
  profileSources,
  installation,
  inputPolicy,
  releaseUpdate
}) {
  return renderInstallFiles(bundle, {
    modes,
    preset: answers.preset,
    displayName,
    defaultBranch: snapshot.defaultBranch,
    ownerLogins,
    capabilities,
    models,
    tracing,
    maintenanceScheduled,
    policySource,
    profileSources,
    enforceBundledDefaults: !installation,
    policyOverride: inputPolicy,
    refreshReleaseBoundaries: releaseUpdate
  });
}

export function changedInstallFiles({ files, installation, desiredProfileSettings, modes }) {
  const changedFiles = installation
    ? files
        .filter((file) => installation.contents[file.path] !== file.contents)
        .map((file) => ({
          ...file,
          previousSha256: installation.contents[file.path] === undefined ? null : sha256(installation.contents[file.path])
        }))
    : files;
  if (installation) {
    for (const id of AGENT_PROFILE_IDS) {
      const target = AGENT_PROFILES[id].target;
      if (desiredProfileSettings.profileSources[id] !== "package" || !Object.hasOwn(installation.contents, target)) continue;
      changedFiles.push({
        path: target,
        contents: null,
        bytes: 0,
        sha256: null,
        previousSha256: sha256(installation.contents[target]),
        delete: true
      });
    }
    for (const mode of installation.modes.filter((mode) => !modes.includes(mode))) {
      const target = MODES[mode].target;
      if (!Object.hasOwn(installation.contents, target)) continue;
      changedFiles.push({
        path: target,
        contents: null,
        bytes: 0,
        sha256: null,
        previousSha256: sha256(installation.contents[target]),
        delete: true
      });
    }
    const nextReleaseManifest = JSON.parse(files.find((file) => file.path === RELEASE_MANIFEST_TARGET).contents);
    const nextManagedTargets = new Set(Object.keys(nextReleaseManifest.managedFiles));
    const changedTargets = new Set(changedFiles.map((file) => file.path));
    for (const target of Object.keys(installation.releaseManifest?.managedFiles ?? {})) {
      if (nextManagedTargets.has(target) || changedTargets.has(target)) continue;
      changedFiles.push({
        path: target,
        contents: null,
        bytes: 0,
        sha256: null,
        previousSha256: sha256(installation.contents[target]),
        delete: true
      });
    }
  }
  return changedFiles;
}
