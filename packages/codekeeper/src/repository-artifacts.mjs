import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  ASSISTANT_WORKFLOW,
  MODE_IDS,
  MODES,
  PACKAGE_BOOTSTRAP_WORKFLOW,
  POLICY_TARGET,
  RELEASE_MANIFEST_TARGET,
  RUNTIME_WORKFLOWS,
} from "./constants.mjs";

const ARTIFACT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ASSET_PATH =
  /^(?:agents|policies|repository|runtime-workflows|workflows)\/[A-Za-z0-9._/-]+$/;
const CODEKEEPER_TARGET =
  /^(?:\.github\/codekeeper\.json|\.github\/codekeeper\/[A-Za-z0-9._/-]+|\.github\/workflows\/codekeeper-[a-z0-9-]+\.yml)$/;
const OWNERSHIP = new Set(["mixed", "release", "user"]);
const RENDERERS = new Set([
  "assistant-workflow",
  "copy",
  "mode-workflow",
  "policy",
  "profile",
]);
const ACTIVATION_KINDS = new Set(["always", "mode", "profile"]);

function safeCatalogPath(value, pattern) {
  return (
    typeof value === "string" &&
    pattern.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function freezeArtifact(artifact) {
  return Object.freeze({
    ...artifact,
    activation: Object.freeze({ ...artifact.activation }),
    assets: Object.freeze([
      ...(artifact.assets ?? (artifact.asset ? [artifact.asset] : [])),
    ]),
    previousTargets: Object.freeze([...(artifact.previousTargets ?? [])]),
  });
}

const POLICY_ARTIFACT = {
  id: "repository.policy",
  target: POLICY_TARGET,
  assets: ["policies/mixed.json", "policies/openai.json"],
  ownership: "mixed",
  activation: { kind: "always" },
  renderer: "policy",
  validation: "policy",
  purpose: "Policy, model choices, protected paths, and startup controls",
};
const ASSISTANT_ARTIFACT = {
  id: "repository.workflow.assistant",
  target: ASSISTANT_WORKFLOW.target,
  asset: ASSISTANT_WORKFLOW.asset,
  ownership: "release",
  activation: { kind: "always" },
  renderer: "assistant-workflow",
  validation: "caller",
  callerMode: ASSISTANT_WORKFLOW.id,
  purpose: ASSISTANT_WORKFLOW.description,
};
const BOOTSTRAP_ARTIFACT = {
  id: "repository.workflow.bootstrap",
  target: PACKAGE_BOOTSTRAP_WORKFLOW.target,
  asset: PACKAGE_BOOTSTRAP_WORKFLOW.asset,
  ownership: "release",
  activation: { kind: "always" },
  renderer: "copy",
  validation: "digest",
  purpose: PACKAGE_BOOTSTRAP_WORKFLOW.description,
};
const GUIDE_ARTIFACT = {
  id: "repository.guide",
  target: ".github/codekeeper/README.md",
  asset: "repository/README.md",
  ownership: "release",
  activation: { kind: "always" },
  renderer: "copy",
  validation: "digest",
  purpose: "Installed-file ownership and update guidance",
};

export const REPOSITORY_ARTIFACTS = Object.freeze(
  [
    POLICY_ARTIFACT,
    ...AGENT_PROFILE_IDS.map((profile) => ({
      id: `repository.profile.${profile}`,
      target: AGENT_PROFILES[profile].target,
      asset: AGENT_PROFILES[profile].asset,
      ownership: "user",
      activation: { kind: "profile", id: profile },
      renderer: "profile",
      validation: "profile",
      purpose: AGENT_PROFILES[profile].purpose,
    })),
    ASSISTANT_ARTIFACT,
    ...MODE_IDS.map((mode) => ({
      id: `repository.workflow.${mode}`,
      target: MODES[mode].target,
      asset: MODES[mode].asset,
      ownership: "release",
      activation: { kind: "mode", id: mode },
      renderer: "mode-workflow",
      validation: "caller",
      callerMode: mode,
      purpose: MODES[mode].label,
    })),
    BOOTSTRAP_ARTIFACT,
    {
      id: "repository.workflow.runtime.assistant",
      target: RUNTIME_WORKFLOWS.assistant.target,
      asset: RUNTIME_WORKFLOWS.assistant.asset,
      ownership: "release",
      activation: { kind: "always" },
      renderer: "copy",
      validation: "digest",
      purpose: RUNTIME_WORKFLOWS.assistant.description,
    },
    ...MODE_IDS.map((mode) => ({
      id: `repository.workflow.runtime.${mode}`,
      target: RUNTIME_WORKFLOWS[mode].target,
      asset: RUNTIME_WORKFLOWS[mode].asset,
      ownership: "release",
      activation: { kind: "mode", id: mode },
      renderer: "copy",
      validation: "digest",
      purpose: RUNTIME_WORKFLOWS[mode].description,
    })),
    GUIDE_ARTIFACT,
  ].map(freezeArtifact),
);

// Retired release-owned targets stay here until every supported installed
// manifest can migrate past them. This keeps deletion authority explicit.
export const RETIRED_REPOSITORY_ARTIFACTS = Object.freeze([]);

export function validateRepositoryArtifactCatalog({
  artifacts = REPOSITORY_ARTIFACTS,
  retiredArtifacts = RETIRED_REPOSITORY_ARTIFACTS,
} = {}) {
  const ids = new Set();
  const targets = new Set([RELEASE_MANIFEST_TARGET]);
  const callerModes = new Set();
  for (const [index, artifact] of [
    ...artifacts,
    ...retiredArtifacts,
  ].entries()) {
    const retired = index >= artifacts.length;
    const assets =
      artifact?.assets ?? (artifact?.asset ? [artifact.asset] : []);
    if (
      !artifact ||
      typeof artifact !== "object" ||
      !ARTIFACT_ID.test(artifact.id ?? "") ||
      !safeCatalogPath(artifact.target, CODEKEEPER_TARGET) ||
      !OWNERSHIP.has(artifact.ownership)
    ) {
      throw new TypeError(
        "Repository artifact catalog contains an invalid record.",
      );
    }
    if (ids.has(artifact.id) || targets.has(artifact.target)) {
      throw new TypeError(
        "Repository artifact catalog contains a duplicate ID or target.",
      );
    }
    ids.add(artifact.id);
    targets.add(artifact.target);
    for (const previousTarget of artifact.previousTargets ?? []) {
      if (
        artifact.ownership !== "release" ||
        !safeCatalogPath(previousTarget, CODEKEEPER_TARGET) ||
        targets.has(previousTarget)
      ) {
        throw new TypeError(
          "Repository artifact catalog contains an invalid previous target.",
        );
      }
      targets.add(previousTarget);
    }
    if (retired) {
      if (
        artifact.ownership !== "release" ||
        !["caller", "digest"].includes(artifact.validation) ||
        typeof artifact.purpose !== "string" ||
        !artifact.purpose.trim() ||
        (artifact.validation === "caller" &&
          ![ASSISTANT_WORKFLOW.id, ...MODE_IDS].includes(artifact.callerMode)) ||
        (artifact.validation !== "caller" && artifact.callerMode !== undefined)
      ) {
        throw new TypeError(
          "Retired artifacts require explicit release ownership and validation.",
        );
      }
      continue;
    }
    if (
      !RENDERERS.has(artifact.renderer) ||
      !ACTIVATION_KINDS.has(artifact.activation?.kind) ||
      typeof artifact.purpose !== "string" ||
      !artifact.purpose.trim() ||
      !["caller", "digest", "policy", "profile"].includes(
        artifact.validation,
      ) ||
      !assets.length ||
      assets.some((asset) => !safeCatalogPath(asset, ASSET_PATH))
    ) {
      throw new TypeError(
        "Repository artifact catalog contains an invalid active record.",
      );
    }
    if (
      artifact.activation.kind === "mode" &&
      !MODE_IDS.includes(artifact.activation.id)
    ) {
      throw new TypeError(
        "Repository artifact catalog references an unknown mode.",
      );
    }
    if (
      artifact.activation.kind === "profile" &&
      !AGENT_PROFILE_IDS.includes(artifact.activation.id)
    ) {
      throw new TypeError(
        "Repository artifact catalog references an unknown profile.",
      );
    }
    if (
      artifact.ownership === "release" &&
      !["caller", "digest"].includes(artifact.validation)
    ) {
      throw new TypeError(
        "Release-owned artifacts require caller or digest validation.",
      );
    }
    if (
      (artifact.validation === "caller" &&
        ![ASSISTANT_WORKFLOW.id, ...MODE_IDS].includes(artifact.callerMode)) ||
      (artifact.validation !== "caller" && artifact.callerMode !== undefined)
    ) {
      throw new TypeError(
        "Caller artifacts require one explicit supported caller mode.",
      );
    }
    if (artifact.validation === "caller") {
      if (callerModes.has(artifact.callerMode)) {
        throw new TypeError(
          "Repository artifact catalog contains a duplicate caller mode.",
        );
      }
      callerModes.add(artifact.callerMode);
    }
    if (
      (artifact.renderer === "policy") !==
        (artifact.ownership === "mixed" && artifact.validation === "policy") ||
      (artifact.renderer === "profile") !==
        (artifact.ownership === "user" && artifact.validation === "profile") ||
      (artifact.renderer === "copy" &&
        (artifact.ownership !== "release" ||
          artifact.validation !== "digest")) ||
      (artifact.renderer === "mode-workflow" &&
        artifact.activation.kind !== "mode")
    ) {
      throw new TypeError(
        "Repository artifact catalog contains incompatible ownership or rendering rules.",
      );
    }
  }
  return true;
}

validateRepositoryArtifactCatalog();

const REPOSITORY_ARTIFACT_BY_TARGET = new Map([
  ...REPOSITORY_ARTIFACTS.flatMap((artifact) =>
    [artifact.target, ...artifact.previousTargets].map((target) => [
      target,
      artifact,
    ]),
  ),
  ...RETIRED_REPOSITORY_ARTIFACTS.flatMap((artifact) =>
    [artifact.target, ...(artifact.previousTargets ?? [])].map((target) => [
      target,
      artifact,
    ]),
  ),
]);
export function releaseManagedTargets({
  artifacts = REPOSITORY_ARTIFACTS,
  retiredArtifacts = RETIRED_REPOSITORY_ARTIFACTS,
} = {}) {
  validateRepositoryArtifactCatalog({ artifacts, retiredArtifacts });
  return [
    ...new Set([
      ...artifacts
        .filter((artifact) => artifact.ownership === "release")
        .flatMap((artifact) => [
          artifact.target,
          ...(artifact.previousTargets ?? []),
        ]),
      ...retiredArtifacts.flatMap((artifact) => [
        artifact.target,
        ...(artifact.previousTargets ?? []),
      ]),
    ]),
  ];
}

export function createReleaseManagedCatalog({
  artifacts = REPOSITORY_ARTIFACTS,
  retiredArtifacts = RETIRED_REPOSITORY_ARTIFACTS,
} = {}) {
  validateRepositoryArtifactCatalog({ artifacts, retiredArtifacts });
  const managedArtifacts = Object.freeze(
    artifacts.filter((artifact) => artifact.ownership === "release"),
  );
  const artifactByTarget = new Map([
    ...managedArtifacts.flatMap((artifact) =>
      [artifact.target, ...(artifact.previousTargets ?? [])].map((target) => [
        target,
        artifact,
      ]),
    ),
    ...retiredArtifacts.flatMap((artifact) =>
      [artifact.target, ...(artifact.previousTargets ?? [])].map((target) => [
        target,
        artifact,
      ]),
    ),
  ]);
  const callerArtifactByMode = new Map();
  for (const artifact of managedArtifacts) {
    if (artifact.validation !== "caller") continue;
    callerArtifactByMode.set(artifact.callerMode, artifact);
  }
  return Object.freeze({
    artifacts: managedArtifacts,
    targets: Object.freeze(
      releaseManagedTargets({ artifacts, retiredArtifacts }),
    ),
    artifactForTarget(target) {
      return artifactByTarget.get(target) ?? null;
    },
    callerArtifactForMode(mode) {
      return callerArtifactByMode.get(mode) ?? null;
    },
  });
}

export const RELEASE_MANAGED_CATALOG = createReleaseManagedCatalog();
export const RELEASE_MANAGED_ARTIFACTS = RELEASE_MANAGED_CATALOG.artifacts;
export const RELEASE_MANAGED_TARGETS = RELEASE_MANAGED_CATALOG.targets;
export const ASSET_KEYS = Object.freeze(
  [
    ...new Set([
      ...REPOSITORY_ARTIFACTS.flatMap((artifact) => artifact.assets),
    ]),
  ].sort(),
);
export const KNOWN_TARGETS = Object.freeze([
  ...REPOSITORY_ARTIFACT_BY_TARGET.keys(),
  RELEASE_MANIFEST_TARGET,
]);

export function repositoryArtifactForTarget(target) {
  return REPOSITORY_ARTIFACT_BY_TARGET.get(target) ?? null;
}

export function releaseManagedArtifactForTarget(target) {
  return RELEASE_MANAGED_CATALOG.artifactForTarget(target);
}

export function activeRepositoryArtifacts({ modes, profileSources = {} }) {
  if (!Array.isArray(modes) || modes.some((mode) => !MODE_IDS.includes(mode))) {
    throw new TypeError(
      "Repository artifact activation references an unknown mode.",
    );
  }
  const selectedModes = new Set(modes);
  return REPOSITORY_ARTIFACTS.filter((artifact) => {
    if (artifact.activation.kind === "always") return true;
    if (artifact.activation.kind === "mode")
      return selectedModes.has(artifact.activation.id);
    return Object.hasOwn(profileSources, artifact.target);
  });
}
