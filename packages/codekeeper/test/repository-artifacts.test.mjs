import test from "node:test";
import assert from "node:assert/strict";
import { renderInstallFiles, sha256 } from "../src/assets.mjs";
import { RELEASE_MANIFEST_TARGET } from "../src/constants.mjs";
import { buildInstallPlan } from "../src/plan.mjs";
import {
  activeRepositoryArtifacts,
  ASSET_KEYS,
  KNOWN_TARGETS,
  RELEASE_MANAGED_CATALOG,
  RELEASE_MANAGED_TARGETS,
  REPOSITORY_ARTIFACTS,
  releaseManagedTargets,
  validateRepositoryArtifactCatalog,
} from "../src/repository-artifacts.mjs";
import { loadVerifiedAssets } from "./helpers.mjs";

const HEAD_SHA = "a".repeat(40);

function answers(overrides = {}) {
  return {
    modes: ["review"],
    preset: "openai",
    displayName: "Widget",
    ownerLogins: ["cory"],
    appClientId: "Iv123456789012345678",
    automationBotLogin: "codekeeper-widget[bot]",
    enabled: true,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    root: "/tmp/widget",
    repository: "acme/widget",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    viewerLogin: "cory",
    ...overrides,
  };
}

function copiedArtifact(overrides = {}) {
  return {
    id: "repository.example",
    target: ".github/codekeeper/example.md",
    asset: "repository/example.md",
    ownership: "release",
    activation: { kind: "always" },
    renderer: "copy",
    validation: "digest",
    purpose: "Example release documentation",
    ...overrides,
  };
}

test("repository artifact catalog is canonical and complete", () => {
  assert.equal(validateRepositoryArtifactCatalog(), true);
  assert.equal(
    new Set(REPOSITORY_ARTIFACTS.map(({ id }) => id)).size,
    REPOSITORY_ARTIFACTS.length,
  );
  assert.equal(new Set(KNOWN_TARGETS).size, KNOWN_TARGETS.length);
  assert.ok(ASSET_KEYS.includes("repository/README.md"));
  assert.ok(RELEASE_MANAGED_TARGETS.includes(".github/codekeeper/README.md"));
  assert.equal(
    RELEASE_MANAGED_CATALOG.callerArtifactForMode("review").target,
    ".github/workflows/codekeeper.yml",
  );
});

test("catalog data represents additions, renames, and retirements without reconciliation code", () => {
  const renamed = copiedArtifact({
    previousTargets: [".github/codekeeper/old-example.md"],
  });
  const retired = {
    id: "repository.retired",
    target: ".github/codekeeper/retired.md",
    ownership: "release",
    validation: "digest",
    purpose: "Retired example documentation",
  };
  assert.equal(
    validateRepositoryArtifactCatalog({
      artifacts: [renamed],
      retiredArtifacts: [retired],
    }),
    true,
  );
  assert.deepEqual(
    releaseManagedTargets({
      artifacts: [renamed],
      retiredArtifacts: [retired],
    }),
    [
      ".github/codekeeper/example.md",
      ".github/codekeeper/old-example.md",
      ".github/codekeeper/retired.md",
    ],
  );
  assert.throws(
    () =>
      validateRepositoryArtifactCatalog({
        artifacts: [renamed, copiedArtifact()],
        retiredArtifacts: [],
      }),
    /duplicate ID or target/,
  );
  assert.throws(
    () =>
      validateRepositoryArtifactCatalog({
        artifacts: [copiedArtifact({ target: "README.md" })],
        retiredArtifacts: [],
      }),
    /invalid record/,
  );
  assert.throws(
    () =>
      validateRepositoryArtifactCatalog({
        artifacts: [],
        retiredArtifacts: [{ ...retired, ownership: "user" }],
      }),
    /Retired artifacts require explicit release ownership/,
  );
  const caller = REPOSITORY_ARTIFACTS.find(
    ({ validation }) => validation === "caller",
  );
  assert.throws(
    () =>
      validateRepositoryArtifactCatalog({
        artifacts: [{ ...caller, callerModes: [] }],
        retiredArtifacts: [],
      }),
    /explicit supported caller mode/,
  );
  assert.throws(
    () =>
      validateRepositoryArtifactCatalog({
        artifacts: [caller, {
          ...caller,
          id: `${caller.id}.duplicate`,
          target: ".github/workflows/codekeeper-assistant-copy.yml",
        }],
        retiredArtifacts: [],
      }),
    /duplicate caller mode/,
  );
});

test("activation is data-driven for modes and optional profiles", () => {
  const active = activeRepositoryArtifacts({
    modes: ["review"],
    profileSources: {},
  });
  assert.ok(active.some(({ id }) => id === "repository.workflow.caller"));
  assert.ok(active.some(({ id }) => id === "repository.workflow.runtime"));
  assert.ok(active.some(({ id }) => id === "repository.guide"));
  assert.ok(!active.some(({ id }) => id === "repository.workflow.fix"));
  assert.ok(!active.some(({ id }) => id.startsWith("repository.profile.")));
  assert.throws(
    () => activeRepositoryArtifacts({ modes: ["unknown"], profileSources: {} }),
    /unknown mode/,
  );
});

test("release-owned Markdown is rendered and digest-bound by the installation manifest", async () => {
  const bundle = await loadVerifiedAssets();
  const files = renderInstallFiles(bundle, {
    modes: ["review"],
    preset: "openai",
    displayName: "Widget",
    defaultBranch: "main",
    ownerLogins: ["cory"],
  });
  const guide = files.find(
    ({ path }) => path === ".github/codekeeper/README.md",
  );
  const manifest = JSON.parse(
    files.find(({ path }) => path === ".github/codekeeper-release.json")
      .contents,
  );
  assert.equal(guide.contents, bundle.contents["repository/README.md"]);
  assert.equal(manifest.managedFiles[guide.path], sha256(guide.contents));
});

test("a release update advances a catalogued Markdown asset without file-specific planning", async () => {
  const bundle = await loadVerifiedAssets();
  const initial = buildInstallPlan({
    bundle,
    snapshot: snapshot(),
    answers: answers(),
  });
  const contents = Object.fromEntries(
    initial.files.map((file) => [file.path, file.contents]),
  );
  const guideTarget = ".github/codekeeper/README.md";
  const updatedGuide = `${bundle.contents["repository/README.md"]}\nRelease update.\n`;
  const updatedBundle = {
    ...bundle,
    contents: { ...bundle.contents, "repository/README.md": updatedGuide },
  };
  const updated = buildInstallPlan({
    bundle: updatedBundle,
    snapshot: snapshot({
      installation: {
        policy: JSON.parse(contents[".github/codekeeper.json"]),
        policySource: contents[".github/codekeeper.json"],
        modes: ["review"],
        contents,
        releaseManifest: JSON.parse(contents[RELEASE_MANIFEST_TARGET]),
      },
      existingSettings: {
        enabled: true,
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-widget[bot]",
      },
      updateBranch: `codekeeper/update-${HEAD_SHA.slice(0, 12)}`,
    }),
    answers: answers({ releaseUpdate: true }),
  });
  assert.deepEqual(
    updated.files.map(({ path }) => path),
    [guideTarget, RELEASE_MANIFEST_TARGET],
  );
  assert.equal(updated.files[0].contents, updatedGuide);
  assert.equal(updated.files[0].previousSha256, sha256(contents[guideTarget]));
});
