import {
  reviewAppAuthority,
  reviewAppRegistrationUrl,
} from "./app-authority.mjs";
import { installReview } from "./install.mjs";
import { createReviewSetupPullRequest } from "./setup-pr.mjs";

function usage() {
  return "Usage:\n  rivet init --review-only [--repository <path>] [--dry-run | --setup-pr] [--setup-branch <name>]\n  rivet app-plan --repository <owner/repository> [--owner-type <User|Organization>]";
}

function parseAppPlan(args) {
  const options = { ownerType: "User" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repository" && args[index + 1]) {
      options.repository = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--owner-type" && args[index + 1]) {
      options.ownerType = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Rivet: unknown argument ${argument}\n${usage()}`);
  }
  if (!options.repository) {
    throw new Error(`Rivet: --repository is required\n${usage()}`);
  }
  return options;
}

function parseInit(args) {
  const options = { dryRun: false, setupPullRequest: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--review-only") continue;
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--setup-pr") {
      options.setupPullRequest = true;
      continue;
    }
    if (argument === "--setup-branch" && args[index + 1]) {
      options.branch = args[index + 1];
      index += 1;
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
  if (options.dryRun && options.setupPullRequest) {
    throw new Error(
      `Rivet: --dry-run and --setup-pr cannot be combined\n${usage()}`,
    );
  }
  if (options.branch && !options.setupPullRequest) {
    throw new Error(`Rivet: --setup-branch requires --setup-pr\n${usage()}`);
  }
  return options;
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    installReviewImpl = installReview,
    createSetupPullRequestImpl = createReviewSetupPullRequest,
    stdout = process.stdout,
  } = {},
) {
  const [command, ...args] = argv;
  if (command === "app-plan") {
    const options = parseAppPlan(args);
    const result = Object.freeze({
      repository: options.repository,
      authority: reviewAppAuthority(),
      registrationUrl: reviewAppRegistrationUrl(options),
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command !== "init") throw new Error(`Rivet: unknown command\n${usage()}`);
  const options = parseInit(args);
  const { setupPullRequest, ...installationOptions } = options;
  const result = setupPullRequest
    ? await createSetupPullRequestImpl(installationOptions)
    : await installReviewImpl(installationOptions);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
