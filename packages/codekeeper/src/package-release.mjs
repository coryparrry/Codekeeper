import { PACKAGE_NAME, PACKAGE_VERSION } from "./constants.mjs";
import { InstallerError } from "./errors.mjs";

export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;

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
  if (!value || value.name !== expectedName || (expectedVersion !== undefined && value.version !== expectedVersion) || !RELEASE_VERSION.test(value.version)) {
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
