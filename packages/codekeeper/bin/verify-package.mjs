#!/usr/bin/env node

import { verifyCodekeeperRelease } from "../src/release-verifier.mjs";

const REQUIRED_FLAGS = Object.freeze([
  "root",
  "expected-name",
  "expected-version",
  "expected-integrity",
  "expected-manifest-sha256",
  "expected-source-commit",
]);

function fail(message) {
  throw new Error(`${message}\nUsage: codekeeper-verify-package ${REQUIRED_FLAGS.map((flag) => `--${flag} VALUE`).join(" ")}`);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) fail("Every verifier flag requires one value.");
    const name = flag.slice(2);
    if (!REQUIRED_FLAGS.includes(name) || Object.hasOwn(values, name)) fail(`Unknown or duplicate verifier flag: ${flag}`);
    values[name] = value;
  }
  for (const flag of REQUIRED_FLAGS) if (!Object.hasOwn(values, flag)) fail(`Missing required verifier flag: --${flag}`);
  return values;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const manifest = await verifyCodekeeperRelease({
    root: values.root,
    expectedName: values["expected-name"],
    expectedVersion: values["expected-version"],
    expectedIntegrity: values["expected-integrity"],
    expectedManifestSha256: values["expected-manifest-sha256"],
    expectedSourceCommit: values["expected-source-commit"],
  });
  process.stdout.write(`CODEKEEPER_PACKAGE_VERIFIED name=${manifest.package.name} version=${manifest.package.version} source=${manifest.source.commit}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
