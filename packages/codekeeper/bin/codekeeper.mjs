#!/usr/bin/env node
import { createCommandRunner } from "../src/command-runner.mjs";
import { runCli } from "../src/cli.mjs";
import { formatInstallerError } from "../src/errors.mjs";
import { runLatestInit } from "../src/updater.mjs";

const argv = process.argv.slice(2);
const exactPackage = argv.includes("--current-package");

try {
  if (argv[0] === "resume") {
    const { runRecoveryCli } = await import("../src/recovery.mjs");
    process.exitCode = await runRecoveryCli({
      argv: argv.slice(1),
      runner: createCommandRunner()
    });
  } else if (argv[0] === "remove") {
    const { runRemovalCli } = await import("../src/removal.mjs");
    process.exitCode = await runRemovalCli({
      argv: argv.slice(1),
      runner: createCommandRunner()
    });
  } else {
    process.exitCode =
      argv.length === 1 && argv[0] === "init" && !exactPackage
        ? await runLatestInit()
        : await runCli();
  }
} catch (error) {
  process.stderr.write(`${formatInstallerError(error)}\n`);
  process.exitCode = 1;
}
