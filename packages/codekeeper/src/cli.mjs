import { stdin, stdout, stderr } from "node:process";
import { createCommandRunner } from "./command-runner.mjs";
import { loadVerifiedAssets } from "./assets.mjs";
import { createTerminalPrompter } from "./prompts.mjs";
import { inspectRepository } from "./preflight.mjs";
import {
  appRegistrationUrl,
  buildInstallPlan,
  collectAppAnswers,
  collectAutomationBotLogin,
  collectAppPrivateKeyPath,
  collectSetupAnswers,
  completionGuidance,
  documentMap,
  modelAssignments,
  requiresAutomationBotLogin,
} from "./plan.mjs";
import { configureRepositorySettings, installPlan } from "./install.mjs";
import { InstallerError, formatInstallerError } from "./errors.mjs";
import { MODES, PACKAGE_VERSION, SECRET_PURPOSES } from "./constants.mjs";
import { formatCommand } from "./shell-command.mjs";

export const USAGE = `Usage:
  codekeeper init
  codekeeper --help
  codekeeper --version

Codekeeper init creates a setup pull request for GitHub.com.
`;

export function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help")) return Object.freeze({ command: "help" });
  if (argv.length === 1 && argv[0] === "--version") return Object.freeze({ command: "version" });
  if (argv.length === 1 && argv[0] === "init") return Object.freeze({ command: "init" });
  throw new InstallerError("Unsupported command or option.", { code: "CLI_USAGE" });
}

export function currentResumeCommand(execPath = process.execPath, binPath = process.argv[1], platform = process.platform) {
  if (typeof binPath !== "string" || !binPath) return "codekeeper init";
  return formatCommand(execPath, [binPath, "init"], platform);
}

async function bestEffortOpen(url, { runner, platform = process.platform }) {
  const invocation = platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["explorer.exe", [url]]
      : ["xdg-open", [url]];
  try {
    const result = await runner.run(invocation[0], invocation[1], { stdio: "ignore", timeoutMs: 5_000 });
    return result.status === 0 && !result.timedOut;
  } catch {
    return false;
  }
}

function assertSameSnapshot(expected, actual, resumeCommand) {
  for (const field of ["root", "originUrl", "repository", "defaultBranch", "headSha", "remoteDefaultSha", "viewerLogin"]) {
    if (expected[field] !== actual[field]) {
      throw new InstallerError("The repository changed during setup. Run the installer again.", {
        code: "PREFLIGHT_CHANGED",
        resume: resumeCommand
      });
    }
  }
}

function preview(plan, output) {
  output.write("\nSetup preview\n");
  output.write(`  Repository: ${plan.repository}\n`);
  output.write(`  Default branch: ${plan.defaultBranch}\n`);
  output.write(`  Comment display name: ${plan.displayName}\n`);
  output.write(`  Owner-command users: ${plan.ownerLogins.join(", ")}\n`);
  output.write(`  Starting model set: ${plan.preset}\n`);
  output.write(`  Setup branch: ${plan.settingsOnly ? "not needed for this settings change" : plan.branch}\n`);
  output.write("  Workflows:\n");
  for (const mode of plan.modes) output.write(`    - ${MODES[mode].label}: ${MODES[mode].description}\n`);
  output.write("  Models (editable in .github/codekeeper.json before merge):\n");
  for (const { key, label, workflow } of modelAssignments(plan.modes)) {
    const selection = plan.models[key];
    output.write(`    - ${label} (${workflow}): ${selection.provider} / ${selection.model} / ${selection.effort} effort\n`);
  }
  output.write(`  OpenAI traces: ${plan.tracing ? "enabled" : "disabled"}\n`);
  output.write("  Files:\n");
  for (const file of plan.files) output.write(`    - ${file.path}\n`);
  output.write("  You can edit decision guidance in .github/codekeeper/agents. These files cannot grant access.\n");
  output.write(`  Variables: ${plan.variables.map((item) => item.name).join(", ")}\n`);
  output.write("  Secrets sent directly to GitHub CLI. Codekeeper does not display or store their values:\n");
  for (const secret of plan.secrets) output.write(`    - ${secret.name}: ${SECRET_PURPOSES[secret.name]}\n`);
  output.write("  The GitHub App PEM is supplied from its downloaded file, never pasted into a terminal prompt.\n");
  output.write(`  Startup: ${plan.update && plan.enabled ? "enabled now; update applies after merge" : plan.enabled ? "enabled after merge" : "disabled after merge"}\n`);
  output.write("  The installer will not merge the setup pull request.\n");
  if (plan.modes.includes("review")) {
    output.write("  Do not make the Codekeeper review gate required until a controlled review passes.\n");
  }
}

function printCompletion(plan, receipt, output) {
  output.write(receipt.settingsOnly
    ? "\nUpdated the Codekeeper repository settings. No pull request was needed.\n"
    : `\nCreated setup pull request: ${receipt.pullRequestUrl}\n`);
  output.write(`Pinned source: ${plan.source.repository}@${plan.source.commit}\n`);
  output.write("\nDocument map\n");
  for (const item of documentMap(plan.files)) output.write(`  - ${item.path}: ${item.purpose}\n`);
  const guidance = completionGuidance(plan.modes, plan.enabled, plan.update);
  output.write(`\n${guidance.profileGuidance}\n`);
  output.write(`\n${guidance.heading}\n`);
  for (const item of guidance.proofs) output.write(`  - ${item.mode}: ${item.instruction}\n`);
  if (guidance.reviewGateWarning) output.write(`${guidance.reviewGateWarning}\n`);
  output.write(`${guidance.closing}\n`);
}

export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  input = stdin,
  output = stdout,
  errorOutput = stderr,
  runner = createCommandRunner(),
  prompt = null,
  interactive = input.isTTY === true && output.isTTY === true,
  environment = process.env,
  platform = process.platform,
  openUrl = null,
  loadAssets = loadVerifiedAssets,
  inspect = inspectRepository,
  resumeCommand = currentResumeCommand(process.execPath, process.argv[1], platform)
} = {}) {
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

  let activePrompt = prompt;
  try {
    if (typeof runner.resolveTrustedCommands === "function") {
      runner = await runner.resolveTrustedCommands({ cwd });
    }
    const bundle = await loadAssets();
    if (!activePrompt) {
      const likelyTui = interactive
        && input?.isTTY === true
        && output?.isTTY === true
        && typeof input?.setRawMode === "function"
        && String(environment?.TERM ?? "").toLowerCase() !== "dumb";
      if (likelyTui) {
        let tui;
        try {
          tui = await import("./tui.mjs");
        } catch (cause) {
          throw new InstallerError("The interactive terminal UI failed to load.", { code: "TUI_UNAVAILABLE", cause });
        }
        activePrompt = tui.shouldUseInkTui({ interactive, input, output, environment })
          ? await tui.createInkPrompter({ input, output, errorOutput, environment })
          : createTerminalPrompter({ input, output });
      } else {
        activePrompt = createTerminalPrompter({ input, output });
      }
    }
    const presentationOutput = activePrompt.kind === "ink" ? activePrompt.notices : output;
    const snapshot = await inspect({ runner, cwd, interactive });
    const setupAnswers = await collectSetupAnswers({ prompt: activePrompt, snapshot, bundle, output: presentationOutput });
    let appAnswers;
    if (snapshot.installation) {
      appAnswers = {
        appClientId: snapshot.existingSettings.appClientId,
        automationBotLogin: snapshot.existingSettings.automationBotLogin
      };
      const ownerRequests = setupAnswers.policy?.automation.ownerRequests
        ?? snapshot.installation.policy.automation.ownerRequests;
      if (requiresAutomationBotLogin(setupAnswers.modes, setupAnswers.capabilities, ownerRequests) && !appAnswers.automationBotLogin) {
        presentationOutput.write("\nGitHub App identifier\n");
        appAnswers.automationBotLogin = await collectAutomationBotLogin({ prompt: activePrompt, output: presentationOutput });
      }
    } else {
      const registrationUrl = appRegistrationUrl({
        repository: snapshot.repository,
        displayName: setupAnswers.displayName,
        ownerType: snapshot.ownerType
      });
      const safelyOpenUrl = openUrl ?? ((url) => bestEffortOpen(url, { runner, platform }));
      presentationOutput.write(`\nUse a GitHub App that you own. Install it only on ${snapshot.repository}.\nThe link creates an App with the required permissions. If you already installed one, close the page and use it.\n${registrationUrl}\n`);
      try {
        await safelyOpenUrl(registrationUrl);
      } catch {
        // Opening the browser is best-effort; the printed URL is always authoritative.
      }
      const appReady = await activePrompt.confirm({
        message: "Have you chosen or created the App, installed it on this repository, and downloaded its private key?",
        defaultValue: false,
        ...(activePrompt.kind === "ink" ? {
          step: "GitHub App",
          description: [
            `Required for: ${snapshot.repository}`,
            "The App needs read and write access to contents, issues, and pull requests.",
            "The App needs read-only access to metadata. Webhooks stay disabled.",
            "Create or inspect the App in the browser, install it only on this repository, then download a new private key.",
            registrationUrl
          ],
          yesLabel: "App and key ready",
          noLabel: "Stop for now"
        } : {})
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
    const plan = buildInstallPlan({
      bundle,
      snapshot,
      answers: { ...setupAnswers, ...appAnswers }
    });
    const appPrivateKeyPath = plan.secrets.some((secret) => secret.name === "CODEKEEPER_APP_PRIVATE_KEY")
      ? await collectAppPrivateKeyPath({ prompt: activePrompt, output: presentationOutput })
      : null;
    let confirmed;
    if (typeof activePrompt.reviewInstallPlan === "function") {
      confirmed = await activePrompt.reviewInstallPlan(plan);
    } else {
      preview(plan, output);
      confirmed = await activePrompt.confirm({ message: "Create this setup?", defaultValue: false });
    }
    if (!confirmed) throw new InstallerError("Setup was cancelled before repository mutation.", { code: "USER_CANCELLED" });

    activePrompt.progress?.start();
    activePrompt.progress?.update({ id: "repository:verify", status: "active" });
    const beforeSettings = await inspect({ runner, cwd: snapshot.root, interactive });
    assertSameSnapshot(snapshot, beforeSettings, resumeCommand);
    activePrompt.progress?.update({ id: "repository:verify", status: "done" });
    await configureRepositorySettings(plan, {
      runner,
      output: presentationOutput,
      appPrivateKeyPath,
      onProgress: activePrompt.progress?.update,
      withSecretInput: typeof activePrompt.inputSecret === "function"
        ? (spec) => activePrompt.inputSecret(spec)
        : null,
      withInteractiveTerminal: typeof activePrompt.suspendTerminal === "function"
        ? (callback, notice) => activePrompt.suspendTerminal(callback, notice)
        : (callback) => callback(),
      resumeCommand
    });
    let receipt;
    if (plan.settingsOnly) {
      receipt = Object.freeze({ settingsOnly: true, pullRequestUrl: "No pull request was needed." });
    } else {
      const beforeGit = await inspect({ runner, cwd: snapshot.root, interactive });
      assertSameSnapshot(snapshot, beforeGit, resumeCommand);
      receipt = await installPlan(plan, {
        runner,
        onProgress: activePrompt.progress?.update,
        resumeCommand,
        platform
      });
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
