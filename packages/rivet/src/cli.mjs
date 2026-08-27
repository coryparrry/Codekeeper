import { installReview } from "./install.mjs";

function usage() {
  return "Usage: rivet init --review-only [--repository <path>] [--dry-run]";
}

function parseInit(args) {
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--review-only") continue;
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--repository" && args[index + 1]) {
      options.repositoryRoot = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Rivet: unknown argument ${argument}\n${usage()}`);
  }
  if (!args.includes("--review-only")) {
    throw new Error(`Rivet: --review-only is required\n${usage()}`);
  }
  return options;
}

export async function runCli(
  argv = process.argv.slice(2),
  { installReviewImpl = installReview, stdout = process.stdout } = {},
) {
  const [command, ...args] = argv;
  if (command !== "init") throw new Error(`Rivet: unknown command\n${usage()}`);
  const result = await installReviewImpl(parseInit(args));
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
