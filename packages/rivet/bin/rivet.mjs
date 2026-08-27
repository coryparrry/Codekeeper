#!/usr/bin/env node
import { runCli } from "../src/cli.mjs";

runCli().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
