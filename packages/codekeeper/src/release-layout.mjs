import { RELEASE_PACKAGE_ASSETS } from "./constants.mjs";

export const RELEASE_DIRECTORY_MAPPINGS = Object.freeze([
  ["packages/codekeeper/assets", "assets"],
  ["packages/codekeeper/bin", "bin"],
  ["packages/codekeeper/src", "src"],
  ["tools/codekeeper/agents", "runtime/agents"],
  ["tools/codekeeper/integrations", "runtime/integrations"],
  ["tools/codekeeper/presets", "runtime/presets"],
  ["tools/codekeeper/src", "runtime/src"],
]);

export const RELEASE_DIRECTORY_EXCLUSIONS = Object.freeze(new Map([
  ["tools/codekeeper/integrations", new Set([
    "braintrust/package.json",
    "braintrust/package-lock.json",
    "braintrust/npm-shrinkwrap.json",
  ])],
]));

const STATIC_FILE_MAPPINGS = Object.freeze([
  ["packages/codekeeper/LICENSE", "LICENSE"],
  ["packages/codekeeper/README.md", "README.md"],
  ["packages/codekeeper/package.json", "package.json"],
  ["packages/codekeeper/npm-shrinkwrap.json", "npm-shrinkwrap.json"],
  ["packages/codekeeper/runtime-package/package.json", "runtime/package.json"],
  ["packages/codekeeper/runtime-package/npm-shrinkwrap.json", "runtime/npm-shrinkwrap.json"],
  ["tools/codekeeper/scripts/verify-tooling-artifact.mjs", "runtime/scripts/verify-tooling-artifact.mjs"],
]);

export const RELEASE_FILE_MAPPINGS = Object.freeze([
  ...STATIC_FILE_MAPPINGS,
  ...RELEASE_PACKAGE_ASSETS.map(({ sourcePath, packagePath }) => [sourcePath, packagePath]),
]);

export const RELEASE_PUBLISHED_PATHS = Object.freeze([...new Set([
  ...RELEASE_DIRECTORY_MAPPINGS.map(([, stageDirectory]) => `${stageDirectory.split("/")[0]}/`),
  ...RELEASE_FILE_MAPPINGS
    .map(([, stagePath]) => stagePath)
    .filter((stagePath) => stagePath !== "package.json")
    .map((stagePath) => stagePath.includes("/") ? `${stagePath.split("/")[0]}/` : stagePath),
  "release/",
])].sort());
