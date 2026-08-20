import { InstallerError } from "../errors.mjs";
import { requireSuccess } from "../command-runner.mjs";

export function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new InstallerError(`${label} returned invalid JSON.`, {
      code: "PREFLIGHT_INVALID_RESPONSE",
      cause
    });
  }
}

export async function inspectGitHubRepository({ runner, root, origin }) {
  await requireSuccess(runner, "gh", ["auth", "status", "--hostname", "github.com"], { cwd: root }, "Authenticate GitHub CLI for github.com first.");
  const repositoryData = parseJson(await requireSuccess(
    runner,
    "gh",
    ["api", "--hostname", "github.com", `repos/${origin.repository}`],
    { cwd: root },
    "Could not read the GitHub repository."
  ), "GitHub repository query");
  const repository = repositoryData.full_name;
  if (typeof repository !== "string" || repository.toLowerCase() !== origin.repository.toLowerCase()) {
    throw new InstallerError("The GitHub repository does not match origin.", {
      code: "REPOSITORY_MISMATCH"
    });
  }
  const ownerType = repositoryData.owner?.type;
  if (!["User", "Organization"].includes(ownerType)) {
    throw new InstallerError("GitHub returned an unsupported repository owner type.", { code: "PREFLIGHT_INVALID_RESPONSE" });
  }
  if (repositoryData.permissions?.admin !== true)
    throw new InstallerError("Repository admin access is required.", {
      code: "ADMIN_REQUIRED"
    });
  if (repositoryData.archived || repositoryData.disabled) throw new InstallerError("Archived or disabled repositories are not supported.", { code: "UNSUPPORTED_REPOSITORY" });
  const actionsPermissions = parseJson(await requireSuccess(
    runner,
    "gh",
    ["api", "--hostname", "github.com", `repos/${repository}/actions/permissions`],
    { cwd: root },
    "Could not read GitHub Actions permissions."
  ), "GitHub Actions permissions query");
  if (actionsPermissions.enabled !== true) throw new InstallerError("GitHub Actions must be enabled for this repository.", { code: "ACTIONS_DISABLED" });
  const defaultBranch = repositoryData.default_branch;
  return { repositoryData, repository, ownerType, defaultBranch };
}

export async function readAuthenticatedViewer(runner, root) {
  const viewerLogin = await requireSuccess(runner, "gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"], { cwd: root }, "Could not identify the authenticated GitHub user.");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(viewerLogin)) throw new InstallerError("GitHub returned an invalid authenticated login.", { code: "PREFLIGHT_INVALID_RESPONSE" });
  return viewerLogin;
}
