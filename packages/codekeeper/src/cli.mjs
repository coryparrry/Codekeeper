import { stdin, stdout, stderr } from "node:process";
import { createCommandRunner } from "./command-runner.mjs";
import { loadVerifiedAssets } from "./assets.mjs";
import { createTerminalPrompter } from "./prompts.mjs";
import { inspectRepository } from "./preflight.mjs";
import {
  appRegistrationUrl,
  buildInstallPlan,
  collectAppAnswers,
  collectSetupAnswers,
  documentMap,
  workflowMap
} from "./plan.mjs";
import { configureRepositorySettings, installPlan } from "./install.mjs";
import { InstallerError, formatInstallerError } from "./errors.mjs";
import { MODES, PACKAGE_VERSION, SECRET_PURPOSES } from "./constants.mjs";
import { formatCommand } from "./shell-command.mjs";

export const USAGE = `Usage:
  codekeeper init
  codekeeper --help
  codekeeper --version

Codekeeper init creates a disabled setup pull request for GitHub.com.
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
      throw new InstallerError("Repository state changed during setup. Automation remains disabled.", {
        code: "PREFLIGHT_CHANGED",
        resume: resumeCommand
      });
    }
  }
}

function preview(plan, output) {
  const policyFile = plan.files.find((file) => file.path === ".github/codekeeper.json");
  const policy = JSON.parse(policyFile.contents);
  output.write("\nSetup preview\n");
  output.write(`  Repository: ${plan.repository}\n`);
  output.write(`  Default branch: ${plan.defaultBranch}\n`);
  output.write(`  Comment display name: ${plan.displayName}\n`);
  output.write(`  Owner-command users: ${plan.ownerLogins.join(", ")}\n`);
  output.write(`  Provider preset: ${plan.preset}${plan.preset === "openai" ? " (one OpenAI provider key)" : " (DeepSeek issue triage; OpenAI otherwise)"}\n`);
  output.write(`  Setup branch: ${plan.branch}\n`);
  output.write("  Workflows:\n");
  for (const mode of plan.modes) output.write(`    - ${MODES[mode].label}: ${MODES[mode].description}\n`);
  output.write("  Models (editable in .github/codekeeper.json before merge):\n");
  for (const mode of plan.modes) {
    const agent = policy.ai.agents[MODES[mode].policyAgent];
    output.write(`    - ${MODES[mode].label}: ${agent.provider} / ${agent.model} / ${agent.effort} effort\n`);
  }
  output.write("  Files:\n");
  for (const file of plan.files) output.write(`    - ${file.path}\n`);
  output.write(`  Variables: ${plan.variables.map((item) => item.name).join(", ")}\n`);
  output.write("  Secrets entered later through GitHub CLI (not shown or stored here):\n");
  for (const secret of plan.secrets) output.write(`    - ${secret.name}: ${SECRET_PURPOSES[secret.name]}\n`);
  output.write("  Automation remains disabled and the setup PR will not be merged.\n");
  if (plan.modes.includes("review")) {
    output.write("  After merge, PR events intentionally show a failed Codekeeper review gate while disabled. Do not make that gate required until the controlled review proof passes.\n");
  }
}

function printCompletion(plan, receipt, output) {
  output.write(`\nCreated disabled setup PR: ${receipt.pullRequestUrl}\n`);
  output.write(`Pinned source: ${plan.source.repository}@${plan.source.commit}\n`);
  output.write("\nDocument map\n");
  for (const item of documentMap(plan.files)) output.write(`  - ${item.path}: ${item.purpose}\n`);
  output.write("\nNext proofs after the setup PR merges: keep CODEKEEPER_ENABLED=false until ready, deliberately set it true for one bounded proof, then restore it to false.\n");
  for (const item of workflowMap(plan.modes)) {
    const proof = item.mode === "maintain"
      ? "manual workflow_dispatch with dry_run=true"
      : item.mode === "review"
        ? "controlled same-repository pull request"
        : item.mode === "issues"
          ? "controlled issue event"
          : "owner-authorized command only after issue implementation is deliberately enabled";
    output.write(`  - ${item.mode}: ${proof}\n`);
  }
  if (plan.modes.includes("review")) output.write("Do not make the Codekeeper review gate required until its controlled review proof passes.\n");
  output.write("The installer did not enable Codekeeper, dispatch a workflow, or merge the PR.\n");
}

export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  input = stdin,
  output = stdout,
  errorOutput = stderr,
  runner = createCommandRunner(),
  prompt = createTerminalPrompter({ input, output }),
  interactive = input.isTTY === true && output.isTTY === true,
  platform = process.platform,
  openUrl = (url) => bestEffortOpen(url, { runner, platform }),
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

  try {
    const bundle = await loadAssets();
    const snapshot = await inspect({ runner, cwd, interactive });
    const setupAnswers = await collectSetupAnswers({ prompt, snapshot, bundle, output });
    const registrationUrl = appRegistrationUrl({ repository: snapshot.repository, displayName: setupAnswers.displayName });
    output.write(`\nUse an adopter-owned GitHub App installed only on ${snapshot.repository}. The link creates one with the required permissions; if your test App is already installed here, close the page and use that App instead.\n${registrationUrl}\n`);
    try {
      await openUrl(registrationUrl);
    } catch {
      // Opening the browser is best-effort; the printed URL is always authoritative.
    }
    const appReady = await prompt.confirm({
      message: "Have you chosen or created the App, installed it on this repository, and downloaded its private key?",
      defaultValue: false
    });
    if (!appReady) {
      throw new InstallerError("Complete GitHub App creation and installation, then rerun init.", {
        code: "APP_SETUP_ABORTED",
        resume: resumeCommand
      });
    }
    const appAnswers = await collectAppAnswers({ prompt, modes: setupAnswers.modes, output });
    const plan = buildInstallPlan({
      bundle,
      snapshot,
      answers: { ...setupAnswers, ...appAnswers }
    });
    preview(plan, output);
    const confirmed = await prompt.confirm({ message: "Create this disabled setup?", defaultValue: false });
    if (!confirmed) throw new InstallerError("Setup was cancelled before repository mutation.", { code: "USER_CANCELLED" });

    const beforeSettings = await inspect({ runner, cwd: snapshot.root, interactive });
    assertSameSnapshot(snapshot, beforeSettings, resumeCommand);
    await configureRepositorySettings(plan, { runner, output, resumeCommand });
    const beforeGit = await inspect({ runner, cwd: snapshot.root, interactive });
    assertSameSnapshot(snapshot, beforeGit, resumeCommand);
    const receipt = await installPlan(plan, { runner, resumeCommand, platform });
    printCompletion(plan, receipt, output);
    return 0;
  } catch (error) {
    errorOutput.write(`${formatInstallerError(error)}\n`);
    return error?.code === "CLI_USAGE" ? 2 : 1;
  }
}
