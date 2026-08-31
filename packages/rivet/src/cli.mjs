import {
  reviewAppAuthority,
  reviewAppRegistrationUrl,
} from "./app-authority.mjs";
import { DEFAULT_RIVET_CONFIG } from "./config.mjs";
import { installRepair, installReview } from "./install.mjs";
import {
  createRepairSetupPullRequest,
  createReviewSetupPullRequest,
} from "./setup-pr.mjs";
import {
  configureReviewApp,
  verifyRepairApp,
  verifyReviewApp,
} from "./app-setup.mjs";
import { runGuidedInit } from "./guided-init.mjs";

export const USAGE = `Rivet repository maintenance

Usage:
  npx @coryparry/rivet init
  rivet init

Guided setup:
  init                         Start the review-only guided setup.

Explicit commands (advanced/noninteractive):
  init --review-only [--repository <path>] [--dry-run | --setup-pr]
             [--maintenance <disabled|manual|scheduled>]
             [--setup-branch <name>]
                               Install review workflows with explicit options.
  init --repair [--repository <path>] [--dry-run | --setup-pr]
             [--setup-branch <name>]
                               Upgrade an existing install with explicit options.
  app-plan --repository <owner/repository> [--owner-type <User|Organization>]
                               Print the required GitHub App permissions.
  app-configure --repository <owner/repository> --client-id <id>
                 --private-key-file <path>
                               Configure an App from explicit credentials.
  app-verify --repository <owner/repository> --client-id <id>
             --private-key-file <path> [--repair]
                               Verify explicit App credentials and permissions.

Run rivet init --help for this help. The guided setup does not configure repair mode.
`;

function usage() {
  return USAGE;
}

function parseAppCredentials(args, { allowRepair = false } = {}) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--repair" && allowRepair) {
      options.repair = true;
      continue;
    } else if (argument === "--repository" && value) options.repository = value;
    else if (argument === "--client-id" && value) options.clientId = value;
    else if (argument === "--private-key-file" && value) {
      options.privateKeyPath = value;
    } else {
      throw new Error(`Rivet: unknown argument ${argument}\n${usage()}`);
    }
    index += 1;
  }
  for (const [name, value] of [
    ["--repository", options.repository],
    ["--client-id", options.clientId],
    ["--private-key-file", options.privateKeyPath],
  ]) {
    if (!value) throw new Error(`Rivet: ${name} is required\n${usage()}`);
  }
  return options;
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
  const options = { dryRun: false, setupPullRequest: false, mode: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--review-only" || argument === "--repair") {
      if (options.mode) {
        throw new Error(`Rivet: choose one init mode\n${usage()}`);
      }
      options.mode = argument === "--repair" ? "repair" : "review";
      continue;
    }
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
    if (argument === "--maintenance" && args[index + 1]) {
      options.maintenance = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Rivet: unknown argument ${argument}\n${usage()}`);
  }
  if (!options.mode) {
    throw new Error(`Rivet: an init mode is required\n${usage()}`);
  }
  if (options.dryRun && options.setupPullRequest) {
    throw new Error(
      `Rivet: --dry-run and --setup-pr cannot be combined\n${usage()}`,
    );
  }
  if (options.branch && !options.setupPullRequest) {
    throw new Error(`Rivet: --setup-branch requires --setup-pr\n${usage()}`);
  }
  if (
    options.maintenance &&
    !["disabled", "manual", "scheduled"].includes(options.maintenance)
  ) {
    throw new Error(
      `Rivet: --maintenance must be disabled, manual, or scheduled\n${usage()}`,
    );
  }
  return options;
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    installReviewImpl = installReview,
    installRepairImpl = installRepair,
    createReviewSetupPullRequestImpl = createReviewSetupPullRequest,
    createRepairSetupPullRequestImpl = createRepairSetupPullRequest,
    configureReviewAppImpl = configureReviewApp,
    verifyRepairAppImpl = verifyRepairApp,
    verifyReviewAppImpl = verifyReviewApp,
    runGuidedInitImpl = runGuidedInit,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    cwd = process.cwd(),
    environment = process.env,
  } = {},
) {
  const [command, ...args] = argv;
  if (!command || command === "--help") {
    stdout.write(usage());
    return 0;
  }
  if (command === "init" && args.includes("--help")) {
    stdout.write(usage());
    return 0;
  }
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
  if (command === "app-configure" || command === "app-verify") {
    const { repair = false, ...options } = parseAppCredentials(args, {
      allowRepair: command === "app-verify",
    });
    const result = await (command === "app-configure"
      ? configureReviewAppImpl(options)
      : repair
        ? verifyRepairAppImpl(options)
        : verifyReviewAppImpl(options));
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command !== "init") throw new Error(`Rivet: unknown command\n${usage()}`);
  if (args.length === 0) {
    return runGuidedInitImpl({
      cwd,
      env: environment,
      stdio: { stdin, stdout, stderr },
    });
  }
  const options = parseInit(args);
  const { setupPullRequest, mode, maintenance, ...installationOptions } =
    options;
  if (maintenance) {
    const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
    configuration.maintenance.mode = maintenance;
    if (mode === "repair") configuration.repair.authority = "owner";
    installationOptions.configuration = configuration;
  }
  const result = setupPullRequest
    ? await (mode === "repair"
        ? createRepairSetupPullRequestImpl(installationOptions)
        : createReviewSetupPullRequestImpl(installationOptions))
    : await (mode === "repair"
        ? installRepairImpl(installationOptions)
        : installReviewImpl(installationOptions));
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
