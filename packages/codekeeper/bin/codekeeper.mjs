#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";
import { formatInstallerError } from "../src/errors.mjs";
import { runLatestInit } from "../src/updater.mjs";

const argv = process.argv.slice(2);
const exactPackage = typeof process.env.CODEKEEPER_UPDATE_EXPECTED_VERSION === "string"
  && typeof process.env.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY === "string";
try {
  process.exitCode = argv.length === 1 && argv[0] === "init" && !exactPackage
    ? await runLatestInit()
    : await runCli();
} catch (error) {
  process.stderr.write(`${formatInstallerError(error)}\n`);
  process.exitCode = 1;
}
