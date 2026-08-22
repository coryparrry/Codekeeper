import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  ASSISTANT_WORKFLOW,
  GENERIC_RUNTIME_WORKFLOW,
  MODE_IDS,
  PACKAGE_ACQUIRE_ACTION,
  POLICY_TARGET,
  RELEASE_MANIFEST_TARGET,
  UNIFIED_CALLER_WORKFLOW,
} from "./constants.mjs";
import { MODE_REGISTRY } from "./mode-registry.mjs";

const ARTIFACT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ASSET_PATH =
  /^(?:agents|policies|repository|runtime-actions|runtime-workflows|workflows)\/[A-Za-z0-9._/-]+$/;
const CODEKEEPER_TARGET =
  /^(?:\.github\/codekeeper\.json|\.github\/codekeeper\/[A-Za-z0-9._/-]+|\.github\/workflows\/codekeeper(?:-[a-z0-9-]+)?\.yml)$/;
const OWNERSHIP = new Set(["mixed", "release", "user"]);
const RENDERERS = new Set([
  "copy",
  "policy",
  "profile",
  "unified-workflow",
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
    callerModes: Object.freeze([...(artifact.callerModes ?? [])]),
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
const CALLER_ARTIFACT = {
  id: "repository.workflow.caller",
  target: UNIFIED_CALLER_WORKFLOW.target,
  asset: UNIFIED_CALLER_WORKFLOW.asset,
  ownership: "release",
  activation: { kind: "always" },
  renderer: "unified-workflow",
  validation: "caller",
  callerModes: [ASSISTANT_WORKFLOW.id, ...MODE_IDS],
  purpose: UNIFIED_CALLER_WORKFLOW.description,
};
const PACKAGE_ACTION_ARTIFACT = {
  id: "repository.action.acquire-package",
  target: PACKAGE_ACQUIRE_ACTION.target,
  asset: PACKAGE_ACQUIRE_ACTION.asset,
  ownership: "release",
  activation: { kind: "always" },
  renderer: "copy",
  validation: "digest",
  purpose: PACKAGE_ACQUIRE_ACTION.description,
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
    CALLER_ARTIFACT,
    PACKAGE_ACTION_ARTIFACT,
    {
      id: "repository.workflow.runtime",
      target: GENERIC_RUNTIME_WORKFLOW.target,
      asset: GENERIC_RUNTIME_WORKFLOW.asset,
      ownership: "release",
      activation: { kind: "always" },
      renderer: "copy",
      validation: "digest",
      purpose: GENERIC_RUNTIME_WORKFLOW.description,
    },
    GUIDE_ARTIFACT,
  ].map(freezeArtifact),
);

// Retired release-owned targets stay here until every supported installed
// manifest can migrate past them. This keeps deletion authority explicit.
export const RETIRED_REPOSITORY_ARTIFACTS = Object.freeze([
  freezeArtifact({
    id: "repository.workflow.bootstrap",
    target: ".github/workflows/codekeeper-bootstrap.yml",
    ownership: "release",
    validation: "digest",
    purpose: "Retired per-run package bootstrap workflow",
  }),
  freezeArtifact({
    id: "repository.workflow.assistant",
    target: ASSISTANT_WORKFLOW.target,
    ownership: "release",
    validation: "caller",
    callerModes: [ASSISTANT_WORKFLOW.id],
    purpose: "Retired repository assistant caller",
  }),
  ...MODE_IDS.map((mode) => freezeArtifact({
    id: `repository.workflow.${mode}`,
    target: MODE_REGISTRY[mode].caller.target,
    ownership: "release",
    validation: "caller",
    callerModes: [mode],
    purpose: `Retired ${MODE_REGISTRY[mode].label.toLowerCase()} caller`,
  })),
  freezeArtifact({
    id: "repository.workflow.runtime.assistant",
    target: ".github/workflows/codekeeper-runtime-assistant.yml",
    ownership: "release",
    validation: "digest",
    purpose: "Retired repository assistant runtime wrapper",
  }),
  ...MODE_IDS.map((mode) => freezeArtifact({
    id: `repository.workflow.runtime.${mode}`,
    target: MODE_REGISTRY[mode].runtime.target,
    ownership: "release",
    validation: "digest",
    purpose: `Retired ${MODE_REGISTRY[mode].label.toLowerCase()} runtime wrapper`,
  })),
]);

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
    const artifactCallerModes = artifact?.callerModes ?? [];
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
          (artifactCallerModes.length !== 1 ||
            ![ASSISTANT_WORKFLOW.id, ...MODE_IDS].includes(artifactCallerModes[0]))) ||
        (artifact.validation !== "caller" && artifactCallerModes.length !== 0)
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
        (artifactCallerModes.length === 0 ||
          artifactCallerModes.some((mode) =>
            ![ASSISTANT_WORKFLOW.id, ...MODE_IDS].includes(mode)))) ||
      (artifact.validation !== "caller" && artifactCallerModes.length !== 0)
    ) {
      throw new TypeError(
        "Caller artifacts require one explicit supported caller mode.",
      );
    }
    if (artifact.validation === "caller") {
      for (const mode of artifactCallerModes) {
        if (callerModes.has(mode)) {
          throw new TypeError(
            "Repository artifact catalog contains a duplicate caller mode.",
          );
        }
        callerModes.add(mode);
      }
    }
    if (
      (artifact.renderer === "policy") !==
        (artifact.ownership === "mixed" && artifact.validation === "policy") ||
      (artifact.renderer === "profile") !==
        (artifact.ownership === "user" && artifact.validation === "profile") ||
      (artifact.renderer === "copy" &&
        (artifact.ownership !== "release" ||
          artifact.validation !== "digest")) ||
      (artifact.renderer === "unified-workflow" &&
        (artifact.activation.kind !== "always" ||
          artifact.validation !== "caller"))
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
    for (const mode of artifact.callerModes) {
      callerArtifactByMode.set(mode, artifact);
    }
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
