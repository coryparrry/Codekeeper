#!/usr/bin/env node
import { createGhRunner, formatUsage, parseCommandLine, preflight, runScenario } from "../src/harness.mjs";

async function main() {
  let parsed;
  try {
    parsed = parseCommandLine(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${formatUsage()}\n`);
    return 2;
  }

  if (parsed.command === "help") {
    process.stdout.write(`${formatUsage()}\n`);
    return 0;
  }

  const gh = createGhRunner();
  try {
    if (parsed.command === "preflight") {
      await preflight({ repo: parsed.options.repo, gh });
      process.stdout.write(`Preflight passed for ${parsed.options.repo}. No mutation was attempted.\n`);
      return 0;
    }

    const result = await runScenario({
      scenario: parsed.command,
      options: parsed.options,
      gh
    });
    process.stdout.write(`${result.passed ? "Passed" : "Failed"} ${parsed.command}; bounded evidence: ${result.evidencePath}\n`);
    return result.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

const exitCode = await main();
process.exitCode = exitCode;
