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

async function ensureSafeParents(fsImpl, root, relativePath) {
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
  if (await maybeLstat(fsImpl, target)) {
    throw new InstallerError(`Generated path already exists: ${relativePath}`, { code: "PATH_COLLISION" });
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
    if (contents.byteLength !== file.bytes || sha256(contents) !== file.sha256) return false;
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

export async function configureRepositorySettings(plan, {
  runner,
  output,
  appPrivateKeyPath,
  openInputFile = openSafeStdinFile,
  resumeCommand = "codekeeper init"
}) {
  const [enabledVariable, ...remainingVariables] = plan.variables;
  if (enabledVariable?.name !== "CODEKEEPER_ENABLED" || enabledVariable.value !== "false") {
    throw new InstallerError("Install plan does not force Codekeeper into the disabled state.", { code: "PLAN_INVALID" });
  }
  if (plan.secrets.filter((secret) => secret.name === APP_SECRET).length !== 1) {
    throw new InstallerError("Install plan must contain exactly one GitHub App private-key secret.", { code: "PLAN_INVALID" });
  }

  const appInput = openInputFile(appPrivateKeyPath);
  if (!Number.isInteger(appInput?.descriptor) || appInput.descriptor < 3 || typeof appInput.close !== "function") {
    throw new InstallerError("The selected private-key input could not be prepared safely.", {
      code: "SECRET_INPUT_FILE_INVALID"
    });
  }

  try {
    await runMutation(
      runner,
      "gh",
      ["variable", "set", enabledVariable.name, "--body", enabledVariable.value, "--repo", plan.repository],
      { cwd: plan.root },
      "GitHub CLI could not force CODEKEEPER_ENABLED=false; no secret or file mutation was attempted.",
      resumeCommand
    );

    output.write("\nRequired GitHub Actions secrets\n");
    output.write("Setup makes no model call. Provider and trace values go directly from the terminal to GitHub CLI. The App PEM is supplied to GitHub CLI from its opened file descriptor; the installer never reads or displays its contents. GitHub Actions supplies the stored secrets later only to selected jobs.\n");
    for (const secret of plan.secrets) output.write(`  - ${secret.name}: ${SECRET_PURPOSES[secret.name]}\n`);

    for (const secret of plan.secrets) {
      if (secret.name === APP_SECRET) {
        output.write(`\nSetting ${APP_SECRET} from the selected PEM file through non-terminal GitHub CLI input. Its path and contents are not displayed. If the secret already exists, this deliberately replaces it.\n`);
        await runMutation(
          runner,
          "gh",
          ["secret", "set", secret.name, "--app", "actions", "--repo", plan.repository],
          { cwd: plan.root, stdio: "ignore", stdinFd: appInput.descriptor, timeoutMs: null },
          `GitHub CLI did not set ${secret.name}. Automation remains disabled.`,
          resumeCommand
        );
        output.write(`Set ${APP_SECRET} from the selected PEM file.\n`);
        continue;
      }
      output.write(`\nEnter ${secret.name} in the GitHub CLI prompt. If it already exists, this deliberately replaces it. This single-line value goes directly to gh; press Ctrl-D when finished.\n`);
      await runMutation(
        runner,
        "gh",
        ["secret", "set", secret.name, "--app", "actions", "--repo", plan.repository],
        { cwd: plan.root, stdio: "inherit", timeoutMs: null },
        `GitHub CLI did not set ${secret.name}. Automation remains disabled.`,
        resumeCommand
      );
    }

    for (const variable of remainingVariables) {
      await runMutation(
        runner,
        "gh",
        ["variable", "set", variable.name, "--body", variable.value, "--repo", plan.repository],
        { cwd: plan.root },
        `GitHub CLI did not set ${variable.name}. Automation remains disabled.`,
        resumeCommand
      );
    }
  } finally {
    try {
      appInput.close();
    } catch {
      // The descriptor is process-local and contains no buffered secret bytes.
    }
  }
}

export async function createSetupCommit(plan, {
  runner,
  fsImpl = { lstat, mkdir, readFile, readdir, unlink, writeFile },
  resumeCommand = "codekeeper init",
  platform = process.platform
}) {
  const paths = plan.files.map((file) => file.path);
  await runMutation(
    runner,
    "git",
    ["switch", "-c", plan.branch],
    { cwd: plan.root },
    `Could not create ${plan.branch}.`,
    resumeCommand
  );

  try {
    await assertNoInstallationFiles(plan.root, { fsImpl });
    for (const file of plan.files) {
      const target = await ensureSafeParents(fsImpl, plan.root, file.path);
      await fsImpl.writeFile(target, file.contents, { flag: "wx", mode: 0o644 });
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
      "Could not commit the disabled setup."
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
    throw new InstallerError("Could not create the disabled setup commit.", {
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
      if (blob.status !== 0 || blob.timedOut || blob.truncated) {
        throw new InstallerError(`Could not verify committed bytes for ${file.path}; nothing was pushed.`, {
          code: "COMMITTED_FILE_READ_FAILED",
          resume: formatCommand("git", ["show", "--stat", "--oneline", "HEAD"], platform)
        });
      }
      if (Buffer.byteLength(blob.stdout) !== file.bytes || sha256(blob.stdout) !== file.sha256) {
        throw new InstallerError(`Committed bytes changed for ${file.path}; nothing was pushed.`, {
          code: "COMMITTED_FILE_MISMATCH",
          resume: formatCommand("git", ["show", "--no-ext-diff", "--", file.path], platform)
        });
      }
    }
    const status = await requireSuccess(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: plan.root }, "Could not verify the setup worktree.");
    if (status) {
      throw new InstallerError("The worktree changed while the setup commit was created; nothing was pushed.", {
        code: "WORKTREE_CHANGED",
        resume: statusCommand(platform)
      });
    }
    return await requireSuccess(runner, "git", ["rev-parse", "HEAD"], { cwd: plan.root }, "Could not read the setup commit.");
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
        ? "The setup pull request may exist, but its remote branch could not be verified."
        : "The setup branch may have been pushed, but its remote commit could not be verified.",
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

export async function pushAndOpenSetupPullRequest(plan, commit, { runner, platform = process.platform }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new InstallerError("Verified setup commit is not a full Git commit SHA.", { code: "COMMIT_SHA_INVALID" });
  }
  await runMutation(
    runner,
    "git",
    ["push", "origin", `${commit}:refs/heads/${plan.branch}`],
    { cwd: plan.root },
    "The disabled setup commit was created locally, but push failed.",
    `${pushCommand(plan, commit, platform)}\nThen: ${pullRequestCreateCommand(plan, platform)}`
  );
  await assertRemoteSetupCommit(plan, commit, runner, platform);

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
    "The disabled setup branch was pushed, but pull-request creation failed or was interrupted.",
    `${pullRequestListCommand(plan, platform)}\nIf no pull request is listed: ${pullRequestCreateCommand(plan, platform)}`
  );
  if (!PR_URL.test(url)) {
    throw new InstallerError("GitHub CLI returned an invalid setup pull-request URL.", {
      code: "PR_URL_INVALID",
      resume: `${pullRequestListCommand(plan, platform)}\nIf no pull request is listed: ${pullRequestCreateCommand(plan, platform)}`
    });
  }
  await assertRemoteSetupCommit(plan, commit, runner, platform, url);
  return url;
}

export async function installPlan(plan, dependencies) {
  const commit = await createSetupCommit(plan, dependencies);
  const pullRequestUrl = await pushAndOpenSetupPullRequest(plan, commit, dependencies);
  return Object.freeze({ branch: plan.branch, commit, pullRequestUrl });
}
