import { createRequire } from "node:module";

const packageManifest = createRequire(import.meta.url)("../package.json");

if (
  packageManifest?.name !== "@coryparry/codekeeper"
  || typeof packageManifest.version !== "string"
) {
  throw new Error("Codekeeper package identity is invalid.");
}

export const PACKAGE_NAME = packageManifest.name;
export const PACKAGE_VERSION = packageManifest.version;
export const PACKAGE_SOURCE_REPOSITORY = "coryparrry/Codekeeper";
export const PACKAGE_SOURCE_REPOSITORY_URL = `https://github.com/${PACKAGE_SOURCE_REPOSITORY}`;

export function npmTarballFilename(name = PACKAGE_NAME, version = PACKAGE_VERSION) {
  const slug = name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name;
  return `${slug}-${version}.tgz`;
}
