import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import {
  BOT_LOGIN_VARIABLE,
  CLIENT_ID_VARIABLE,
  ENABLED_VARIABLE,
  SETUP_BRANCH
} from "../constants.mjs";
import { InstallerError } from "../errors.mjs";
import { requireSuccess } from "../command-runner.mjs";
import { assertInstallerEnvironment } from "./environment.mjs";
import {
  inspectGitHubRepository,
  parseJson,
  readAuthenticatedViewer
} from "./github.mjs";
import {
  assertDefaultBranchCheckout,
  assertFreshCleanCheckout,
  assertGitIdentity,
  inspectLocalCheckout
} from "./repository.mjs";
import {
  discoverRepositoryValidationCommand,
  inspectInstallationFiles
} from "./installation.mjs";
import { assertNoSetupBranch } from "./collisions.mjs";

export { assertNodeVersion } from "./environment.mjs";
export { parseGitHubRemote, parseRemoteBranchSha } from "./repository.mjs";
export {
  discoverNpmPackageLockPreparation,
  discoverRepositoryValidationCommand,
  inspectInstallationFiles,
  parseReleaseManifest
} from "./installation.mjs";
export { assertNoInstallationFiles, assertNoSetupBranch } from "./collisions.mjs";
export { doctorRepository } from "./doctor.mjs";

async function repositoryVariable(runner, root, repository, name) {
  return requireSuccess(
    runner,
    "gh",
    ["variable", "get", name, "--repo", repository, "--json", "value", "--jq", ".value"],
    { cwd: root },
    `The existing installation is missing the ${name} repository variable.`
  );
}

async function optionalRepositoryVariable(runner, root, repository, name) {
  const variables = parseJson(await requireSuccess(
    runner,
    "gh",
    ["variable", "list", "--repo", repository, "--json", "name,value"],
    { cwd: root },
    "Could not inspect existing repository variables."
  ), "GitHub repository-variable query");
  if (!Array.isArray(variables) || variables.some((variable) => typeof variable?.name !== "string" || typeof variable?.value !== "string")) {
    throw new InstallerError("GitHub returned an invalid repository-variable list.", { code: "PREFLIGHT_INVALID_RESPONSE" });
  }
  return variables.find((variable) => variable.name === name)?.value ?? null;
}

export async function inspectRepository({
  runner,
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  interactive = true,
  fsImpl = { lstat, readdir, readFile, realpath }
}) {
  await assertInstallerEnvironment({ runner, cwd, nodeVersion, interactive });
  const { root, currentBranch, originUrl, origin } = await inspectLocalCheckout({ runner, cwd, fsImpl });
  const { repository, ownerType, defaultBranch } = await inspectGitHubRepository({ runner, root, origin });
  assertDefaultBranchCheckout(currentBranch, defaultBranch);
  const { headSha, remoteDefaultSha } = await assertFreshCleanCheckout({ runner, root, defaultBranch });
  const viewerLogin = await readAuthenticatedViewer(runner, root);
  await assertGitIdentity({ runner, root });

  const installation = await inspectInstallationFiles(root, { fsImpl });
  const validationCandidate = await discoverRepositoryValidationCommand(root, { fsImpl });
  const updateBranch = installation ? `codekeeper/update-${headSha.slice(0, 12)}` : SETUP_BRANCH;
  await assertNoSetupBranch({ runner, root, repository, branch: updateBranch });
  let existingSettings = null;
  if (installation) {
    existingSettings = Object.freeze({
      enabled: (await repositoryVariable(runner, root, repository, ENABLED_VARIABLE)) === "true",
      appClientId: await repositoryVariable(runner, root, repository, CLIENT_ID_VARIABLE),
      automationBotLogin: await optionalRepositoryVariable(runner, root, repository, BOT_LOGIN_VARIABLE)
    });
  }
  return Object.freeze({
    root,
    originUrl,
    repository,
    ownerType,
    defaultBranch,
    currentBranch,
    headSha,
    remoteDefaultSha,
    viewerLogin,
    displayName: repository.split("/")[1],
    validationCommandCandidate: validationCandidate?.command ?? null,
    ...(installation ? { installation, existingSettings, updateBranch } : {})
  });
}
