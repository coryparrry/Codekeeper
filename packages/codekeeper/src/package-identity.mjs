import { createRequire } from "node:module";

const packageManifest = createRequire(import.meta.url)("../package.json");

if (
  packageManifest?.name !== "codekeeper"
  || typeof packageManifest.version !== "string"
) {
  throw new Error("Codekeeper package identity is invalid.");
}

export const PACKAGE_NAME = packageManifest.name;
export const PACKAGE_VERSION = packageManifest.version;
export const PACKAGE_SOURCE_REPOSITORY = "coryparry/Codekeeper";
export const PACKAGE_SOURCE_REPOSITORY_URL = `https://github.com/${PACKAGE_SOURCE_REPOSITORY}`;
