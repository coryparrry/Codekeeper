#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  PACKAGE_NAME,
  PACKAGE_SOURCE_REPOSITORY_URL,
  PACKAGE_VERSION,
} from "../src/package-identity.mjs";
import {
  RELEASE_MANIFEST_PATH,
  verifyCodekeeperRelease,
} from "../src/release-verifier.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`Codekeeper publication guard rejected this directory: ${message}`);
}

async function requireRegularFile(root, relativePath, label) {
  let information;
  try {
    information = await lstat(path.join(root, ...relativePath.split("/")));
  } catch (error) {
    if (error?.code === "ENOENT") fail(`missing ${label}; publish only a generated release stage or its verified tarball`);
    throw error;
  }
  if (information.isSymbolicLink() || !information.isFile()) {
    fail(`${label} is not a regular file`);
  }
}

async function main() {
  const root = process.cwd();
  await requireRegularFile(root, RELEASE_MANIFEST_PATH, "release manifest");
  await requireRegularFile(root, "bin/verify-package.mjs", "package verifier");

  let manifest;
  try {
    manifest = await verifyCodekeeperRelease({
      root,
      expectedName: PACKAGE_NAME,
      expectedVersion: PACKAGE_VERSION,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "release verification failed");
  }

  if (
    manifest.source.repository !== PACKAGE_SOURCE_REPOSITORY_URL
    || !FULL_COMMIT.test(manifest.source.commit)
  ) {
    fail("release manifest does not bind this package to an exact Codekeeper source commit");
  }

  process.stdout.write(
    `Verified generated Codekeeper release stage ${manifest.package.name}@${manifest.package.version} from ${manifest.source.commit}.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
