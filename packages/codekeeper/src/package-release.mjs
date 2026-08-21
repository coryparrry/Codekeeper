import { PACKAGE_NAME, PACKAGE_VERSION } from "./constants.mjs";
import { InstallerError } from "./errors.mjs";

const MAX_RELEASE_VERSION_LENGTH = 256;
const DECIMAL_IDENTIFIER = /^(?:0|[1-9][0-9]*)$/;
const NUMERIC_IDENTIFIER = /^[0-9]+$/;
const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/;
export const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;

function validIdentifiers(value, { allowNumericLeadingZeroes }) {
  const identifiers = value.split(".");
  return identifiers.every((identifier) => {
    if (!SEMVER_IDENTIFIER.test(identifier)) return false;
    return allowNumericLeadingZeroes || !NUMERIC_IDENTIFIER.test(identifier) || DECIMAL_IDENTIFIER.test(identifier);
  });
}

export function isReleaseVersion(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RELEASE_VERSION_LENGTH) return false;

  const [withoutBuild, build, extraBuild] = value.split("+");
  if (extraBuild !== undefined || (build !== undefined && !validIdentifiers(build, { allowNumericLeadingZeroes: true }))) return false;

  const separator = withoutBuild.indexOf("-");
  const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease = separator === -1 ? null : withoutBuild.slice(separator + 1);
  const coreIdentifiers = core.split(".");
  return coreIdentifiers.length === 3
    && coreIdentifiers.every((identifier) => DECIMAL_IDENTIFIER.test(identifier))
    && (prerelease === null || validIdentifiers(prerelease, { allowNumericLeadingZeroes: false }));
}

export function validSha512Integrity(value) {
  if (typeof value !== "string") return false;
  const match = SHA512_INTEGRITY.exec(value);
  if (!match) return false;
  const encoded = match[1];
  const digest = Buffer.from(encoded, "base64");
  return digest.length === 64 && digest.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "");
}

export function normalizePackageIdentity(value, options = {}) {
  const expectedName = options.expectedName ?? PACKAGE_NAME;
  const expectedVersion = Object.hasOwn(options, "expectedVersion") ? options.expectedVersion : PACKAGE_VERSION;
  const code = options.code ?? "PACKAGE_RELEASE_INVALID";
  if (!value || value.name !== expectedName || (expectedVersion !== undefined && value.version !== expectedVersion) || !isReleaseVersion(value.version)) {
    throw new InstallerError("The Codekeeper package identity is missing or invalid.", { code });
  }
  return Object.freeze({ name: value.name, version: value.version });
}

export function normalizePackageRelease(value, options = {}) {
  const expectedName = options.expectedName ?? PACKAGE_NAME;
  const expectedVersion = Object.hasOwn(options, "expectedVersion") ? options.expectedVersion : PACKAGE_VERSION;
  const code = options.code ?? "PACKAGE_RELEASE_INVALID";
  const identity = normalizePackageIdentity(value, {
    expectedName,
    expectedVersion,
    code
  });
  if (!validSha512Integrity(value.integrity)) {
    throw new InstallerError("The exact Codekeeper package release receipt is missing or invalid.", { code });
  }
  return Object.freeze({ ...identity, integrity: value.integrity });
}
