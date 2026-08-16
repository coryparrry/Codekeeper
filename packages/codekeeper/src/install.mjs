import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNoInstallationFiles } from "./preflight.mjs";
import { openSafeStdinFile, requireSuccess } from "./command-runner.mjs";
import { freezeInstallerReceipt, InstallerError } from "./errors.mjs";
import { sha256 } from "./assets.mjs";
import { formatCommand } from "./shell-command.mjs";
import { APP_SECRET, SECRET_PURPOSES } from "./constants.mjs";

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/;
export const SECRET_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

async function maybeLstat(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRelativeTarget(relativePath) {
  if (typeof relativePath !== "string" || path.posix.isAbsolute(relativePath)) {
    throw new InstallerError("Generated file path is not repository-relative.", { code: "PLAN_INVALID" });
  }
  const parts = relativePath.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    throw new InstallerError("Generated file path is unsafe.", { code: "PLAN_INVALID" });
  }
  return parts;
}

async function ensureSafeParents(fsImpl, root, relativePath, { allowExisting = false } = {}) {
  const parts = assertRelativeTarget(relativePath);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat = await maybeLstat(fsImpl, current);
    if (!stat) {
      await fsImpl.mkdir(current);
      stat = await maybeLstat(fsImpl, current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new InstallerError(`Generated path parent is not a regular directory: ${part}`, { code: "PATH_COLLISION" });
    }
  }
  const target = path.join(root, ...parts);
  const targetStat = await maybeLstat(fsImpl, target);
  if (targetStat && (!allowExisting || !targetStat.isFile() || targetStat.isSymbolicLink())) {
    throw new InstallerError(`Generated path already exists or is unsafe: ${relativePath}`, { code: "PATH_COLLISION" });
  }
  return target;
}

function exactPathSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new InstallerError(`${label} contains paths outside the generated setup.`, { code: "UNRELATED_PATH" });
  }
}

function pullRequestCreateCommand(plan, platform) {
  return formatCommand("gh", [
    "pr", "create",
    "--repo", plan.repository,
    "--base", plan.defaultBranch,
    "--head", plan.branch,
    "--title", plan.pullRequest.title,
    "--body", plan.pullRequest.body
  ], platform);
}

function pullRequestListCommand(plan, platform) {
  return formatCommand("gh", ["pr", "list", "--repo", plan.repository, "--state", "open", "--head", plan.branch], platform);
}

function pushCommand(plan, commit, platform) {
  return formatCommand("git", ["push", "origin", `${commit}:refs/heads/${plan.branch}`], platform);
}

function statusCommand(platform) {
  return formatCommand("git", ["status", "--short"], platform);
}

async function rollbackPreCommit(plan, { runner, fsImpl }) {
  const paths = plan.files.map((file) => file.path);
  const head = await runner.run("git", ["rev-parse", "HEAD"], { cwd: plan.root });
  if (head.status !== 0 || head.timedOut || head.truncated || head.stdout.trim() !== plan.originalHead) return false;

  for (const file of plan.files) {
    const target = path.join(plan.root, ...assertRelativeTarget(file.path));
    const stat = await maybeLstat(fsImpl, target);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const contents = await fsImpl.readFile(target);
    const digest = sha256(contents);
    if (plan.update) {
      if (![file.sha256, file.previousSha256].includes(digest)) return false;
    } else if (contents.byteLength !== file.bytes || digest !== file.sha256) return false;
  }

  if (plan.update) {
    const existingPaths = plan.files.filter((file) => file.previousSha256 !== null).map((file) => file.path);
    const newFiles = plan.files.filter((file) => file.previousSha256 === null);
    if (existingPaths.length) {
      const reset = await runner.run("git", ["reset", "--quiet", "HEAD", "--", ...existingPaths], { cwd: plan.root });
      if (reset.status !== 0 || reset.timedOut || reset.truncated) return false;
      const restored = await runner.run("git", ["restore", "--worktree", "--source=HEAD", "--", ...existingPaths], { cwd: plan.root });
      if (restored.status !== 0 || restored.timedOut || restored.truncated) return false;
    }
    for (const file of newFiles) {
      const target = path.join(plan.root, ...assertRelativeTarget(file.path));
      if (await maybeLstat(fsImpl, target)) await fsImpl.unlink(target);
    }
    const status = await runner.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: plan.root });
    if (status.status !== 0 || status.timedOut || status.truncated || status.stdout) return false;
    const switched = await runner.run("git", ["switch", plan.defaultBranch], { cwd: plan.root });
    if (switched.status !== 0 || switched.timedOut || switched.truncated) return false;
    const deleted = await runner.run("git", ["branch", "-d", plan.branch], { cwd: plan.root });
    return deleted.status === 0 && !deleted.timedOut && !deleted.truncated;
  }

  const reset = await runner.run("git", ["reset", "--quiet", "HEAD", "--", ...paths], { cwd: plan.root });
  if (reset.status !== 0 || reset.timedOut || reset.truncated) return false;
  for (const file of plan.files) {
    const target = path.join(plan.root, ...assertRelativeTarget(file.path));
    if (await maybeLstat(fsImpl, target)) await fsImpl.unlink(target);
  }
  const status = await runner.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: plan.root });
  if (status.status !== 0 || status.timedOut || status.truncated || status.stdout) return false;
  const switched = await runner.run("git", ["switch", plan.defaultBranch], { cwd: plan.root });
  if (switched.status !== 0 || switched.timedOut || switched.truncated) return false;
  const deleted = await runner.run("git", ["branch", "-d", plan.branch], { cwd: plan.root });
  return deleted.status === 0 && !deleted.timedOut && !deleted.truncated;
}

function defaultOperation(plan) {
  return typeof plan.operation === "string" && plan.operation
    ? plan.operation
    : plan.settingsOnly ? "settings" : "setup";
}

function createReceiptTracker(plan) {
  const secretNames = [...new Set((plan.secrets ?? []).map((secret) => secret.name).filter((name) => typeof name === "string"))];
  const variableNames = [...new Set((plan.variables ?? []).map((variable) => variable.name).filter((name) => typeof name === "string"))];
  const state = {
    operation: defaultOperation(plan),
    branch: typeof plan.branch === "string" ? plan.branch : null,
    originalHead: typeof plan.originalHead === "string" ? plan.originalHead : null,
    localSha: null,
    remoteSha: null,
    completedSecrets: [],
    pendingSecrets: secretNames,
    completedVariables: [],
    pendingVariables: variableNames,
    startupState: variableNames.includes("CODEKEEPER_ENABLED") ? "pending" : "unchanged",
    pullRequestUrl: null,
    phase: "pending",
    unknownMutation: false,
    settingsOnly: plan.settingsOnly === true,
    status: "in-progress"
  };

  const tracker = {
    set(patch = {}) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === "completedSecrets" || key === "pendingSecrets" || key === "completedVariables" || key === "pendingVariables") {
          if (Array.isArray(value)) state[key] = [...new Set(value.filter((item) => typeof item === "string"))];
        } else if (key === "unknownMutation" || key === "settingsOnly") {
          if (typeof value === "boolean") state[key] = value;
        } else if (Object.hasOwn(state, key) && (value === null || typeof value === "string")) {
          state[key] = value;
        }
      }
      return tracker;
    },
    addSecret(name) {
      if (!state.completedSecrets.includes(name)) state.completedSecrets.push(name);
      state.pendingSecrets = state.pendingSecrets.filter((item) => item !== name);
      return tracker;
    },
    addVariable(name) {
      if (!state.completedVariables.includes(name)) state.completedVariables.push(name);
      state.pendingVariables = state.pendingVariables.filter((item) => item !== name);
      return tracker;
    },
    markUnknown() {
      state.unknownMutation = true;
      return tracker;
    },
    snapshot(overrides = {}) {
      return freezeInstallerReceipt({ ...state, ...overrides });
    },
    fail(overrides = {}) {
      state.status = "failed";
      return tracker.snapshot(overrides);
    },
    complete(overrides = {}) {
      state.status = "complete";
      return tracker.snapshot(overrides);
    }
  };
  return tracker;
}

function trackerFor(plan, receiptTracker = null) {
  return receiptTracker && typeof receiptTracker.snapshot === "function"
    ? receiptTracker
    : createReceiptTracker(plan);
}

function attachReceipt(error, tracker, overrides = {}) {
  if (!(error instanceof InstallerError) || !tracker) return error;
  error.receipt = tracker.fail(overrides);
  return error;
}

function mutationCouldBeUnknown(result) {
  return Boolean(result?.timedOut || result?.signal || result?.truncated);
}

function thrownMutationCouldBeUnknown(error) {
  return !(error instanceof InstallerError && error.code === "COMMAND_START_FAILED");
}

async function runMutation(runner, command, args, options, message, resume, {
  tracker = null,
  phase = null,
  ambiguousOnFailure = false
} = {}) {
  tracker?.set(phase ? { phase } : {});
  let result;
  try {
    result = await runner.run(command, args, options);
  } catch (cause) {
    if (tracker && (thrownMutationCouldBeUnknown(cause) || ambiguousOnFailure)) tracker.markUnknown();
    throw new InstallerError(message, {
      code: "EXTERNAL_MUTATION_FAILED",
      resume,
      cause,
      receipt: tracker?.fail()
    });
  }
  if (result.status !== 0 || result.timedOut || result.truncated) {
    if (tracker && (mutationCouldBeUnknown(result) || ambiguousOnFailure)) tracker.markUnknown();
    throw new InstallerError(message, {
      code: "EXTERNAL_MUTATION_FAILED",
      resume,
      receipt: tracker?.fail()
    });
  }
  return result.stdout.trim();
}

function reportProgress(onProgress, id, status, detail) {
  if (typeof onProgress !== "function") return;
  onProgress(Object.freeze({ id, status, ...(detail ? { detail } : {}) }));
}

export async function configureRepositorySettings(plan, {
  runner,
  output = { write() {} },
  appPrivateKeyPath,
  openInputFile = openSafeStdinFile,
  onProgress,
  withSecretInput = null,
  withInteractiveTerminal = (callback) => callback(),
  resumeCommand = "codekeeper init",
  receiptTracker = null
}) {
  const tracker = trackerFor(plan, receiptTracker);
  const ownsTracker = !receiptTracker;
  const variables = Array.isArray(plan.variables) ? plan.variables : [];
  const secrets = Array.isArray(plan.secrets) ? plan.secrets : [];
  const enabledVariable = variables.find((variable) => variable.name === "CODEKEEPER_ENABLED");
  const remainingVariables = variables.filter((variable) => variable.name !== "CODEKEEPER_ENABLED");
  let appInput = null;
  try {
    tracker.set({ phase: "settings:validate" });
    if (enabledVariable && !["true", "false"].includes(enabledVariable.value)) {
      throw new InstallerError("Install plan must choose whether Codekeeper starts after merge.", { code: "PLAN_INVALID" });
    }
    const appSecretCount = secrets.filter((secret) => secret.name === APP_SECRET).length;
    if (appSecretCount > 1 || (!plan.update && appSecretCount !== 1)) {
      throw new InstallerError("Install plan has an invalid GitHub App private-key secret count.", { code: "PLAN_INVALID" });
    }

    if (appSecretCount === 1) appInput = openInputFile(appPrivateKeyPath);
    if (appInput && (!Number.isInteger(appInput.descriptor) || appInput.descriptor < 3 || typeof appInput.close !== "function")) {
      throw new InstallerError("The installer failed to prepare the selected private-key input safely.", {
        code: "SECRET_INPUT_FILE_INVALID"
      });
    }

    tracker.set({ phase: "settings:secrets" });
    if (secrets.length) {
      output.write("\nRequired GitHub Actions secrets\n");
      output.write("Setup does not call a model. API keys go directly from this terminal to GitHub CLI. Codekeeper does not display or store them.\n");
      output.write("The selected App key file goes directly to GitHub CLI. Codekeeper does not read or display the key.\n");
      for (const secret of secrets) output.write(`  - ${secret.name}: ${secret.purpose ?? SECRET_PURPOSES[secret.name]}\n`);
    }

    let providerProgressStarted = false;
    let providerProgressFinished = false;
    for (const secret of secrets) {
      if (secret.name === APP_SECRET) {
        if (providerProgressStarted && !providerProgressFinished) {
          reportProgress(onProgress, "secret:provider", "done");
          providerProgressFinished = true;
        }
        reportProgress(onProgress, "secret:app", "active", `${APP_SECRET} — ${SECRET_PURPOSES[APP_SECRET]}`);
        output.write(`\nSetting ${APP_SECRET} from the selected .pem file. This replaces a secret with the same name.\n`);
        await runMutation(
          runner,
          "gh",
          ["secret", "set", secret.name, "--app", "actions", "--repo", plan.repository],
          {
            cwd: plan.root,
            stdio: "ignore",
            stdinFd: appInput.descriptor,
            timeoutMs: SECRET_UPLOAD_TIMEOUT_MS
          },
          `GitHub CLI did not set ${secret.name}.`,
          resumeCommand,
          { tracker, phase: "settings:secrets" }
        );
        tracker.addSecret(secret.name);
        reportProgress(onProgress, "secret:app", "done");
        output.write(`Set ${APP_SECRET} from the selected PEM file.\n`);
        continue;
      }
      providerProgressStarted = true;
      const purpose = secret.purpose ?? SECRET_PURPOSES[secret.name];
      reportProgress(onProgress, "secret:provider", "active", `${secret.name} — ${purpose}`);
      if (typeof withSecretInput === "function") {
        await runMutation(
          runner,
          "gh",
          ["secret", "set", secret.name, "--app", "actions", "--repo", plan.repository],
          {
            cwd: plan.root,
            stdio: "ignore",
            timeoutMs: SECRET_UPLOAD_TIMEOUT_MS,
            provideInput: (write) => withSecretInput({
              step: "credential",
              name: secret.name,
              purpose,
              write
            })
          },
          `GitHub CLI did not set ${secret.name}.`,
          resumeCommand,
          { tracker, phase: "settings:secrets" }
        );
      } else {
        output.write(`\nEnter ${secret.name} in the GitHub CLI prompt. Press Ctrl-D when you finish.\n`);
        await withInteractiveTerminal(
          () => runMutation(
            runner,
            "gh",
            ["secret", "set", secret.name, "--app", "actions", "--repo", plan.repository],
            { cwd: plan.root, stdio: "inherit", timeoutMs: SECRET_UPLOAD_TIMEOUT_MS },
            `GitHub CLI did not set ${secret.name}.`,
            resumeCommand,
            { tracker, phase: "settings:secrets" }
          ),
          Object.freeze({ name: secret.name, purpose })
        );
      }
      tracker.addSecret(secret.name);
    }
    if (providerProgressStarted && !providerProgressFinished) reportProgress(onProgress, "secret:provider", "done");

    tracker.set({ phase: "settings:variables" });
    reportProgress(onProgress, "variables:configure", "active");
    for (const variable of remainingVariables) {
      await runMutation(
        runner,
        "gh",
        ["variable", "set", variable.name, "--body", variable.value, "--repo", plan.repository],
        { cwd: plan.root },
        `GitHub CLI did not set ${variable.name}.`,
        resumeCommand,
        { tracker, phase: "settings:variables" }
      );
      tracker.addVariable(variable.name);
    }
    reportProgress(onProgress, "variables:configure", "done");

    // Keep the startup variable last. A repository may have files and
    // credentials ready before Codekeeper is allowed to start consuming them.
    tracker.set({ phase: "settings:startup" });
    reportProgress(onProgress, "settings:disable", "active");
    if (enabledVariable) {
      await runMutation(
        runner,
        "gh",
        ["variable", "set", enabledVariable.name, "--body", enabledVariable.value, "--repo", plan.repository],
        { cwd: plan.root },
        "GitHub CLI failed to set the Codekeeper startup state. Secrets and non-startup variables may already be configured.",
        resumeCommand,
        { tracker, phase: "settings:startup" }
      );
      tracker.addVariable(enabledVariable.name);
      tracker.set({ startupState: enabledVariable.value === "true" ? "enabled" : "disabled" });
    } else {
      tracker.set({ startupState: "unchanged" });
    }
    reportProgress(onProgress, "settings:disable", "done");

    tracker.set({ phase: "settings:complete" });
    return ownsTracker ? tracker.complete() : tracker.snapshot();
  } catch (error) {
    if (error instanceof InstallerError) {
      error.receipt = error.receipt ?? tracker.fail();
      if (!error.receipt) error.receipt = tracker.fail();
      throw error;
    }
    throw new InstallerError("Could not configure repository settings.", {
      code: "SETTINGS_FAILED",
      resume: resumeCommand,
      cause: error,
      receipt: tracker.fail()
    });
  } finally {
    try {
      appInput?.close();
    } catch {
      // The descriptor is process-local and contains no buffered secret bytes.
    }
  }
}

export async function createSetupCommit(plan, {
  runner,
  fsImpl = { lstat, mkdir, readFile, readdir, unlink, writeFile },
  onProgress,
  resumeCommand = "codekeeper init",
  platform = process.platform,
  receiptTracker = null
}) {
  const tracker = trackerFor(plan, receiptTracker);
  const paths = plan.files.map((file) => file.path);
  tracker.set({ phase: "local-commit" });
  reportProgress(onProgress, "git:commit", "active");
  try {
    await runMutation(
      runner,
      "git",
      ["switch", "-c", plan.branch],
      { cwd: plan.root },
      `Could not create ${plan.branch}.`,
      resumeCommand,
      { tracker, phase: "local-commit" }
    );
  } catch (error) {
    throw attachReceipt(error, tracker);
  }

  try {
    await assertNoInstallationFiles(plan.root, { fsImpl, allowExisting: plan.update === true });
    for (const file of plan.files) {
      const target = await ensureSafeParents(fsImpl, plan.root, file.path, { allowExisting: plan.update === true });
      if (plan.update) {
        const stat = await maybeLstat(fsImpl, target);
        if (file.previousSha256 === null ? stat !== null : !stat || sha256(await fsImpl.readFile(target)) !== file.previousSha256) {
          throw new InstallerError(`The current file changed before the update: ${file.path}`, { code: "EXISTING_INSTALLATION_CHANGED" });
        }
      }
      if (file.delete === true) {
        await fsImpl.unlink(target);
        continue;
      }
      await fsImpl.writeFile(target, file.contents, { flag: !plan.update || file.previousSha256 === null ? "wx" : "w", mode: 0o644 });
      const written = await fsImpl.readFile(target);
      if (written.byteLength !== file.bytes || sha256(written) !== file.sha256) {
        throw new InstallerError(`Generated file verification failed: ${file.path}`, { code: "GENERATED_FILE_MISMATCH" });
      }
    }
    await requireSuccess(runner, "git", ["diff", "--check", "--", ...paths], { cwd: plan.root }, "Generated files fail git diff --check.");
    await requireSuccess(runner, "git", ["add", "--", ...paths], { cwd: plan.root }, "Could not stage generated files.");
    const staged = await requireSuccess(
      runner,
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      { cwd: plan.root },
      "Could not inspect staged paths."
    );
    exactPathSet(staged.split("\0").filter(Boolean), paths, "Git index");
    await requireSuccess(runner, "git", ["diff", "--cached", "--check"], { cwd: plan.root }, "Staged setup fails git diff --check.");
    await requireSuccess(
      runner,
      "git",
      ["commit", "--only", "-m", plan.commitMessage, "--", ...paths],
      { cwd: plan.root },
      "Could not commit the setup."
    );
  } catch (cause) {
    let rolledBack = false;
    try {
      rolledBack = await rollbackPreCommit(plan, { runner, fsImpl });
    } catch {
      rolledBack = false;
    }
    if (cause instanceof InstallerError) {
      cause.resume = rolledBack ? resumeCommand : statusCommand(platform);
      cause.receipt = tracker.fail();
      throw cause;
    }
    throw new InstallerError("Could not create the setup commit.", {
      code: "LOCAL_SETUP_FAILED",
      resume: rolledBack ? resumeCommand : statusCommand(platform),
      cause,
      receipt: tracker.fail()
    });
  }

  try {
    const parent = await requireSuccess(runner, "git", ["rev-parse", "HEAD^"], { cwd: plan.root }, "Could not verify setup commit parent.");
    if (parent !== plan.originalHead) {
      throw new InstallerError("Setup commit does not descend directly from the confirmed default-branch head.", {
        code: "COMMIT_PARENT_MISMATCH",
        resume: formatCommand("git", ["show", "--stat", "--oneline", "HEAD"], platform)
      });
    }
    const committed = await requireSuccess(
      runner,
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"],
      { cwd: plan.root },
      "Could not inspect setup commit."
    );
    exactPathSet(committed.split("\0").filter(Boolean), paths, "Setup commit");
    for (const file of plan.files) {
      const blob = await runner.run("git", ["show", `HEAD:${file.path}`], { cwd: plan.root });
      if (file.delete === true) {
        if (blob.status === 0) throw new InstallerError(`The deleted workflow still exists in the setup commit: ${file.path}`, { code: "COMMITTED_FILE_MISMATCH" });
        continue;
      }
      if (blob.status !== 0 || blob.timedOut || blob.truncated) {
        throw new InstallerError(`The installer failed to verify the committed bytes for ${file.path}. Nothing was pushed.`, {
          code: "COMMITTED_FILE_READ_FAILED",
          resume: formatCommand("git", ["show", "--stat", "--oneline", "HEAD"], platform)
        });
      }
      if (Buffer.byteLength(blob.stdout) !== file.bytes || sha256(blob.stdout) !== file.sha256) {
        throw new InstallerError(`The committed bytes changed for ${file.path}. Nothing was pushed.`, {
          code: "COMMITTED_FILE_MISMATCH",
          resume: formatCommand("git", ["show", "--no-ext-diff", "--", file.path], platform)
        });
      }
    }
    const status = await requireSuccess(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: plan.root }, "Could not verify the setup worktree.");
    if (status) {
      throw new InstallerError("The worktree changed while the installer created the setup commit. Nothing was pushed.", {
        code: "WORKTREE_CHANGED",
        resume: statusCommand(platform)
      });
    }
    const commit = await requireSuccess(runner, "git", ["rev-parse", "HEAD"], { cwd: plan.root }, "Could not read the setup commit.");
    tracker.set({ localSha: commit, phase: "local-commit-verified" });
    reportProgress(onProgress, "git:commit", "done");
    return commit;
  } catch (error) {
    if (error instanceof InstallerError && !error.resume) {
      error.resume = formatCommand("git", ["show", "--stat", "--oneline", "HEAD"], platform);
    }
    throw attachReceipt(error, tracker);
  }
}

function remoteInspectionResume(plan, platform, pullRequestUrl = null) {
  const commands = [formatCommand("git", ["ls-remote", "--refs", "origin", `refs/heads/${plan.branch}`], platform)];
  if (pullRequestUrl) commands.push(`Then inspect: ${formatCommand("gh", ["pr", "view", pullRequestUrl], platform)}`);
  return commands.join("\n");
}

async function assertRemoteSetupCommit(plan, commit, runner, platform, pullRequestUrl = null, tracker = null) {
  let remoteResult;
  try {
    remoteResult = await runner.run(
      "git",
      ["ls-remote", "--refs", "origin", `refs/heads/${plan.branch}`],
      { cwd: plan.root }
    );
  } catch (cause) {
    tracker?.markUnknown();
    throw new InstallerError(
      pullRequestUrl
        ? "The setup pull request can exist. The installer failed to verify its remote branch."
        : "The setup branch can exist on the remote. The installer failed to verify its remote commit.",
      {
        code: "REMOTE_COMMIT_READ_FAILED",
        resume: remoteInspectionResume(plan, platform, pullRequestUrl),
        cause,
        receipt: tracker?.fail()
      }
    );
  }
  if (remoteResult.status !== 0 || remoteResult.timedOut || remoteResult.truncated) {
    tracker?.markUnknown();
    throw new InstallerError(
      pullRequestUrl
        ? "The setup pull request can exist. The installer failed to verify its remote branch."
        : "The setup branch can exist on the remote. The installer failed to verify its remote commit.",
      {
        code: "REMOTE_COMMIT_READ_FAILED",
        resume: remoteInspectionResume(plan, platform, pullRequestUrl),
        receipt: tracker?.fail()
      }
    );
  }
  const remote = remoteResult.stdout.trim();
  const fields = remote.trim().split(/\s+/);
  if (fields.length !== 2 || fields[0] !== commit || fields[1] !== `refs/heads/${plan.branch}`) {
    throw new InstallerError("The remote setup branch does not match the verified setup commit.", {
      code: "REMOTE_COMMIT_MISMATCH",
      resume: remoteInspectionResume(plan, platform, pullRequestUrl),
      receipt: tracker?.fail()
    });
  }
  tracker?.set({
    remoteSha: commit,
    phase: pullRequestUrl ? "pull-request-remote-verified" : "push-remote-verified"
  });
}

export async function pushSetupCommit(plan, commit, {
  runner,
  onProgress,
  platform = process.platform,
  receiptTracker = null
} = {}) {
  const tracker = trackerFor(plan, receiptTracker);
  try {
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new InstallerError("Verified setup commit is not a full Git commit SHA.", { code: "COMMIT_SHA_INVALID" });
    }
    tracker.set({ localSha: commit, phase: "push" });
    reportProgress(onProgress, "git:push", "active");
    await runMutation(
      runner,
      "git",
      ["push", "origin", `${commit}:refs/heads/${plan.branch}`],
      { cwd: plan.root },
      "The setup commit was created locally, but the push failed.",
      `${pushCommand(plan, commit, platform)}\nThen: ${pullRequestCreateCommand(plan, platform)}`,
      { tracker, phase: "push", ambiguousOnFailure: true }
    );
    await assertRemoteSetupCommit(plan, commit, runner, platform, null, tracker);
    reportProgress(onProgress, "git:push", "done");
    return Object.freeze({ ...tracker.snapshot(), commit });
  } catch (error) {
    throw attachReceipt(error, tracker);
  }
}

export async function openSetupPullRequest(plan, commit, {
  runner,
  onProgress,
  platform = process.platform,
  receiptTracker = null
} = {}) {
  const tracker = trackerFor(plan, receiptTracker);
  const listResume = `${pullRequestListCommand(plan, platform)}\nIf no pull request is listed: ${pullRequestCreateCommand(plan, platform)}`;
  try {
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new InstallerError("Verified setup commit is not a full Git commit SHA.", { code: "COMMIT_SHA_INVALID" });
    }
    tracker.set({ localSha: commit, phase: "pull-request" });
    reportProgress(onProgress, "github:pull-request", "active");
    const url = await runMutation(
      runner,
      "gh",
      [
        "pr", "create",
        "--repo", plan.repository,
        "--base", plan.defaultBranch,
        "--head", plan.branch,
        "--title", plan.pullRequest.title,
        "--body", plan.pullRequest.body
      ],
      { cwd: plan.root },
      "The setup branch was pushed, but GitHub did not create the pull request.",
      listResume,
      { tracker, phase: "pull-request", ambiguousOnFailure: true }
    );
    if (!PR_URL.test(url)) {
      tracker.markUnknown();
      throw new InstallerError("GitHub CLI returned an invalid setup pull-request URL.", {
        code: "PR_URL_INVALID",
        resume: listResume,
        receipt: tracker.fail()
      });
    }
    tracker.set({ pullRequestUrl: url, phase: "pull-request-created" });
    await assertRemoteSetupCommit(plan, commit, runner, platform, url, tracker);
    reportProgress(onProgress, "github:pull-request", "done");
    return url;
  } catch (error) {
    throw attachReceipt(error, tracker);
  }
}

// Kept for callers that used the original one-shot publication API. New code
// should call the two phases separately so settings can be applied between a
// verified push and pull-request creation.
export async function pushAndOpenSetupPullRequest(plan, commit, dependencies = {}) {
  const tracker = trackerFor(plan, dependencies.receiptTracker ?? null);
  try {
    await pushSetupCommit(plan, commit, { ...dependencies, receiptTracker: tracker });
    return await openSetupPullRequest(plan, commit, { ...dependencies, receiptTracker: tracker });
  } catch (error) {
    throw attachReceipt(error, tracker);
  }
}

export async function installPlan(plan, dependencies = {}) {
  const tracker = createReceiptTracker(plan);
  try {
    if (plan.settingsOnly) {
      await configureRepositorySettings(plan, { ...dependencies, receiptTracker: tracker });
      tracker.set({ pullRequestUrl: "No pull request was needed.", phase: "complete" });
      return tracker.complete({ phase: "complete" });
    }

    const commit = await createSetupCommit(plan, { ...dependencies, receiptTracker: tracker });
    tracker.set({ localSha: commit, phase: "local-commit-verified" });
    await pushSetupCommit(plan, commit, { ...dependencies, receiptTracker: tracker });
    await configureRepositorySettings(plan, { ...dependencies, receiptTracker: tracker });
    const pullRequestUrl = await openSetupPullRequest(plan, commit, { ...dependencies, receiptTracker: tracker });
    tracker.set({ localSha: commit, remoteSha: commit, pullRequestUrl, phase: "complete" });
    return Object.freeze({
      ...tracker.complete({ phase: "complete" }),
      branch: plan.branch,
      commit,
      pullRequestUrl
    });
  } catch (error) {
    throw attachReceipt(error, tracker);
  }
}
