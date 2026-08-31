import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { configureReviewApp, verifyReviewApp } from "./app-setup.mjs";
import {
  reviewAppAuthority,
  reviewAppRegistrationUrl,
} from "./app-authority.mjs";
import { prepareReviewInstallation } from "./install.mjs";
import {
  createReviewSetupPullRequest,
  repositoryFromGitHubOrigin,
  REVIEW_SETUP_BRANCH,
} from "./setup-pr.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL_SECRETS = Object.freeze(["CODEX_API_KEY", "OPENAI_API_KEY"]);
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

function write(stdout, message) {
  stdout.write(`${message}\n`);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Rivet init: ${label} is required`);
  }
  return value.trim();
}

function invalidPreflight(message) {
  throw new Error(`Rivet init: ${message}`);
}

function validRepository(repository) {
  return (
    REPOSITORY.test(repository ?? "") &&
    repository
      .split("/")
      .every((segment) => segment !== "." && segment !== "..")
  );
}

function sanitizedEnvironment(environment) {
  const env = { ...environment, GH_HOST: "github.com" };
  for (const name of [...MODEL_SECRETS, "GH_REPO"]) delete env[name];
  const pathKey = Object.keys(env).find(
    (name) => name.toLowerCase() === "path",
  );
  if (pathKey && typeof env[pathKey] === "string") {
    env[pathKey] = env[pathKey]
      .split(path.delimiter)
      .filter((entry) => {
        if (!entry || !path.isAbsolute(entry)) return false;
        const normalized = entry
          .replaceAll("\\", "/")
          .replace(/\/+$/u, "")
          .toLowerCase();
        return (
          normalized !== "node_modules/.bin" &&
          !normalized.endsWith("/node_modules/.bin")
        );
      })
      .join(path.delimiter);
  }
  return env;
}

async function runCommand(command, args, options = {}) {
  const { cwd, env, input, inheritStdin = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: inheritStdin ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    if (!inheritStdin) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const collect = (destination) => (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          if (!settled) {
            settled = true;
            child.kill();
            reject(
              new Error(
                `${command} ${args[0] ?? ""} output exceeded the limit`,
              ),
            );
          }
          return;
        }
        if (destination === "stdout") stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
    }
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `${command} ${args[0] ?? ""} failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
    if (!inheritStdin) child.stdin.end(input);
  });
}

async function configuredModelSecret({
  runner,
  repositoryRoot,
  repository,
  env,
}) {
  let secrets;
  try {
    secrets = JSON.parse(
      await runner(
        "gh",
        [
          "secret",
          "list",
          "--app",
          "actions",
          "--repo",
          repository,
          "--json",
          "name",
        ],
        { cwd: repositoryRoot, env },
      ),
    );
  } catch {
    invalidPreflight("could not read GitHub Actions secret metadata");
  }
  if (!Array.isArray(secrets)) {
    invalidPreflight("GitHub returned invalid Actions secret metadata");
  }
  return MODEL_SECRETS.find((name) =>
    secrets.some((secret) => secret?.name === name),
  );
}

function terminalPrompt({ stdin, stdout }) {
  async function question(message) {
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      return await readline.question(message);
    } finally {
      readline.close();
    }
  }
  return Object.freeze({
    async confirm(message) {
      const answer = (await question(`${message} [y/N] `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    async input(message) {
      return question(`${message} `);
    },
  });
}

async function openInBrowser(url, platform, env, spawnImpl) {
  if (platform !== "darwin")
    throw new Error("Automatic browser launch unavailable");
  await new Promise((resolve, reject) => {
    const child = spawnImpl("/usr/bin/open", [url], {
      stdio: "ignore",
      detached: true,
      env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function setupBranchExists(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function resolveRepositoryRoot({ runner, cwd, env }) {
  try {
    const root = await runner("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env,
    });
    return path.resolve(required(root, "Git repository root"));
  } catch {
    invalidPreflight("run this command from inside a Git repository");
  }
}

async function resolveOriginRepository({ runner, repositoryRoot, env }) {
  try {
    return repositoryFromGitHubOrigin(
      await runner("git", ["remote", "get-url", "origin"], {
        cwd: repositoryRoot,
        env,
      }),
    );
  } catch {
    invalidPreflight("origin must be an exact github.com repository URL");
  }
}

async function preflight({ runner, cwd, env }) {
  const repositoryRoot = await resolveRepositoryRoot({ runner, cwd, env });
  const status = await runner(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, env },
  );
  if (status) invalidPreflight("repository working tree must be clean");

  try {
    await runner("gh", ["auth", "status", "--hostname", "github.com"], {
      cwd: repositoryRoot,
      env,
    });
  } catch {
    invalidPreflight(
      "GitHub CLI authentication is required; run gh auth login",
    );
  }

  const originRepository = await resolveOriginRepository({
    runner,
    repositoryRoot,
    env,
  });
  let details;
  try {
    details = JSON.parse(
      await runner(
        "gh",
        [
          "repo",
          "view",
          `github.com/${originRepository}`,
          "--json",
          "nameWithOwner,defaultBranchRef,url,viewerPermission",
        ],
        { cwd: repositoryRoot, env },
      ),
    );
  } catch {
    invalidPreflight("could not resolve GitHub repository metadata");
  }
  const repository = details?.nameWithOwner;
  const defaultBranch = details?.defaultBranchRef?.name;
  if (
    !validRepository(repository) ||
    repository.toLowerCase() !== originRepository.toLowerCase() ||
    !defaultBranch
  ) {
    invalidPreflight(
      "could not resolve the GitHub repository and default branch",
    );
  }
  if (details?.url !== `https://github.com/${repository}`) {
    invalidPreflight("guided setup requires a github.com repository");
  }
  if (details?.viewerPermission !== "ADMIN") {
    invalidPreflight("guided setup requires repository admin permission");
  }
  const ownerType = await runner(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      `repos/${repository}`,
      "--jq",
      ".owner.type",
    ],
    { cwd: repositoryRoot, env },
  );
  if (ownerType !== "User" && ownerType !== "Organization") {
    invalidPreflight("GitHub repository owner must be a User or Organization");
  }

  await runner("git", ["fetch", "origin", defaultBranch], {
    cwd: repositoryRoot,
    env,
  });
  const head = await runner("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    env,
  });
  const base = await runner(
    "git",
    ["rev-parse", `refs/remotes/origin/${defaultBranch}`],
    { cwd: repositoryRoot, env },
  );
  if (head !== base) {
    invalidPreflight(`HEAD must match origin/${defaultBranch} before setup`);
  }

  const localBranch = await runner(
    "git",
    ["branch", "--list", REVIEW_SETUP_BRANCH],
    { cwd: repositoryRoot, env },
  );
  const remoteBranch = await runner(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${REVIEW_SETUP_BRANCH}`],
    { cwd: repositoryRoot, env },
  );
  if (setupBranchExists(localBranch) || setupBranchExists(remoteBranch)) {
    invalidPreflight(`setup branch already exists: ${REVIEW_SETUP_BRANCH}`);
  }

  const existingModelSecret = await configuredModelSecret({
    runner,
    repositoryRoot,
    repository,
    env,
  });
  return Object.freeze({
    repositoryRoot,
    repository,
    defaultBranch,
    ownerType,
    existingModelSecret,
  });
}

async function assertPreflightStillCurrent({ runner, preflightResult, env }) {
  const { repositoryRoot, repository, defaultBranch } = preflightResult;
  const status = await runner(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, env },
  );
  if (status) invalidPreflight("repository working tree changed during setup");
  const originRepository = await resolveOriginRepository({
    runner,
    repositoryRoot,
    env,
  });
  const details = JSON.parse(
    await runner(
      "gh",
      [
        "repo",
        "view",
        `github.com/${originRepository}`,
        "--json",
        "nameWithOwner,defaultBranchRef,url,viewerPermission",
      ],
      { cwd: repositoryRoot, env },
    ),
  );
  if (
    details?.nameWithOwner !== repository ||
    originRepository.toLowerCase() !== repository.toLowerCase() ||
    details?.defaultBranchRef?.name !== defaultBranch ||
    details?.url !== `https://github.com/${repository}` ||
    details?.viewerPermission !== "ADMIN"
  ) {
    invalidPreflight("GitHub repository metadata changed during setup");
  }
  await runner("git", ["fetch", "origin", defaultBranch], {
    cwd: repositoryRoot,
    env,
  });
  const head = await runner("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    env,
  });
  const base = await runner(
    "git",
    ["rev-parse", `refs/remotes/origin/${defaultBranch}`],
    { cwd: repositoryRoot, env },
  );
  if (head !== base) {
    invalidPreflight(`HEAD must match origin/${defaultBranch} before setup`);
  }
  const localBranch = await runner(
    "git",
    ["branch", "--list", REVIEW_SETUP_BRANCH],
    { cwd: repositoryRoot, env },
  );
  const remoteBranch = await runner(
    "git",
    ["ls-remote", "--heads", "origin", `refs/heads/${REVIEW_SETUP_BRANCH}`],
    { cwd: repositoryRoot, env },
  );
  if (setupBranchExists(localBranch) || setupBranchExists(remoteBranch)) {
    invalidPreflight(`setup branch already exists: ${REVIEW_SETUP_BRANCH}`);
  }
  const existingModelSecret = await configuredModelSecret({
    runner,
    repositoryRoot,
    repository,
    env,
  });
  if (existingModelSecret !== preflightResult.existingModelSecret) {
    invalidPreflight(
      "GitHub Actions secret metadata changed during setup; run rivet init again",
    );
  }
}

function cancelled({ stage, preflightResult, registrationUrl, authority }) {
  const guidance = {
    "app-registration": "Run rivet init again when you are ready to continue.",
    "app-installation":
      "Rivet already saved this App's repository credentials. Finish installing this same App, then rerun rivet init and reuse the same client ID and PEM. Remove the saved RIVET_APP_* settings before choosing a different App.",
    "setup-pull-request":
      "Rivet already saved and verified this App's repository credentials. Rerun rivet init and reuse the same client ID and PEM to create the setup pull request. Remove the saved RIVET_APP_* settings before choosing a different App.",
  }[stage];
  return Object.freeze({
    status: "cancelled",
    stage,
    repository: preflightResult.repository,
    ownerType: preflightResult.ownerType,
    repositoryRoot: preflightResult.repositoryRoot,
    authority,
    registrationUrl,
    guidance,
  });
}

async function selectModelSecret(prompt) {
  if (typeof prompt.selectModelSecret === "function") {
    const selected = await prompt.selectModelSecret(MODEL_SECRETS);
    if (MODEL_SECRETS.includes(selected)) return selected;
  } else {
    const selected = (
      await prompt.input(
        "Model secret to store [CODEX_API_KEY] (or OPENAI_API_KEY):",
      )
    )
      .trim()
      .toUpperCase();
    if (!selected) return "CODEX_API_KEY";
    if (MODEL_SECRETS.includes(selected)) return selected;
  }
  throw new Error("Rivet init: choose CODEX_API_KEY or OPENAI_API_KEY");
}

async function setModelSecret({
  runner,
  repository,
  repositoryRoot,
  env,
  name,
  secretInput,
  stdout,
}) {
  const args = [
    "secret",
    "set",
    name,
    "--app",
    "actions",
    "--repo",
    repository,
  ];
  let input;
  let inherited = false;
  if (typeof secretInput === "function") {
    input = await secretInput({ name, repository });
  } else if (secretInput !== undefined) {
    input = secretInput;
  } else {
    inherited = true;
    write(
      stdout,
      `Provide ${name} to the GitHub CLI now, then finish standard input to continue.`,
    );
  }
  if (typeof input === "string" && !input) {
    throw new Error("Rivet init: model secret must not be empty");
  }
  if (Buffer.isBuffer(input) && input.length === 0) {
    throw new Error("Rivet init: model secret must not be empty");
  }
  try {
    await runner("gh", args, {
      cwd: repositoryRoot,
      env,
      input,
      inheritStdin: inherited,
    });
  } catch {
    throw new Error("Rivet init: failed to store the selected model secret");
  } finally {
    if (Buffer.isBuffer(input)) input.fill(0);
  }
}

function appSummary(value) {
  return Object.freeze({
    appId: value.appId,
    appSlug: value.appSlug,
    installationUrl: value.installationUrl,
  });
}

/**
 * Guides a review-only Rivet installation without exposing credentials.
 *
 * All external dependencies are injectable for deterministic callers and tests.
 */
export async function runGuidedInit(options = {}) {
  const {
    cwd = process.cwd(),
    repositoryRoot,
    runner = runCommand,
    prompt: injectedPrompt,
    openUrl = (url, { env: browserEnvironment }) =>
      openInBrowser(
        url,
        options.platform ?? process.platform,
        browserEnvironment,
        options.spawnBrowser ?? spawn,
      ),
    configureReviewAppImpl = configureReviewApp,
    verifyReviewAppImpl = verifyReviewApp,
    createReviewSetupPullRequestImpl = createReviewSetupPullRequest,
    prepareReviewInstallationImpl = prepareReviewInstallation,
    secretInput,
    configuration,
  } = options;
  const stdio =
    options.stdio ??
    Object.freeze({
      stdin: options.stdin ?? process.stdin,
      stdout: options.stdout ?? process.stdout,
      stderr: options.stderr ?? process.stderr,
    });
  const credentialEnvironment =
    options.env ?? options.environment ?? process.env;
  const env = sanitizedEnvironment(credentialEnvironment);
  const stdout = stdio.stdout;
  let prompt = injectedPrompt;
  if (!prompt) {
    if (!stdio.stdin?.isTTY) {
      throw new Error(
        "Rivet init: interactive setup requires a TTY; use explicit CLI flags instead",
      );
    }
    prompt = terminalPrompt(stdio);
  }
  if (
    typeof prompt.confirm !== "function" ||
    typeof prompt.input !== "function"
  ) {
    throw new Error(
      "Rivet init: prompt must provide confirm and input functions",
    );
  }

  const preflightResult = await preflight({
    runner,
    cwd: repositoryRoot ?? cwd,
    env,
  });
  const preparedPlan = await prepareReviewInstallationImpl({
    repositoryRoot: preflightResult.repositoryRoot,
    configuration,
    env,
  });
  if (!preparedPlan.files.some(({ status }) => status !== "unchanged")) {
    throw new Error(
      "Rivet init: review-only installation is already up to date",
    );
  }
  const authority = reviewAppAuthority(configuration);
  const registrationUrl = reviewAppRegistrationUrl({
    repository: preflightResult.repository,
    ownerType: preflightResult.ownerType,
    configuration,
  });
  write(stdout, `Review authority: ${JSON.stringify(authority.permissions)}`);
  write(stdout, `Create the Rivet GitHub App: ${registrationUrl}`);
  try {
    await openUrl(registrationUrl, { env });
  } catch {
    write(
      stdout,
      "Could not open a browser; use the printed registration URL.",
    );
  }

  if (
    !(await prompt.confirm("Continue with the review-only GitHub App setup?"))
  ) {
    const result = cancelled({
      stage: "app-registration",
      preflightResult,
      registrationUrl,
      authority,
    });
    write(stdout, result.guidance);
    return result;
  }
  const clientId = required(
    await prompt.input("GitHub App client ID:"),
    "GitHub App client ID",
  );
  const privateKeyPath = required(
    await prompt.input("Path to the GitHub App private-key PEM:"),
    "GitHub App private-key PEM path",
  );
  await assertPreflightStillCurrent({ runner, preflightResult, env });
  const app = await configureReviewAppImpl({
    repository: preflightResult.repository,
    clientId,
    privateKeyPath,
    configuration,
    run: (args, runOptions = {}) =>
      runner("gh", args, {
        cwd: preflightResult.repositoryRoot,
        env,
        ...runOptions,
      }),
  });
  const installationUrl = app.installationUrl;
  write(stdout, `Install the App on only this repository: ${installationUrl}`);
  try {
    await openUrl(installationUrl, { env });
  } catch {
    write(
      stdout,
      "Could not open a browser; use the printed installation URL.",
    );
  }
  if (
    !(await prompt.confirm("Installed it on only the selected repository?"))
  ) {
    const result = cancelled({
      stage: "app-installation",
      preflightResult,
      registrationUrl,
      authority,
    });
    write(stdout, result.guidance);
    return result;
  }
  const verifiedApp = await verifyReviewAppImpl({
    repository: preflightResult.repository,
    clientId,
    privateKeyPath,
    configuration,
    run: (args, runOptions = {}) =>
      runner("gh", args, {
        cwd: preflightResult.repositoryRoot,
        env,
        ...runOptions,
      }),
  });

  const environmentModelSecret = MODEL_SECRETS.find(
    (name) =>
      typeof credentialEnvironment[name] === "string" &&
      credentialEnvironment[name],
  );
  const modelSecret =
    preflightResult.existingModelSecret ??
    environmentModelSecret ??
    (await selectModelSecret(prompt));
  const modelSecretAlreadyConfigured = Boolean(
    preflightResult.existingModelSecret,
  );
  const finalAction = modelSecretAlreadyConfigured
    ? "create the verified draft setup pull request"
    : `store ${modelSecret} and create the verified draft setup pull request`;
  if (!(await prompt.confirm(`Ready to ${finalAction}?`))) {
    const result = cancelled({
      stage: "setup-pull-request",
      preflightResult,
      registrationUrl,
      authority,
    });
    write(stdout, result.guidance);
    return result;
  }
  await assertPreflightStillCurrent({ runner, preflightResult, env });
  if (!modelSecretAlreadyConfigured) {
    await setModelSecret({
      runner,
      repository: preflightResult.repository,
      repositoryRoot: preflightResult.repositoryRoot,
      env,
      name: modelSecret,
      secretInput:
        secretInput ??
        (environmentModelSecret
          ? Buffer.from(credentialEnvironment[environmentModelSecret])
          : undefined),
      stdout,
    });
  }
  const setupPullRequest = await createReviewSetupPullRequestImpl({
    repositoryRoot: preflightResult.repositoryRoot,
    configuration,
    preparedPlan,
    run: (command, args, runOptions = {}) =>
      runner(command, args, { env, ...runOptions }),
  });
  const result = Object.freeze({
    status: "configured",
    repository: preflightResult.repository,
    ownerType: preflightResult.ownerType,
    repositoryRoot: preflightResult.repositoryRoot,
    authority,
    registrationUrl,
    app: appSummary(app),
    verifiedApp: Object.freeze({
      appId: verifiedApp.appId,
      appSlug: verifiedApp.appSlug,
      repositorySelection: verifiedApp.repositorySelection,
      permissions: verifiedApp.permissions,
    }),
    modelSecret: Object.freeze({
      name: modelSecret,
      action: modelSecretAlreadyConfigured ? "already-configured" : "stored",
    }),
    setupPullRequest: Object.freeze({
      branch: setupPullRequest.branch,
      pullRequestUrl: setupPullRequest.pullRequestUrl,
    }),
  });
  write(
    stdout,
    `Created verified draft setup pull request: ${result.setupPullRequest.pullRequestUrl}`,
  );
  return result;
}
