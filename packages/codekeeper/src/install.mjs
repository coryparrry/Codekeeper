import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNoInstallationFiles } from "./preflight.mjs";
import { openSafeStdinFile, requireSuccess } from "./command-runner.mjs";
import { InstallerError } from "./errors.mjs";
import { sha256 } from "./assets.mjs";
import { formatCommand } from "./shell-command.mjs";
import { APP_SECRET, SECRET_PURPOSES } from "./constants.mjs";

const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/;

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

async function runMutation(runner, command, args, options, message, resume) {
  let result;
  try {
    result = await runner.run(command, args, options);
  } catch (cause) {
    throw new InstallerError(message, { code: "EXTERNAL_MUTATION_FAILED", resume, cause });
  }
  if (result.status !== 0 || result.timedOut || result.truncated) {
    throw new InstallerError(message, { code: "EXTERNAL_MUTATION_FAILED", resume });
  }
  return result.stdout.trim();
}

function reportProgress(onProgress, id, status, detail) {
  if (typeof onProgress !== "function") return;
  onProgress(Object.freeze({ id, status, ...(detail ? { detail } : {}) }));
}

export async function configureRepositorySettings(plan, {
  runner,
  output,
  appPrivateKeyPath,
  openInputFile = openSafeStdinFile,
  onProgress,
  withSecretInput = null,
  withInteractiveTerminal = (callback) => callback(),
  resumeCommand = "codekeeper init"
}) {
  const enabledVariable = plan.variables.find((variable) => variable.name === "CODEKEEPER_ENABLED");
  const remainingVariables = plan.variables.filter((variable) => variable.name !== "CODEKEEPER_ENABLED");
  if (enabledVariable && !["true", "false"].includes(enabledVariable.value)) {
    throw new InstallerError("Install plan must choose whether Codekeeper starts after merge.", { code: "PLAN_INVALID" });
  }
  const appSecretCount = plan.secrets.filter((secret) => secret.name === APP_SECRET).length;
  if (appSecretCount > 1 || (!plan.update && appSecretCount !== 1)) {
    throw new InstallerError("Install plan has an invalid GitHub App private-key secret count.", { code: "PLAN_INVALID" });
  }

  const appInput = appSecretCount === 1 ? openInputFile(appPrivateKeyPath) : null;
  if (appInput && (!Number.isInteger(appInput.descriptor) || appInput.descriptor < 3 || typeof appInput.close !== "function")) {
    throw new InstallerError("The installer failed to prepare the selected private-key input safely.", {
      code: "SECRET_INPUT_FILE_INVALID"
    });
  }

  try {
    reportProgress(onProgress, "settings:disable", "active");
    if (enabledVariable) {
      await runMutation(
        runner,
        "gh",
        ["variable", "set", enabledVariable.name, "--body", enabledVariable.value, "--repo", plan.repository],
        { cwd: plan.root },
        "GitHub CLI failed to set the Codekeeper startup state. No secrets or files changed.",
        resumeCommand
      );
    }
    reportProgress(onProgress, "settings:disable", "done");

    if (plan.secrets.length) {
      output.write("\nRequired GitHub Actions secrets\n");
      output.write("Setup does not call a model. API keys go directly from this terminal to GitHub CLI. Codekeeper does not display or store them.\n");
      output.write("The selected App key file goes directly to GitHub CLI. Codekeeper does not read or display the key.\n");
      for (const secret of plan.secrets) output.write(`  - ${secret.name}: ${SECRET_PURPOSES[secret.name]}\n`);
    }

    let providerProgressStarted = false;
    let providerProgressFinished = false;
    for (const secret of plan.secrets) {
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
          { cwd: plan.root, stdio: "ignore", stdinFd: appInput.descriptor, timeoutMs: null },
          `GitHub CLI did not set ${secret.name}.`,
          resumeCommand
        );
        reportProgress(onProgress, "secret:app", "done");
        output.write(`Set ${APP_SECRET} from the selected PEM file.\n`);
        continue;
      }
      providerProgressStarted = true;
      reportProgress(onProgress, "secret:provider", "active", `${secret.name} — ${SECRET_PURPOSES[secret.name]}`);
      if (typeof withSecretInput === "function") {
        await runMutation(
          runner,
          "gh",
          ["secret", "set", secret.name, "--app", "actions", "--repo", plan.repository],
          {
            cwd: plan.root,
            stdio: "ignore",
            timeoutMs: null,
            provideInput: (write) => withSecretInput({
              step: "credential",
              name: secret.name,
              purpose: SECRET_PURPOSES[secret.name],
              write
            })
          },
          `GitHub CLI did not set ${secret.name}.`,
          resumeCommand
        );
      } else {
        output.write(`\nEnter ${secret.name} in the GitHub CLI prompt. Press Ctrl-D when you finish.\n`);
        await withInteractiveTerminal(
          () => runMutation(
            runner,
            "gh",
            ["secret", "set", secret.name, "--app", "actions", "--repo", plan.repository],
            { cwd: plan.root, stdio: "inherit", timeoutMs: null },
            `GitHub CLI did not set ${secret.name}.`,
            resumeCommand
          ),
          Object.freeze({ name: secret.name, purpose: SECRET_PURPOSES[secret.name] })
        );
      }
    }
    if (providerProgressStarted && !providerProgressFinished) reportProgress(onProgress, "secret:provider", "done");

    reportProgress(onProgress, "variables:configure", "active");
    for (const variable of remainingVariables) {
      await runMutation(
        runner,
        "gh",
        ["variable", "set", variable.name, "--body", variable.value, "--repo", plan.repository],
        { cwd: plan.root },
        `GitHub CLI did not set ${variable.name}.`,
        resumeCommand
      );
    }
    reportProgress(onProgress, "variables:configure", "done");
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
  platform = process.platform
}) {
  const paths = plan.files.map((file) => file.path);
  reportProgress(onProgress, "git:commit", "active");
  await runMutation(
    runner,
    "git",
    ["switch", "-c", plan.branch],
    { cwd: plan.root },
    `Could not create ${plan.branch}.`,
    resumeCommand
  );

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
      throw cause;
    }
    throw new InstallerError("Could not create the setup commit.", {
      code: "LOCAL_SETUP_FAILED",
      resume: rolledBack ? resumeCommand : statusCommand(platform),
      cause
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
    reportProgress(onProgress, "git:commit", "done");
    return commit;
  } catch (error) {
    if (error instanceof InstallerError && !error.resume) {
      error.resume = formatCommand("git", ["show", "--stat", "--oneline", "HEAD"], platform);
    }
    throw error;
  }
}

function remoteInspectionResume(plan, platform, pullRequestUrl = null) {
  const commands = [formatCommand("git", ["ls-remote", "--refs", "origin", `refs/heads/${plan.branch}`], platform)];
  if (pullRequestUrl) commands.push(`Then inspect: ${formatCommand("gh", ["pr", "view", pullRequestUrl], platform)}`);
  return commands.join("\n");
}

async function assertRemoteSetupCommit(plan, commit, runner, platform, pullRequestUrl = null) {
  const remoteResult = await runner.run(
    "git",
    ["ls-remote", "--refs", "origin", `refs/heads/${plan.branch}`],
    { cwd: plan.root }
  );
  if (remoteResult.status !== 0 || remoteResult.timedOut || remoteResult.truncated) {
    throw new InstallerError(
      pullRequestUrl
        ? "The setup pull request can exist. The installer failed to verify its remote branch."
        : "The setup branch can exist on the remote. The installer failed to verify its remote commit.",
      {
        code: "REMOTE_COMMIT_READ_FAILED",
        resume: remoteInspectionResume(plan, platform, pullRequestUrl)
      }
    );
  }
  const remote = remoteResult.stdout.trim();
  const fields = remote.trim().split(/\s+/);
  if (fields.length !== 2 || fields[0] !== commit || fields[1] !== `refs/heads/${plan.branch}`) {
    throw new InstallerError("The remote setup branch does not match the verified setup commit.", {
      code: "REMOTE_COMMIT_MISMATCH",
      resume: remoteInspectionResume(plan, platform, pullRequestUrl)
    });
  }
}

export async function pushAndOpenSetupPullRequest(plan, commit, { runner, onProgress, platform = process.platform }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new InstallerError("Verified setup commit is not a full Git commit SHA.", { code: "COMMIT_SHA_INVALID" });
  }
  reportProgress(onProgress, "git:push", "active");
  await runMutation(
    runner,
    "git",
    ["push", "origin", `${commit}:refs/heads/${plan.branch}`],
    { cwd: plan.root },
    "The setup commit was created locally, but the push failed.",
    `${pushCommand(plan, commit, platform)}\nThen: ${pullRequestCreateCommand(plan, platform)}`
  );
  await assertRemoteSetupCommit(plan, commit, runner, platform);
  reportProgress(onProgress, "git:push", "done");

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
    `${pullRequestListCommand(plan, platform)}\nIf no pull request is listed: ${pullRequestCreateCommand(plan, platform)}`
  );
  if (!PR_URL.test(url)) {
    throw new InstallerError("GitHub CLI returned an invalid setup pull-request URL.", {
      code: "PR_URL_INVALID",
      resume: `${pullRequestListCommand(plan, platform)}\nIf no pull request is listed: ${pullRequestCreateCommand(plan, platform)}`
    });
  }
  await assertRemoteSetupCommit(plan, commit, runner, platform, url);
  reportProgress(onProgress, "github:pull-request", "done");
  return url;
}

export async function installPlan(plan, dependencies) {
  const commit = await createSetupCommit(plan, dependencies);
  const pullRequestUrl = await pushAndOpenSetupPullRequest(plan, commit, dependencies);
  return Object.freeze({ branch: plan.branch, commit, pullRequestUrl });
}
