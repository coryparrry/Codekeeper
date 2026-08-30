import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageUrl = new URL("../package.json", import.meta.url);
const PACKAGE_NAME = "@coryparry/rivet";
const PACKAGE_REPOSITORY = "git+https://github.com/coryparrry/Codekeeper.git";

function fail(message) {
  throw new Error(`release-check: ${message}`);
}

export function tagForVersion(version) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    fail(`version must be a valid semver release, received ${version}`);
  }
  return `rivet-v${version}`;
}

export function validateReleasePackage(pkg, tag) {
  if (pkg.name !== PACKAGE_NAME) fail(`package name must be ${PACKAGE_NAME}`);
  if (pkg.private === true) fail("package must be publishable");
  if (pkg.publishConfig?.access !== "public") {
    fail("publishConfig.access must be public");
  }
  if (pkg.publishConfig?.registry !== "https://registry.npmjs.org/") {
    fail("publishConfig.registry must target npmjs");
  }
  if (pkg.repository?.url !== PACKAGE_REPOSITORY) {
    fail("repository.url must identify the publishing GitHub repository");
  }
  const expectedTag = tagForVersion(pkg.version);
  if (tag !== expectedTag) {
    fail(`tag ${tag} must exactly match package version ${expectedTag}`);
  }
  return { name: pkg.name, version: pkg.version, tag };
}

export async function readPackage() {
  return JSON.parse(await readFile(packageUrl, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [flag, tag] = process.argv.slice(2);
  if (flag !== "--tag" || !tag || process.argv.length !== 4) {
    fail("usage: node scripts/release-check.mjs --tag rivet-v<version>");
  }
  const release = validateReleasePackage(await readPackage(), tag);
  process.stdout.write(`${release.name}@${release.version} is ready for ${release.tag}\n`);
}
