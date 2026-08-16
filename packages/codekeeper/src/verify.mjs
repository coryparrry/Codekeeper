import { inspectInstallationFiles, parseGitHubRemote } from "./preflight.mjs";
import { validatePolicy } from "./policy-validator.mjs";
import { normalizePackageRelease } from "./package-release.mjs";
import { requiredSecretNames, requiresAutomationBotLogin } from "./plan.mjs";
import {
  BOT_LOGIN_VARIABLE,
  CLIENT_ID_VARIABLE,
  ENABLED_VARIABLE,
} from "./constants.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const CHECK_STATUS = new Set(["pass", "fail", "not-provable", "skipped"]);

function frozenCheck({
  id,
  label,
  status,
  boundary,
  detail,
  remediation,
  required = true,
}) {
  if (!CHECK_STATUS.has(status))
    throw new TypeError(`Unsupported verification status: ${status}`);
  return Object.freeze({
    id,
    label,
    status,
    boundary,
    detail,
    remediation,
    required,
  });
}

function commandOutput(result) {
  if (!result || result.status !== 0 || result.timedOut)
    throw new Error("command unavailable");
  return String(result.stdout ?? "").trim();
}

async function command(runner, name, args, options) {
  return commandOutput(await runner.run(name, args, options));
}

function parseObject(source) {
  const value = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid response");
  return value;
}

function nameList(source) {
  const parsed = JSON.parse(source);
  const entries = Array.isArray(parsed)
    ? parsed
    : (parsed?.variables ?? parsed?.secrets);
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => typeof entry?.name !== "string")
  ) {
    throw new Error("invalid names response");
  }
  return new Set(entries.map((entry) => entry.name));
}

function expectedNames(installation) {
  const { modes, policy } = installation;
  const variables = new Set([ENABLED_VARIABLE, CLIENT_ID_VARIABLE]);
  if (
    requiresAutomationBotLogin(
      modes,
      policy.capabilities,
      policy.automation.ownerRequests,
    )
  ) {
    variables.add(BOT_LOGIN_VARIABLE);
  }
  const secrets = new Set(
    requiredSecretNames({
      modes,
      policy,
      tracing: policy.ai.tracing.enabled,
    }),
  );
  return { variables, secrets };
}

function missingNames(expected, available) {
  return [...expected].filter((name) => !available.has(name)).sort();
}

function safeCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : null;
}

function freezeReport({ repository = null, checks }) {
  const ready = checks.every(
    (check) => !check.required || check.status === "pass",
  );
  return Object.freeze({
    ready,
    ...(repository ? { repository } : {}),
    checks: Object.freeze(checks),
  });
}

/**
 * Read-only, adopter-facing readiness evidence for an installed Codekeeper
 * checkout. It returns data for a CLI or UI; it never writes output itself.
 *
 * Dependencies are injectable so callers can keep package acquisition and any
 * controlled workflow test behind an explicit approval boundary.
 */
export async function verifyCodekeeperReadiness({
  runner,
  cwd = process.cwd(),
  fsImpl,
  inspectInstallation = inspectInstallationFiles,
  validateInstalledPolicy = validatePolicy,
  verifyPackage = null,
  inspectApp = null,
  controlledCheck = false,
  runControlledCheck = null,
} = {}) {
  if (!runner || typeof runner.run !== "function")
    throw new TypeError("A command runner is required.");

  let root = cwd;
  let repository = null;
  let defaultBranch = null;
  let installation = null;
  const checks = [];

  try {
    root = await command(runner, "git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    const originUrl = await command(
      runner,
      "git",
      ["remote", "get-url", "origin"],
      { cwd: root },
    );
    const origin = parseGitHubRemote(originUrl);
    const repositoryInfo = parseObject(
      await command(
        runner,
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          `repos/${origin.repository}`,
          "--jq",
          "{full_name,default_branch}",
        ],
        { cwd: root },
      ),
    );
    repository = repositoryInfo.full_name;
    defaultBranch = repositoryInfo.default_branch;
    if (
      typeof repository !== "string" ||
      repository.toLowerCase() !== origin.repository.toLowerCase() ||
      typeof defaultBranch !== "string" ||
      !defaultBranch
    ) {
      throw new Error("repository mismatch");
    }
    const currentBranch = await command(
      runner,
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: root },
    );
    const status = await command(
      runner,
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: root },
    );
    const headSha = await command(runner, "git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const remote = await command(
      runner,
      "git",
      ["ls-remote", "origin", `refs/heads/${defaultBranch}`],
      { cwd: root },
    );
    const remoteSha = remote.split(/\s+/)[0];
    if (!FULL_SHA.test(headSha) || !FULL_SHA.test(remoteSha))
      throw new Error("invalid commit");
    if (currentBranch !== defaultBranch) {
      checks.push(
        frozenCheck({
          id: "checkout",
          label: "Checkout",
          status: "fail",
          boundary: "local",
          detail: "The checkout is not on the GitHub default branch.",
          remediation: "Switch to the default branch before verifying.",
        }),
      );
    } else if (status) {
      checks.push(
        frozenCheck({
          id: "checkout",
          label: "Checkout",
          status: "fail",
          boundary: "local",
          detail: "The checkout has tracked or untracked changes.",
          remediation:
            "Commit, stash, or remove local changes before verifying.",
        }),
      );
    } else if (headSha !== remoteSha) {
      checks.push(
        frozenCheck({
          id: "checkout",
          label: "Checkout",
          status: "fail",
          boundary: "local",
          detail: "HEAD does not equal the remote default branch.",
          remediation: "Fast-forward the default branch, then verify again.",
        }),
      );
    } else {
      checks.push(
        frozenCheck({
          id: "checkout",
          label: "Checkout",
          status: "pass",
          boundary: "local",
          detail:
            "GitHub origin, default branch, clean status, and remote commit agree.",
          remediation: "None.",
        }),
      );
    }
  } catch (error) {
    checks.push(
      frozenCheck({
        id: "checkout",
        label: "Checkout",
        status: "not-provable",
        boundary: "local",
        detail:
          "The local checkout and GitHub default branch could not be read.",
        remediation: safeCode(error)
          ? `Resolve ${safeCode(error)} and verify again.`
          : "Ensure GitHub CLI access and a GitHub.com origin, then verify again.",
      }),
    );
  }

  try {
    installation =
      fsImpl === undefined
        ? await inspectInstallation(root)
        : await inspectInstallation(root, { fsImpl });
    if (!installation) throw new Error("not installed");
    checks.push(
      frozenCheck({
        id: "managed-files",
        label: "Installed files",
        status: "pass",
        boundary: "local",
        detail:
          "The installed catalog, release manifest, and managed files are valid.",
        remediation: "None.",
      }),
    );
  } catch {
    checks.push(
      frozenCheck({
        id: "managed-files",
        label: "Installed files",
        status: "fail",
        boundary: "local",
        detail:
          "The installed catalog, release manifest, or a managed file is missing or invalid.",
        remediation:
          "Run the Codekeeper update flow from a clean default-branch checkout.",
      }),
    );
  }

  if (!installation) {
    checks.push(
      frozenCheck({
        id: "repository-settings",
        label: "Repository settings",
        status: "skipped",
        boundary: "github-read",
        detail: "Installed configuration could not be read.",
        remediation:
          "Repair the installed files, then verify repository setting names.",
      }),
    );
    checks.push(
      frozenCheck({
        id: "github-app",
        label: "GitHub App",
        status: "skipped",
        boundary: "github-read",
        detail: "Installed configuration could not be read.",
        remediation:
          "Repair the installed files before checking the GitHub App.",
      }),
    );
    checks.push(
      frozenCheck({
        id: "package-acquisition",
        label: "Package acquisition",
        status: "skipped",
        boundary: "github-workflow",
        detail: "Release metadata could not be read.",
        remediation:
          "Repair the installed release manifest, then verify exact package acquisition.",
      }),
    );
    checks.push(
      frozenCheck({
        id: "policy",
        label: "Policy",
        status: "skipped",
        boundary: "local",
        detail: "Installed configuration could not be read.",
        remediation: "Repair the installed files, then verify the policy.",
      }),
    );
  } else {
    let expected = null;
    try {
      expected = expectedNames(installation);
    } catch {
      // Policy validation below provides the actionable local failure. Do not
      // risk exposing an unexpected policy value while reporting settings.
    }
    try {
      if (!repository || !expected) throw new Error("repository unavailable");
      const [variables, secrets] = await Promise.all([
        command(
          runner,
          "gh",
          ["variable", "list", "--repo", repository, "--json", "name"],
          { cwd: root },
        ),
        command(
          runner,
          "gh",
          ["secret", "list", "--repo", repository, "--json", "name"],
          { cwd: root },
        ),
      ]);
      const missingVariables = missingNames(
        expected.variables,
        nameList(variables),
      );
      const missingSecrets = missingNames(expected.secrets, nameList(secrets));
      if (missingVariables.length || missingSecrets.length) {
        checks.push(
          frozenCheck({
            id: "repository-settings",
            label: "Repository settings",
            status: "fail",
            boundary: "github-read",
            detail: `Missing variable names: ${missingVariables.join(", ") || "none"}. Missing secret names: ${missingSecrets.join(", ") || "none"}.`,
            remediation:
              "Add the missing names in GitHub repository settings; do not expose their values.",
          }),
        );
      } else {
        checks.push(
          frozenCheck({
            id: "repository-settings",
            label: "Repository settings",
            status: "pass",
            boundary: "github-read",
            detail:
              "All required repository variable and secret names are present.",
            remediation: "None.",
          }),
        );
      }
    } catch {
      checks.push(
        frozenCheck({
          id: "repository-settings",
          label: "Repository settings",
          status: "not-provable",
          boundary: "github-read",
          detail: "Repository variable and secret names could not be listed.",
          remediation:
            "Grant read access to repository Actions settings, then verify again.",
        }),
      );
    }

    try {
      if (inspectApp) {
        const proof = await inspectApp({
          runner,
          root,
          repository,
          installation,
        });
        if (proof === true || proof?.status === "pass") {
          checks.push(
            frozenCheck({
              id: "github-app",
              label: "GitHub App",
              status: "pass",
              boundary: "github-read",
              detail:
                "The supplied read-only App proof matches the installed configuration.",
              remediation: "None.",
            }),
          );
        } else {
          checks.push(
            frozenCheck({
              id: "github-app",
              label: "GitHub App",
              status: "not-provable",
              boundary: "github-read",
              detail:
                "The supplied App proof did not establish the installed App and required permissions.",
              remediation:
                "After merge, verify the installed GitHub App, installation scope, and permissions in GitHub settings.",
            }),
          );
        }
      } else {
        if (!repository) throw new Error("repository unavailable");
        await command(
          runner,
          "gh",
          [
            "api",
            "--hostname",
            "github.com",
            "user/installations",
            "--jq",
            ".installations[] | {id,app_id,app_slug,repository_selection,permissions}",
          ],
          { cwd: root },
        );
        checks.push(
          frozenCheck({
            id: "github-app",
            label: "GitHub App",
            status: "not-provable",
            boundary: "github-read",
            detail:
              "Token-visible App installations were read, but they cannot be linked safely to the installed App without reading an App identifier value.",
            remediation:
              "After merge, verify the installed GitHub App, installation scope, and permissions in GitHub settings.",
          }),
        );
      }
    } catch {
      checks.push(
        frozenCheck({
          id: "github-app",
          label: "GitHub App",
          status: "not-provable",
          boundary: "github-read",
          detail:
            "The GitHub App installation proof could not be read with this token.",
          remediation:
            "After merge, verify the installed GitHub App, installation scope, and permissions in GitHub settings.",
        }),
      );
    }

    try {
      const packageRelease = normalizePackageRelease(
        installation.releaseManifest?.package,
        { expectedVersion: undefined },
      );
      if (!verifyPackage) {
        checks.push(
          frozenCheck({
            id: "package-acquisition",
            label: "Package acquisition",
            status: "not-provable",
            boundary: "github-workflow",
            detail:
              "The installed release has an exact package name, version, and integrity receipt, but no acquisition verifier was supplied.",
            remediation:
              "Run verification with the exact npm package-acquisition hook after merge.",
          }),
        );
      } else {
        const result = await verifyPackage({
          packageRelease,
          installation,
          repository,
          root,
        });
        const passed = result === true || result?.status === "pass";
        checks.push(
          frozenCheck({
            id: "package-acquisition",
            label: "Package acquisition",
            status: passed ? "pass" : "fail",
            boundary: "github-workflow",
            detail: passed
              ? "The exact package acquisition hook accepted the installed release receipt."
              : "The exact package acquisition hook did not accept the installed release receipt.",
            remediation: passed
              ? "None."
              : "Resolve the package acquisition failure, then verify again.",
          }),
        );
      }
    } catch {
      checks.push(
        frozenCheck({
          id: "package-acquisition",
          label: "Package acquisition",
          status: "fail",
          boundary: "github-workflow",
          detail:
            "The installed release does not contain a valid exact package receipt.",
          remediation:
            "Run the Codekeeper update flow to install a valid release receipt.",
        }),
      );
    }

    try {
      validateInstalledPolicy(structuredClone(installation.policy));
      checks.push(
        frozenCheck({
          id: "policy",
          label: "Policy",
          status: "pass",
          boundary: "local",
          detail: "The installed credential-free policy is valid.",
          remediation: "None.",
        }),
      );
    } catch {
      checks.push(
        frozenCheck({
          id: "policy",
          label: "Policy",
          status: "fail",
          boundary: "local",
          detail: "The installed credential-free policy is invalid.",
          remediation: "Repair the policy through the Codekeeper update flow.",
        }),
      );
    }
  }

  if (!controlledCheck) {
    checks.push(
      frozenCheck({
        id: "controlled-check",
        label: "Controlled check",
        status: "skipped",
        boundary: "github-workflow",
        detail: "No controlled workflow check was requested.",
        remediation:
          "Request this separately only when its effects are approved.",
        required: false,
      }),
    );
  } else if (!runControlledCheck) {
    checks.push(
      frozenCheck({
        id: "controlled-check",
        label: "Controlled check",
        status: "not-provable",
        boundary: "github-workflow",
        detail:
          "A controlled workflow check was requested, but no approved hook was supplied.",
        remediation:
          "Supply an approved controlled-check hook for this repository.",
        required: false,
      }),
    );
  } else {
    try {
      const result = await runControlledCheck({
        runner,
        root,
        repository,
        installation,
      });
      const passed = result === true || result?.status === "pass";
      checks.push(
        frozenCheck({
          id: "controlled-check",
          label: "Controlled check",
          status: passed ? "pass" : "fail",
          boundary: "github-workflow",
          detail: passed
            ? "The approved controlled workflow check passed."
            : "The approved controlled workflow check did not pass.",
          remediation: passed
            ? "None."
            : "Resolve the controlled-check failure, then verify again.",
          required: false,
        }),
      );
    } catch {
      checks.push(
        frozenCheck({
          id: "controlled-check",
          label: "Controlled check",
          status: "fail",
          boundary: "github-workflow",
          detail: "The approved controlled workflow check could not complete.",
          remediation:
            "Resolve the controlled-check failure, then verify again.",
          required: false,
        }),
      );
    }
  }

  return freezeReport({ repository, checks });
}
