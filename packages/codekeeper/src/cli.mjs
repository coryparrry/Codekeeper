import { stdin, stdout, stderr } from "node:process";
import { createCommandRunner } from "./command-runner.mjs";
import { loadVerifiedAssets } from "./assets.mjs";
import { createTerminalPrompter } from "./prompts.mjs";
import { doctorRepository, inspectRepository } from "./preflight.mjs";
import { appRegistrationUrl, buildInstallPlan, collectAppAnswers, collectAutomationBotLogin, collectAppPrivateKeyPath, collectSetupAnswers, buildUpdateAnswers, completionGuidance, documentMap, modelAssignments, requiresAutomationBotLogin } from "./plan.mjs";
import { installPlan } from "./install.mjs";
import { InstallerError, formatInstallerError } from "./errors.mjs";
import { MODES, PACKAGE_NAME, PACKAGE_VERSION, SECRET_PURPOSES } from "./constants.mjs";
import { normalizePackageRelease, RELEASE_VERSION } from "./package-release.mjs";
import { formatCommand } from "./shell-command.mjs";
import { runLatestUpdate, runRollback, runUpdateCheck, runVersionedUpdate } from "./updater.mjs";
import { verifyCodekeeperReadiness } from "./verify.mjs";
import { inspectInstalledAppRegistration, runAppCredentialProbe, runMaintenanceDryRun, verifyInstalledPackage } from "./verification-adapters.mjs";

export const USAGE = `Usage:
  codekeeper init
  codekeeper update [--to X.Y.Z]
  codekeeper update --check
  codekeeper rollback --to X.Y.Z
  codekeeper doctor [--json]
  codekeeper verify [--json] [--controlled]
  codekeeper init --current-package --package-integrity SHA512
  codekeeper update --current-package --package-integrity SHA512
  codekeeper --help
  codekeeper --version

Codekeeper init creates a setup pull request for GitHub.com.
Codekeeper update runs the latest CLI to refresh runtime dependencies and every release-owned installation file only when the target is newer. Use --to with an exact, newer release to select a verified target.
Codekeeper update --check reads the installed release manifest and resolves registry metadata; it does not mutate repository or GitHub state.
Codekeeper rollback --to X.Y.Z creates a normal forward update pull request from the verified target release. It never resets, reverts, or force-pushes.
Codekeeper doctor reports every safe installation prerequisite together.
Codekeeper verify proves an installed default-branch checkout and runs a no-mutation GitHub App credential probe; --controlled also runs a maintenance dry run.
Use --current-package with the tarball's SHA-512 integrity only for exact local release testing.
`;

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help")) return Object.freeze({ command: "help" });
  if (argv.length === 1 && argv[0] === "--version") return Object.freeze({ command: "version" });
  if (argv.length === 1 && argv[0] === "init") return Object.freeze({ command: "init" });
  if (argv.length === 2 && argv[0] === "init" && argv[1] === "--current-package") {
    return Object.freeze({ command: "init", currentPackage: true });
  }
  if (argv.length === 1 && argv[0] === "update") return Object.freeze({ command: "update" });
  if (argv.length === 2 && argv[0] === "update" && argv[1] === "--check") return Object.freeze({ command: "update", check: true });
  if (argv.length === 3 && argv[0] === "update" && argv[1] === "--to" && RELEASE_VERSION.test(argv[2])) {
    return Object.freeze({ command: "update", targetVersion: argv[2] });
  }
  if (argv.length === 3 && argv[0] === "rollback" && argv[1] === "--to" && RELEASE_VERSION.test(argv[2])) {
    return Object.freeze({ command: "rollback", targetVersion: argv[2] });
  }
  if (argv.length === 1 && argv[0] === "doctor") return Object.freeze({ command: "doctor", json: false });
  if (argv.length === 2 && argv[0] === "doctor" && argv[1] === "--json") return Object.freeze({ command: "doctor", json: true });
  if (argv[0] === "verify") {
    const options = new Set(argv.slice(1));
    if (options.size !== argv.length - 1 || [...options].some((option) => !["--json", "--controlled"].includes(option))) {
      throw new InstallerError("Unsupported verify option.", {
        code: "CLI_USAGE"
      });
    }
    return Object.freeze({
      command: "verify",
      json: options.has("--json"),
      controlled: options.has("--controlled")
    });
  }
  if (argv.length === 2 && argv[0] === "update" && argv[1] === "--current-package") {
    return Object.freeze({ command: "update", currentPackage: true });
  }
  if (argv.length === 4 && new Set(["init", "update"]).has(argv[0]) && argv[1] === "--current-package" && argv[2] === "--package-integrity" && argv[3]) {
    return Object.freeze({
      command: argv[0],
      currentPackage: true,
      packageIntegrity: argv[3]
    });
  }
  throw new InstallerError("Unsupported command or option.", {
    code: "CLI_USAGE"
  });
}

export function currentResumeCommand(execPath = process.execPath, binPath = process.argv[1], platform = process.platform, command = "init", packageIntegrity = null) {
  if (typeof binPath !== "string" || !binPath) return `codekeeper ${command}`;
  const args = [binPath, command];
  if (packageIntegrity) args.push("--current-package", "--package-integrity", packageIntegrity);
  return formatCommand(execPath, args, platform);
}

async function bestEffortOpen(url, { runner, platform = process.platform }) {
  const invocation = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["explorer.exe", [url]] : ["xdg-open", [url]];
  try {
    const result = await runner.run(invocation[0], invocation[1], {
      stdio: "ignore",
      timeoutMs: 5_000
    });
    return result.status === 0 && !result.timedOut;
  } catch {
    return false;
  }
}

function assertSameSnapshot(expected, actual, resumeCommand, { includeSettings = true } = {}) {
  for (const field of ["root", "originUrl", "repository", "defaultBranch", "headSha", "remoteDefaultSha", "viewerLogin"]) {
    if (expected[field] !== actual[field]) {
      throw new InstallerError("The repository changed during setup. Run the installer again.", {
        code: "PREFLIGHT_CHANGED",
        resume: resumeCommand
      });
    }
  }
  if (includeSettings) {
    const expectedSettings = expected.existingSettings ?? null;
    const actualSettings = actual.existingSettings ?? null;
    const settingsChanged = (expectedSettings === null) !== (actualSettings === null) || (expectedSettings !== null && ["enabled", "appClientId", "automationBotLogin"].some((field) => expectedSettings[field] !== actualSettings[field]));
    if (settingsChanged) {
      throw new InstallerError("The repository changed during setup. Run the installer again.", {
        code: "PREFLIGHT_CHANGED",
        resume: resumeCommand
      });
    }
  }
}

function operationLabel(plan, { capitalized = false } = {}) {
  const label = plan.operation === "release-update" ? "release update" : plan.operation === "configuration-update" ? "configuration" : "setup";
  return capitalized ? `${label[0].toUpperCase()}${label.slice(1)}` : label;
}

function preview(plan, output) {
  const operation = operationLabel(plan, { capitalized: true });
  output.write(`\n${operation} preview\n`);
  output.write(`  Repository: ${plan.repository}\n`);
  output.write(`  Default branch: ${plan.defaultBranch}\n`);
  output.write(`  Comment display name: ${plan.displayName}\n`);
  output.write(`  Owner-command users: ${plan.ownerLogins.join(", ")}\n`);
  output.write(`  Starting model set: ${plan.preset}\n`);
  output.write(`  Release: Codekeeper ${plan.packageVersion} · ${plan.source.repository}@${plan.source.commit}\n`);
  output.write(`  ${operation} branch: ${plan.settingsOnly ? "not needed for this settings change" : plan.branch}\n`);
  output.write("  Workflows:\n");
  for (const mode of plan.modes) output.write(`    - ${MODES[mode].label}: ${MODES[mode].description}\n`);
  output.write("  Models (editable in .github/codekeeper.json before merge):\n");
  for (const { key, label, workflow } of modelAssignments(plan.modes)) {
    const summary = plan.modelSummary[key];
    output.write(`    - ${label} (${workflow}): ${summary.coordinator.provider} / ${summary.coordinator.model} / ${summary.coordinator.effort} effort\n`);
    output.write(`      workspace: ${summary.workspace.enabled ? `${summary.workspace.model} / ${summary.workspace.effort} / ${summary.workspace.allowWrites ? "write-enabled" : "read-only"}` : "off"}\n`);
  }
  output.write(`  OpenAI traces: ${plan.tracing ? "enabled" : "disabled"}\n`);
  output.write(`  Scheduled maintenance: ${plan.maintenanceScheduled ? "enabled; report-only (cannot modify GitHub)" : "disabled; manual runs remain available"}\n`);
  output.write(`  GitHub App: contents ${plan.appPermissions.contents}; issues ${plan.appPermissions.issues}; pull requests ${plan.appPermissions.pullRequests}; metadata read-only; selected repository only\n`);
  output.write(`  Code-changing capabilities: ${["reviewRepair", "repair", "issueImplementation"].some((id) => plan.capabilities[id]) ? "enabled" : "off"}; automatic merge: ${plan.capabilities.autoMerge ? "enabled" : "off"}\n`);
  output.write("  Files:\n");
  for (const file of plan.files) output.write(`    - ${file.path}\n`);
  output.write("  You can edit decision guidance in .github/codekeeper/agents. These files cannot grant access.\n");
  output.write(`  Variables created or replaced (${plan.variables.length}): ${plan.variables.map((item) => item.name).join(", ") || "none"}\n`);
  output.write("  Secrets sent directly to GitHub CLI. Codekeeper does not display or store their values:\n");
  for (const secret of plan.secrets) output.write(`    - ${secret.name}: ${SECRET_PURPOSES[secret.name]}\n`);
  output.write(`  Validation after merge: codekeeper verify\n`);
  if (plan.secrets.some((secret) => secret.name === "CODEKEEPER_APP_PRIVATE_KEY")) {
    output.write("  The GitHub App PEM is supplied from its downloaded file, never pasted into a terminal prompt.\n");
  }
  output.write(`  Startup: ${plan.update && plan.enabled ? "enabled now; update applies after merge" : plan.enabled ? "enabled after merge" : "disabled after merge"}\n`);
  output.write(`  The installer will not merge the ${operation.toLowerCase()} pull request.\n`);
  if (plan.modes.includes("review") && !plan.enabled) {
    output.write("  Keep the Codekeeper review gate optional while Codekeeper is disabled.\n");
  }
}

function printCompletion(plan, receipt, output) {
  output.write(receipt.settingsOnly ? "\nUpdated the Codekeeper repository settings. No pull request was needed.\n" : `\nCreated ${operationLabel(plan)} pull request: ${receipt.pullRequestUrl}\n`);
  output.write(`Pinned source: ${plan.source.repository}@${plan.source.commit}\n`);
  output.write(`CLI release: ${plan.packageVersion}\n`);
  output.write("\nDocument map\n");
  for (const item of documentMap(plan.files)) output.write(`  - ${item.path}: ${item.purpose}\n`);
  const guidance = completionGuidance(plan.modes, plan.enabled, plan.update);
  output.write(`\n${guidance.profileGuidance}\n`);
  output.write(`\n${guidance.heading}\n`);
  if (guidance.reviewGateWarning) output.write(`${guidance.reviewGateWarning}\n`);
  output.write(`${guidance.closing}\n`);
}

function doctorSymbol(status) {
  return status === "pass" ? "✓" : status === "warning" ? "⚠" : status === "skipped" ? "·" : "✕";
}

function printDoctor(report, output) {
  output.write("\nRepository readiness\n");
  for (const check of report.checks) {
    output.write(`${doctorSymbol(check.status)} ${check.label}: ${check.detail}\n`);
    if (check.status !== "pass" && check.remediation) output.write(`  ${check.remediation}\n`);
  }
  output.write(`\n${report.counts.pass} passed · ${report.counts.warning} warnings · ${report.counts.fail} failed\n`);
}

function printVerification(report, output) {
  const heading = report.ready
    ? "Codekeeper is ready"
    : report.configurationReady
      ? "Codekeeper configuration is ready, but operational verification is incomplete"
      : "Codekeeper is not ready";
  output.write(`\n${heading}\n`);
  for (const check of report.checks) {
    const symbol = check.status === "pass" ? "✓" : check.status === "skipped" ? "·" : "✕";
    output.write(`${symbol} ${check.label}: ${check.detail}\n`);
    if (!["pass", "skipped"].includes(check.status) && check.remediation) output.write(`  ${check.remediation}\n`);
  }
}

function installedAppVariables(snapshot) {
  return {
    CODEKEEPER_APP_CLIENT_ID: snapshot.existingSettings.appClientId,
    CODEKEEPER_AUTOMATION_BOT_LOGIN: snapshot.existingSettings.automationBotLogin
  };
}

async function reconcileExistingApp({ inspectAppRegistration, runner, snapshot, desiredInstallation, prompt, output, openUrl, resumeCommand }) {
  const inspect = () => inspectAppRegistration({
    runner,
    root: snapshot.root,
    repository: snapshot.repository,
    installation: desiredInstallation,
    variables: installedAppVariables(snapshot)
  });
  let proof = await inspect();
  if (proof?.status === "pass") return;
  if (proof?.reason === "registration-unavailable") {
    output.write("\nGitHub App registration is private and cannot be inspected with the GitHub CLI token.\n");
    output.write("  The post-merge no-mutation credential probe will prove App identity, installation, repository access, and required permissions.\n");
    return;
  }

  output.write("\nGitHub App permission update required\n");
  if (Array.isArray(proof?.permissionDelta) && proof.permissionDelta.length > 0) {
    for (const item of proof.permissionDelta) {
      output.write(`  ${item.permission}: registered ${item.registered}; required ${item.required}\n`);
    }
  } else {
    output.write("  The configured App identity or registration permissions could not be proven.\n");
  }
  if (proof?.settingsUrl) {
    output.write(`  Update the App registration permissions:\n  ${proof.settingsUrl}\n`);
    try {
      await openUrl(proof.settingsUrl);
    } catch {
      // The printed URL remains the authoritative recovery path.
    }
  }
  const ready = await prompt.confirm({
    message: "Have you updated the App registration permissions?",
    defaultValue: false
  });
  if (!ready) {
    throw new InstallerError("Update the GitHub App registration permissions before continuing this Codekeeper update.", {
      code: "APP_PERMISSIONS_MISMATCH",
      resume: resumeCommand
    });
  }
  proof = await inspect();
  if (proof?.status !== "pass") {
    throw new InstallerError("The GitHub App registration permissions still do not exactly match this update.", {
      code: "APP_PERMISSIONS_MISMATCH",
      resume: resumeCommand
    });
  }
  output.write("  GitHub App registration permissions now match this update.\n");
}

export async function runCli({ argv = process.argv.slice(2), cwd = process.cwd(), input = stdin, output = stdout, errorOutput = stderr, runner = createCommandRunner(), prompt = null, interactive = input.isTTY === true && output.isTTY === true, environment = process.env, platform = process.platform, openUrl = null, loadAssets = loadVerifiedAssets, inspect = inspectRepository, inspectAppRegistration = inspectInstalledAppRegistration, doctor = doctorRepository, showDoctor = true, verifyReadiness = verifyCodekeeperReadiness, verifyAppCredentials = runAppCredentialProbe, resumeCommand = null, launchLatestUpdate = runLatestUpdate, launchVersionedUpdate = runVersionedUpdate, launchRollback = runRollback, checkUpdate = runUpdateCheck } = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    errorOutput.write(`${formatInstallerError(error)}\n${USAGE}`);
    return 2;
  }
  if (parsed.command === "help") {
    output.write(USAGE);
    return 0;
  }
  if (parsed.command === "version") {
    output.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  if (parsed.command === "update" && parsed.currentPackage !== true) {
    try {
      if (parsed.check) return await checkUpdate({ cwd, output, environment, platform });
      const launchOptions = { cwd, output, environment, platform };
      if (parsed.targetVersion) {
        launchOptions.requestedVersion = parsed.targetVersion;
        return await launchVersionedUpdate(launchOptions);
      }
      return await launchLatestUpdate(launchOptions);
    } catch (error) {
      errorOutput.write(`${formatInstallerError(error)}\n`);
      return 1;
    }
  }
  if (parsed.command === "rollback" && parsed.currentPackage !== true) {
    try {
      return await launchRollback({
        cwd,
        output,
        environment,
        platform,
        targetVersion: parsed.targetVersion
      });
    } catch (error) {
      errorOutput.write(`${formatInstallerError(error)}\n`);
      return 1;
    }
  }
  if (["doctor", "verify"].includes(parsed.command)) {
    try {
      if (typeof runner.resolveTrustedCommands === "function") {
        runner = await runner.resolveTrustedCommands({
          cwd,
          ...(parsed.command === "doctor" ? { allowMissingCommands: ["git", "gh"] } : {})
        });
      }
      if (parsed.command === "doctor") {
        const report = await doctor({ runner, cwd });
        if (parsed.json) output.write(`${JSON.stringify(report)}\n`);
        else printDoctor(report, output);
        return report.mutationAllowed ? 0 : 1;
      }
      const report = await verifyReadiness({
        runner,
        cwd,
        inspectApp: inspectInstalledAppRegistration,
        verifyAppCredentials,
        verifyPackage: (input) => verifyInstalledPackage(input, { runner, environment, platform }),
        controlledCheck: parsed.controlled,
        runControlledCheck: parsed.controlled ? runMaintenanceDryRun : null
      });
      if (parsed.json) output.write(`${JSON.stringify(report)}\n`);
      else printVerification(report, output);
      return report.ready ? 0 : 1;
    } catch (error) {
      errorOutput.write(`${formatInstallerError(error)}\n`);
      return 1;
    }
  }
  let packageRelease;
  try {
    if (typeof environment.CODEKEEPER_UPDATE_EXPECTED_VERSION === "string" && environment.CODEKEEPER_UPDATE_EXPECTED_VERSION !== PACKAGE_VERSION) {
      throw new InstallerError("npm launched a different Codekeeper version than requested.", { code: "UPDATE_VERSION_MISMATCH" });
    }
    const releaseEnvironment = environment;
    packageRelease = normalizePackageRelease(
      {
        name: PACKAGE_NAME,
        version: releaseEnvironment.CODEKEEPER_UPDATE_EXPECTED_VERSION ?? (parsed.currentPackage ? PACKAGE_VERSION : undefined),
        integrity: parsed.packageIntegrity ?? releaseEnvironment.CODEKEEPER_UPDATE_EXPECTED_INTEGRITY
      },
      { code: "UPDATE_VERSION_MISMATCH" }
    );
  } catch (error) {
    errorOutput.write(`${formatInstallerError(error)}\n`);
    return 1;
  }
  resumeCommand ??= currentResumeCommand(process.execPath, process.argv[1], platform, parsed.command, parsed.packageIntegrity);

  let activePrompt = prompt;
  try {
    if (typeof runner.resolveTrustedCommands === "function") {
      runner = await runner.resolveTrustedCommands({ cwd });
    }
    const safelyOpenUrl = openUrl ?? ((url) => bestEffortOpen(url, { runner, platform }));
    const bundle = await loadAssets({ packageRelease });
    const ensureActivePrompt = async () => {
      if (activePrompt) return;
      const likelyTui = interactive && input?.isTTY === true && output?.isTTY === true && typeof input?.setRawMode === "function" && String(environment?.TERM ?? "").toLowerCase() !== "dumb";
      if (likelyTui) {
        let tui;
        try {
          tui = await import("./tui.mjs");
        } catch (cause) {
          throw new InstallerError("The interactive terminal UI failed to load.", { code: "TUI_UNAVAILABLE", cause });
        }
        activePrompt = tui.shouldUseInkTui({
          interactive,
          input,
          output,
          environment
        })
          ? await tui.createInkPrompter({
              input,
              output,
              errorOutput,
              environment
            })
          : createTerminalPrompter({ input, output });
      } else {
        activePrompt = createTerminalPrompter({ input, output });
      }
    };
    if (parsed.command !== "update") await ensureActivePrompt();
    let presentationOutput = activePrompt?.kind === "ink" ? activePrompt.notices : output;
    if (showDoctor) {
      const doctorReport = await doctor({ runner, cwd });
      if (typeof activePrompt?.showDoctor === "function") await activePrompt.showDoctor(doctorReport);
      else printDoctor(doctorReport, output);
      if (!doctorReport.mutationAllowed) {
        throw new InstallerError("Repository readiness checks failed. Fix every failed item, then run Codekeeper again.", {
          code: "DOCTOR_FAILED"
        });
      }
    }
    const snapshot = await inspect({ runner, cwd, interactive });
    let setupAnswers =
      parsed.command === "update"
        ? buildUpdateAnswers({ snapshot, bundle, output: presentationOutput })
        : await collectSetupAnswers({
            prompt: activePrompt,
            snapshot,
            bundle,
            output: presentationOutput
          });
    let appAnswers;
    if (parsed.command === "update") {
      appAnswers = {
        appClientId: snapshot.existingSettings.appClientId,
        automationBotLogin: snapshot.existingSettings.automationBotLogin
      };
    } else if (snapshot.installation) {
      appAnswers = {
        appClientId: snapshot.existingSettings.appClientId,
        automationBotLogin: snapshot.existingSettings.automationBotLogin
      };
      const ownerRequests = setupAnswers.policy?.automation.ownerRequests ?? snapshot.installation.policy.automation.ownerRequests;
      if (requiresAutomationBotLogin(setupAnswers.modes, setupAnswers.capabilities, ownerRequests) && !appAnswers.automationBotLogin) {
        presentationOutput.write("\nGitHub App identifier\n");
        appAnswers.automationBotLogin = await collectAutomationBotLogin({
          prompt: activePrompt,
          output: presentationOutput
        });
      }
    } else {
      const registrationUrl = appRegistrationUrl({
        repository: snapshot.repository,
        displayName: setupAnswers.displayName,
        ownerType: snapshot.ownerType,
        modes: setupAnswers.modes,
        capabilities: setupAnswers.capabilities,
        ownerRequests: setupAnswers.policy?.automation?.ownerRequests ?? true
      });
      presentationOutput.write(`\nUse a GitHub App that you own. Install it only on ${snapshot.repository}.\nGitHub pre-fills Codekeeper's required permissions. Do not change them; Codekeeper will verify the App after the setup pull request merges. GitHub does not create the App until you submit the form.\n${registrationUrl}\n`);
      try {
        await safelyOpenUrl(registrationUrl);
      } catch {
        // Opening the browser is best-effort; the printed URL is always authoritative.
      }
      const appReady = await activePrompt.confirm({
        message: "Have you chosen or created the App, installed it on this repository, and downloaded its private key?",
        defaultValue: true,
        ...(activePrompt.kind === "ink"
          ? {
              step: "GitHub App",
              description: ["Codekeeper opened a prefilled GitHub page in your browser.", "1. Review the prefilled permissions. Do not change them, then create the App.", `2. Install the App only on ${snapshot.repository}.`, "3. Create and download one private key. Codekeeper verifies the App after merge."],
              yesLabel: "App and key ready",
              noLabel: "Stop for now"
            }
          : {})
      });
      if (!appReady) {
        throw new InstallerError("Complete GitHub App creation and installation, then rerun init.", {
          code: "APP_SETUP_ABORTED",
          resume: resumeCommand
        });
      }
      appAnswers = await collectAppAnswers({
        prompt: activePrompt,
        modes: setupAnswers.modes,
        capabilities: setupAnswers.capabilities,
        ownerRequests: setupAnswers.policy?.automation.ownerRequests ?? true,
        output: presentationOutput
      });
    }
    let plan;
    try {
      plan = buildInstallPlan({
        bundle,
        snapshot,
        answers: { ...setupAnswers, ...appAnswers }
      });
    } catch (error) {
      if (parsed.command !== "update" || error?.code !== "NO_CHANGES") throw error;
      await ensureActivePrompt();
      presentationOutput = activePrompt.kind === "ink" ? activePrompt.notices : output;
      await reconcileExistingApp({
        inspectAppRegistration,
        runner,
        snapshot,
        desiredInstallation: {
          modes: setupAnswers.modes,
          policy: setupAnswers.policy ?? snapshot.installation.policy
        },
        prompt: activePrompt,
        output: presentationOutput,
        openUrl: safelyOpenUrl,
        resumeCommand
      });
      presentationOutput.write(`\nCodekeeper is already up to date at ${bundle.metadata.source.repository}@${bundle.metadata.source.commit}. No files or settings were changed. Required secret availability was not validated; secret values were not inspected or exposed.\n`);
      await activePrompt?.dispose?.();
      return 0;
    }
    await ensureActivePrompt();
    presentationOutput = activePrompt.kind === "ink" ? activePrompt.notices : output;
    const appPrivateKeyPath = plan.secrets.some((secret) => secret.name === "CODEKEEPER_APP_PRIVATE_KEY")
      ? await collectAppPrivateKeyPath({
          prompt: activePrompt,
          output: presentationOutput
        })
      : null;
    let confirmed;
    while (true) {
      if (snapshot.installation) {
        await reconcileExistingApp({
          inspectAppRegistration,
          runner,
          snapshot,
          desiredInstallation: { modes: plan.modes, policy: plan.policy },
          prompt: activePrompt,
          output: presentationOutput,
          openUrl: safelyOpenUrl,
          resumeCommand
        });
      }
      if (typeof activePrompt.reviewInstallPlan === "function") {
        confirmed = await activePrompt.reviewInstallPlan(plan);
      } else {
        preview(plan, output);
        confirmed = await activePrompt.confirm({
          message: `Create this ${operationLabel(plan)}?`,
          defaultValue: false
        });
      }
      if (confirmed !== "settings") break;
      setupAnswers = await collectSetupAnswers({
        prompt: activePrompt,
        snapshot,
        bundle,
        output: presentationOutput,
        initialAnswers: setupAnswers
      });
      const ownerRequests = setupAnswers.policy?.automation.ownerRequests ?? true;
      if (requiresAutomationBotLogin(setupAnswers.modes, setupAnswers.capabilities, ownerRequests) && !appAnswers.automationBotLogin) {
        appAnswers = {
          ...appAnswers,
          automationBotLogin: await collectAutomationBotLogin({
            prompt: activePrompt,
            output: presentationOutput
          })
        };
      }
      plan = buildInstallPlan({
        bundle,
        snapshot,
        answers: { ...setupAnswers, ...appAnswers }
      });
    }
    if (!confirmed) {
      throw new InstallerError(`${operationLabel(plan, { capitalized: true })} was cancelled before repository mutation.`, {
        code: "USER_CANCELLED"
      });
    }

    activePrompt.progress?.start();
    activePrompt.progress?.update({
      id: "repository:verify",
      status: "active"
    });
    const beforeMutation = await inspect({
      runner,
      cwd: snapshot.root,
      interactive
    });
    assertSameSnapshot(snapshot, beforeMutation, resumeCommand);
    activePrompt.progress?.update({ id: "repository:verify", status: "done" });
    let receipt = await installPlan(plan, {
      runner,
      output: presentationOutput,
      appPrivateKeyPath,
      onProgress: activePrompt.progress?.update,
      withSecretInput: typeof activePrompt.inputSecret === "function" ? (spec) => activePrompt.inputSecret(spec) : null,
      withInteractiveTerminal: typeof activePrompt.suspendTerminal === "function" ? (callback, notice) => activePrompt.suspendTerminal(callback, notice) : (callback) => callback(),
      resumeCommand,
      platform
    });
    if (!receipt.settingsOnly) {
      let pullRequestOpened = false;
      try {
        pullRequestOpened = (await safelyOpenUrl(receipt.pullRequestUrl)) !== false;
      } catch {
        // The completion screen always shows the verified pull request URL.
      }
      receipt = Object.freeze({ ...receipt, pullRequestOpened });
    }
    if (typeof activePrompt.showCompletion === "function") await activePrompt.showCompletion(plan, receipt);
    else printCompletion(plan, receipt, output);
    await activePrompt.dispose?.();
    return 0;
  } catch (error) {
    try {
      await activePrompt?.dispose?.();
    } catch {
      // Report the original installer error after best-effort terminal cleanup.
    }
    errorOutput.write(`${formatInstallerError(error)}\n`);
    return error?.code === "CLI_USAGE" ? 2 : 1;
  }
}
