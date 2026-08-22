import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCodekeeperDistribution,
  resolveDistributionCommit,
} from "../packages/codekeeper/src/distribution.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

function fail(message) {
  throw new Error(`Codekeeper distribution: ${message}`);
}

function commandArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--destination" && value) {
      values.destination = path.resolve(value);
      index += 1;
      continue;
    }
    if (flag === "--source-commit" && value) {
      values.sourceCommit = value;
      index += 1;
      continue;
    }
    if (flag === "--repository-root" && value) {
      values.repositoryRoot = path.resolve(value);
      index += 1;
      continue;
    }
    fail("usage: node scripts/generate-codekeeper-distribution.mjs --destination DIRECTORY [--source-commit SHA]");
  }
  if (!values.destination) {
    fail("usage: node scripts/generate-codekeeper-distribution.mjs --destination DIRECTORY [--source-commit SHA]");
  }
  return values;
}

export async function main(args = process.argv.slice(2)) {
  const { destination, sourceCommit, repositoryRoot = DEFAULT_REPOSITORY_ROOT } = commandArguments(args);
  const commit = resolveDistributionCommit(sourceCommit, repositoryRoot);
  const { metadata } = await generateCodekeeperDistribution({
    repositoryRoot,
    destination,
    sourceCommit: commit,
  });
  process.stdout.write(`${JSON.stringify({ destination, sourceCommit: metadata.source.commit })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
