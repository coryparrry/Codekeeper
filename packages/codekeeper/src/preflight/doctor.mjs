import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SETUP_BRANCH } from "../constants.mjs";
import { assertNodeVersion } from "./environment.mjs";
import { parseGitHubRemote, parseRemoteBranchSha } from "./repository.mjs";
import { inspectInstallationFiles } from "./installation.mjs";
import { assertNoSetupBranch } from "./collisions.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;

async function exists(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const DOCTOR_STATUSES = new Set(["pass", "fail", "warning", "skipped"]);

function doctorCheck({ id, label, status, blocking = false, detail, remediation }) {
  if (!DOCTOR_STATUSES.has(status)) throw new TypeError(`Unsupported doctor status: ${status}`);
  const check = { id, label, status, blocking, detail };
  if (remediation) check.remediation = remediation;
  return Object.freeze(check);
}

function freezeDoctorValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeDoctorValue(child, seen);
  return Object.freeze(value);
}

async function doctorCommand(runner, command, args, options) {
  try {
    const result = await runner.run(command, args, options);
    return {
      result,
      ok: Boolean(result)
        && result.status === 0
        && result.timedOut !== true
        && result.truncated !== true
        && typeof result.stdout === "string",
    };
  } catch {
    // The doctor is deliberately an aggregate API. A command failure is
    // represented by its check and never leaks command-runner diagnostics.
    return { result: null, ok: false };
  }
}

function doctorOutput(command) {
  return command.ok ? command.result.stdout.trim() : null;
}

function doctorSkip(checks, id, label, detail) {
  checks.push(doctorCheck({ id, label, status: "skipped", detail }));
}

function doctorFailure(checks, id, label, detail, remediation) {
  checks.push(
    doctorCheck({
      id,
      label,
      status: "fail",
      blocking: true,
      detail,
      remediation
    })
  );
}

function doctorWarning(checks, id, label, detail, remediation) {
  checks.push(doctorCheck({ id, label, status: "warning", detail, remediation }));
}

/**
 * Run all safe, read-only installer readiness checks and return a UI-friendly
 * report. This intentionally does not call inspectRepository: inspectRepository
 * remains the fail-closed gate used by the mutating installer, while this API
 * collects independent failures for a visible doctor screen.
 */
export async function doctorRepository({
  runner,
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  fsImpl = { lstat, readdir, readFile, realpath },
} = {}) {
  if (!runner || typeof runner.run !== "function") throw new TypeError("A command runner is required.");

  const checks = [];
  let root = null;
  let gitAvailable = false;
  let ghAvailable = false;
  let authenticated = false;
  let currentBranch = null;
  let origin = null;
  let repository = null;
  let ownerType = null;
  let repositoryData = null;
  let defaultBranch = null;
  let headSha = null;
  let installationState = "unknown";

  try {
    assertNodeVersion(nodeVersion);
    checks.push(doctorCheck({
      id: "node",
      label: "Node.js",
      status: "pass",
      detail: "Node.js 22 or newer is available.",
    }));
  } catch {
    doctorFailure(
      checks,
      "node",
      "Node.js",
      "Node.js 22 or newer is required.",
      "Install Node.js 22 or newer, then run doctor again.",
    );
  }

  const gitVersion = await doctorCommand(runner, "git", ["--version"], { cwd });
  gitAvailable = gitVersion.ok;
  if (gitAvailable) {
    checks.push(doctorCheck({
      id: "git",
      label: "Git",
      status: "pass",
      detail: "Git is available.",
    }));
  } else {
    doctorFailure(checks, "git", "Git", "Git is unavailable or could not be queried.", "Install Git, then run doctor again.");
  }

  const ghVersion = await doctorCommand(runner, "gh", ["--version"], { cwd });
  ghAvailable = ghVersion.ok;
  if (ghAvailable) {
    checks.push(doctorCheck({
      id: "gh",
      label: "GitHub CLI",
      status: "pass",
      detail: "GitHub CLI is available.",
    }));
  } else {
    doctorFailure(
      checks,
      "gh",
      "GitHub CLI",
      "GitHub CLI is unavailable or could not be queried.",
      "Install GitHub CLI, then run doctor again.",
    );
  }

  if (!gitAvailable) {
    doctorSkip(checks, "checkout", "Checkout", "Skipped because Git is unavailable.");
  } else {
    const rootCommand = await doctorCommand(runner, "git", ["rev-parse", "--show-toplevel"], { cwd });
    if (!rootCommand.ok) {
      doctorFailure(
        checks,
        "checkout",
        "Checkout",
        "Run doctor inside a Git checkout.",
        "Change into the repository checkout, then run doctor again.",
      );
    } else {
      try {
        root = await fsImpl.realpath(doctorOutput(rootCommand));
      } catch {
        doctorFailure(checks, "checkout", "Checkout", "The Git checkout path could not be read safely.", "Run doctor from a regular local checkout.");
      }

      if (root) {
        const checkoutProblems = [];
        const bareCommand = await doctorCommand(runner, "git", ["rev-parse", "--is-bare-repository"], { cwd: root });
        if (!bareCommand.ok) checkoutProblems.push("The checkout type could not be inspected.");
        else if (doctorOutput(bareCommand) !== "false") checkoutProblems.push("Bare repositories are not supported.");

        const sparseCommand = await doctorCommand(runner, "git", ["config", "--bool", "core.sparseCheckout"], { cwd: root });
        if (!sparseCommand.ok && sparseCommand.result?.status !== 1) {
          checkoutProblems.push("Sparse-checkout state could not be inspected.");
        } else if (sparseCommand.result?.status === 0 && doctorOutput(sparseCommand) === "true") {
          checkoutProblems.push("Sparse checkouts are not supported.");
        }

        for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
          const gitPathCommand = await doctorCommand(runner, "git", ["rev-parse", "--git-path", name], { cwd: root });
          if (!gitPathCommand.ok) {
            checkoutProblems.push("Git operation state could not be inspected.");
            break;
          }
          const gitPath = doctorOutput(gitPathCommand);
          const resolved = path.isAbsolute(gitPath) ? gitPath : path.join(root, gitPath);
          try {
            if (await exists(fsImpl, resolved)) {
              checkoutProblems.push("Finish the active Git operation before setup.");
              break;
            }
          } catch {
            checkoutProblems.push("Git operation state could not be inspected.");
            break;
          }
        }

        if (checkoutProblems.length) {
          doctorFailure(
            checks,
            "checkout",
            "Checkout",
            checkoutProblems.join(" "),
            "Use a regular, non-sparse checkout with no active Git operation, then run doctor again.",
          );
        } else {
          checks.push(doctorCheck({
            id: "checkout",
            label: "Checkout",
            status: "pass",
            detail: "The checkout is a regular Git worktree with no active Git operation.",
          }));
        }
      }
    }
  }

  if (!ghAvailable) {
    doctorSkip(checks, "auth", "GitHub authentication", "Skipped because GitHub CLI is unavailable.");
  } else {
    const authCommand = await doctorCommand(
      runner,
      "gh",
      ["auth", "status", "--hostname", "github.com"],
      { cwd: root ?? cwd },
    );
    const viewerCommand = authCommand.ok
      ? await doctorCommand(runner, "gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"], { cwd: root ?? cwd })
      : null;
    authenticated = authCommand.ok
      && Boolean(viewerCommand?.ok)
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(doctorOutput(viewerCommand) ?? "");
    if (authenticated) {
      checks.push(doctorCheck({
        id: "auth",
        label: "GitHub authentication",
        status: "pass",
        detail: "GitHub CLI is authenticated for github.com.",
      }));
    } else {
      doctorFailure(
        checks,
        "auth",
        "GitHub authentication",
        authCommand.ok
          ? "GitHub returned an invalid authenticated user identity."
          : "Authenticate GitHub CLI for github.com before setup.",
        authCommand.ok ? "Confirm the GitHub CLI account, then run doctor again." : "gh auth login --hostname github.com",
      );
    }
  }

  if (!root || !gitAvailable) {
    doctorSkip(checks, "repository-identity", "Repository identity", "Skipped because a Git checkout could not be inspected.");
  } else {
    const branchCommand = await doctorCommand(runner, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
    if (branchCommand.ok) currentBranch = doctorOutput(branchCommand);

    const originCommand = await doctorCommand(runner, "git", ["remote", "get-url", "origin"], { cwd: root });
    if (originCommand.ok) {
      try {
        origin = parseGitHubRemote(doctorOutput(originCommand));
      } catch {
        origin = null;
      }
    }

    if (!origin) {
      doctorFailure(
        checks,
        "repository-identity",
        "Repository identity",
        "The checkout origin must be a credential-free GitHub.com repository URL.",
        "Set origin to the intended GitHub.com repository, then run doctor again.",
      );
    } else if (!ghAvailable || !authenticated) {
      doctorSkip(checks, "repository-identity", "Repository identity", "Skipped because GitHub authentication is unavailable.");
    } else {
      const repositoryCommand = await doctorCommand(
        runner,
        "gh",
        ["api", "--hostname", "github.com", `repos/${origin.repository}`],
        { cwd: root },
      );
      if (!repositoryCommand.ok) {
        doctorFailure(checks, "repository-identity", "Repository identity", "The GitHub repository could not be read.", "Confirm GitHub access to the repository, then run doctor again.");
      } else {
        try {
          repositoryData = JSON.parse(doctorOutput(repositoryCommand));
        } catch {
          repositoryData = null;
        }
        repository = repositoryData?.full_name;
        ownerType = repositoryData?.owner?.type;
        defaultBranch = repositoryData?.default_branch;
        if (
          !repositoryData
          || typeof repository !== "string"
          || repository.toLowerCase() !== origin.repository.toLowerCase()
          || !["User", "Organization"].includes(ownerType)
        ) {
          doctorFailure(checks, "repository-identity", "Repository identity", "The GitHub repository response does not match the checkout origin.", "Confirm the checkout origin and GitHub repository, then run doctor again.");
          repositoryData = null;
          repository = null;
          ownerType = null;
          defaultBranch = null;
        } else {
          checks.push(doctorCheck({
            id: "repository-identity",
            label: "Repository identity",
            status: "pass",
            detail: "The GitHub repository matches the checkout origin.",
          }));
        }
      }
    }
  }

  if (!repositoryData || !repository) {
    doctorSkip(checks, "repository-state", "Repository state", "Skipped because repository identity is unavailable.");
    doctorSkip(checks, "repository-admin", "Repository administration", "Skipped because repository identity is unavailable.");
    doctorSkip(checks, "actions", "GitHub Actions", "Skipped because repository identity is unavailable.");
    doctorSkip(checks, "default-branch", "Default branch", "Skipped because repository identity is unavailable.");
    doctorSkip(checks, "app-authority", "GitHub App authority", "Skipped because repository owner identity is unavailable.");
  } else {
    if (repositoryData.archived || repositoryData.disabled) {
      doctorFailure(
        checks,
        "repository-state",
        "Repository state",
        "Archived or disabled repositories are not supported.",
        "Restore the repository before running Codekeeper setup.",
      );
    } else {
      checks.push(doctorCheck({
        id: "repository-state",
        label: "Repository state",
        status: "pass",
        detail: "The repository is active.",
      }));
    }

    if (repositoryData.permissions?.admin === true) {
      checks.push(doctorCheck({
        id: "repository-admin",
        label: "Repository administration",
        status: "pass",
        detail: "The authenticated user has repository admin access.",
      }));
    } else {
      doctorFailure(checks, "repository-admin", "Repository administration", "Repository admin access is required for setup.", "Ask a repository administrator to grant admin access, then run doctor again.");
    }

    if (ownerType === "User") {
      checks.push(doctorCheck({
        id: "app-authority",
        label: "GitHub App authority",
        status: "pass",
        detail: "Personal repository ownership is sufficient for the App authority check.",
      }));
    } else {
      const ownerLogin = repository.split("/")[0];
      if (!authenticated || !ghAvailable) {
        doctorSkip(checks, "app-authority", "GitHub App authority", "Skipped because GitHub authentication is unavailable.");
      } else {
        const membershipCommand = await doctorCommand(
          runner,
          "gh",
          ["api", "--hostname", "github.com", `user/memberships/orgs/${ownerLogin}`],
          { cwd: root ?? cwd },
        );
        if (!membershipCommand.ok) {
          doctorWarning(
            checks,
            "app-authority",
            "GitHub App authority",
            "Organization membership could not be established. App creation may require an organization owner or App Manager; an App Manager cannot install the App. Repository admins can install only if organization policy allows it, otherwise an owner must install it and requests may be blocked. GitHub APIs cannot prove organization policy or App Manager permissions.",
            "Ask an organization owner to create or install the App, or confirm the organization policy before setup.",
          );
        } else {
          let membership;
          try {
            membership = JSON.parse(doctorOutput(membershipCommand));
          } catch {
            membership = null;
          }
          if (membership?.state === "active" && membership?.role === "admin") {
            checks.push(doctorCheck({
              id: "app-authority",
              label: "GitHub App authority",
              status: "pass",
              detail: "Active organization role admin is evidence of organization-owner authority. GitHub APIs cannot prove organization policy or App Manager permissions.",
            }));
          } else if (membership?.state === "active" && membership?.role === "member") {
            doctorWarning(
              checks,
              "app-authority",
              "GitHub App authority",
              "The authenticated user is an organization member, not an owner. App creation may require an organization owner or App Manager; an App Manager cannot install the App. Repository admins can install only if organization policy allows it, otherwise an owner must install it and requests may be blocked. GitHub APIs cannot prove organization policy or App Manager permissions.",
              "Ask an organization owner to create or install the App, or confirm the organization policy before setup.",
            );
          } else {
            doctorWarning(
              checks,
              "app-authority",
              "GitHub App authority",
              "Organization membership is unknown or malformed. App creation may require an organization owner or App Manager; an App Manager cannot install the App. Repository admins can install only if organization policy allows it, otherwise an owner must install it and requests may be blocked. GitHub APIs cannot prove organization policy or App Manager permissions.",
              "Ask an organization owner to create or install the App, or confirm the organization policy before setup.",
            );
          }
        }
      }
    }

    const actionsCommand = await doctorCommand(
      runner,
      "gh",
      ["api", "--hostname", "github.com", `repos/${repository}/actions/permissions`],
      { cwd: root ?? cwd },
    );
    if (!actionsCommand.ok) {
      doctorFailure(checks, "actions", "GitHub Actions", "GitHub Actions permissions could not be read.", "Confirm repository Actions access, then run doctor again.");
    } else {
      let actionsPermissions;
      try {
        actionsPermissions = JSON.parse(doctorOutput(actionsCommand));
      } catch {
        actionsPermissions = null;
      }
      if (actionsPermissions?.enabled === true) {
        checks.push(
          doctorCheck({
            id: "actions",
            label: "GitHub Actions",
            status: "pass",
            detail: "GitHub Actions are enabled for the repository."
          })
        );
      } else {
        doctorFailure(checks, "actions", "GitHub Actions", "GitHub Actions must be enabled for this repository.", "Enable GitHub Actions in repository settings, then run doctor again.");
      }
    }

    if (typeof defaultBranch !== "string" || !defaultBranch || !currentBranch) {
      doctorFailure(checks, "default-branch", "Default branch", "The GitHub default branch or current checkout branch could not be read.", "Check out the GitHub default branch, then run doctor again.");
    } else if (currentBranch !== defaultBranch) {
      doctorFailure(checks, "default-branch", "Default branch", "The checkout is not attached to the GitHub default branch.", "git switch <default-branch>");
    } else {
      checks.push(
        doctorCheck({
          id: "default-branch",
          label: "Default branch",
          status: "pass",
          detail: "The checkout is attached to the GitHub default branch."
        })
      );
    }
  }

  if (!root || !gitAvailable) {
    doctorSkip(checks, "clean-state", "Clean state", "Skipped because a Git checkout could not be inspected.");
    doctorSkip(checks, "remote-freshness", "Remote freshness", "Skipped because a Git checkout could not be inspected.");
    doctorSkip(checks, "git-identity", "Git identity", "Skipped because a Git checkout could not be inspected.");
    doctorSkip(checks, "installation", "Installation", "Skipped because a Git checkout could not be inspected.");
    doctorSkip(checks, "setup-branch", "Setup branch", "Skipped because a Git checkout could not be inspected.");
  } else {
    const statusCommand = await doctorCommand(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
    if (!statusCommand.ok) {
      doctorFailure(checks, "clean-state", "Clean state", "Git checkout status could not be read.", "Run git status in the checkout, then run doctor again.");
    } else if (doctorOutput(statusCommand)) {
      doctorFailure(checks, "clean-state", "Clean state", "The Git checkout has tracked or untracked changes.", "Commit or stash local changes, then run doctor again.");
    } else {
      checks.push(
        doctorCheck({
          id: "clean-state",
          label: "Clean state",
          status: "pass",
          detail: "The Git checkout is clean, including untracked files."
        })
      );
    }

    if (!repository || typeof defaultBranch !== "string" || !defaultBranch) {
      doctorSkip(checks, "remote-freshness", "Remote freshness", "Skipped because the GitHub default branch is unavailable.");
    } else {
      const headCommand = await doctorCommand(runner, "git", ["rev-parse", "HEAD"], { cwd: root });
      headSha = doctorOutput(headCommand);
      if (!headCommand.ok || !FULL_SHA.test(headSha ?? "")) {
        doctorFailure(checks, "remote-freshness", "Remote freshness", "Git returned an invalid HEAD commit.", "Check out a valid commit on the default branch, then run doctor again.");
      } else {
        const remoteCommand = await doctorCommand(runner, "git", ["ls-remote", "origin", `refs/heads/${defaultBranch}`], { cwd: root });
        let remoteDefaultSha = null;
        if (remoteCommand.ok) {
          try {
            remoteDefaultSha = parseRemoteBranchSha(doctorOutput(remoteCommand), defaultBranch);
          } catch {
            // The aggregate doctor records the invalid evidence below.
          }
        }
        if (!remoteDefaultSha) {
          doctorFailure(checks, "remote-freshness", "Remote freshness", "The remote default-branch tip could not be read safely.", "Fetch the remote default branch, then run doctor again.");
        } else if (headSha !== remoteDefaultSha) {
          doctorFailure(checks, "remote-freshness", "Remote freshness", "HEAD does not exactly match the remote default branch.", "git fetch origin");
        } else {
          checks.push(
            doctorCheck({
              id: "remote-freshness",
              label: "Remote freshness",
              status: "pass",
              detail: "HEAD exactly matches the remote default branch."
            })
          );
        }
      }
    }

    const authorName = await doctorCommand(runner, "git", ["config", "--get", "user.name"], { cwd: root });
    const authorEmail = await doctorCommand(runner, "git", ["config", "--get", "user.email"], { cwd: root });
    if (!authorName.ok || !authorEmail.ok || !doctorOutput(authorName) || !doctorOutput(authorEmail)) {
      doctorFailure(checks, "git-identity", "Git identity", "Configure Git user.name and user.email before setup.", "git config user.name \"Your Name\" && git config user.email \"you@example.com\"");
    } else {
      checks.push(
        doctorCheck({
          id: "git-identity",
          label: "Git identity",
          status: "pass",
          detail: "Git user.name and user.email are configured."
        })
      );
    }

    try {
      const installation = await inspectInstallationFiles(root, { fsImpl });
      installationState = installation;
      checks.push(doctorCheck({
        id: "installation",
        label: "Installation",
        status: "pass",
        detail: installation ? "The existing Codekeeper installation is valid." : "No existing Codekeeper installation was found.",
      }));
    } catch {
      installationState = "invalid";
      doctorFailure(checks, "installation", "Installation", "The existing Codekeeper installation is missing, colliding, or invalid.", "Repair the existing Codekeeper files or run doctor from a clean checkout.");
    }

    if (!repository || !headSha || installationState === "unknown" || installationState === "invalid") {
      doctorSkip(checks, "setup-branch", "Setup branch", "Skipped because repository, HEAD, or installation state is unavailable.");
    } else {
      const branch = installationState ? `codekeeper/update-${headSha.slice(0, 12)}` : SETUP_BRANCH;
      try {
        await assertNoSetupBranch({ runner, root, repository, branch });
        checks.push(
          doctorCheck({
            id: "setup-branch",
            label: "Setup branch",
            status: "pass",
            detail: "No local, remote, or open setup branch collision was found."
          })
        );
      } catch {
        doctorFailure(checks, "setup-branch", "Setup branch", "A setup branch or open setup pull request already exists, or could not be inspected.", "Resolve the existing setup branch or pull request, then run doctor again.");
      }
    }
  }

  const counts = {
    total: checks.length,
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    warning: checks.filter((check) => check.status === "warning").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
    blocking: checks.filter((check) => check.blocking).length,
  };
  return freezeDoctorValue({
    checks: Object.freeze(checks),
    counts,
    mutationAllowed: checks.every((check) => !check.blocking || check.status === "pass"),
  });
}
