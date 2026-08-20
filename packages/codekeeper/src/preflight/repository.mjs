import path from "node:path";
import { InstallerError } from "../errors.mjs";
import { requireSuccess } from "../command-runner.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function exists(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function trimGitSuffix(value) {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function repositoryFromPathname(pathname) {
  const parts = trimGitSuffix(pathname.replace(/^\//, "").replace(/\/$/, "")).split("/");
  const repository = parts.length === 2 ? `${parts[0]}/${parts[1]}` : "";
  if (!REPOSITORY.test(repository)) throw new InstallerError("origin is not a GitHub.com owner/repository URL.", { code: "UNSUPPORTED_ORIGIN" });
  return repository;
}

export function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) {
    throw new InstallerError("The Git origin URL is missing.", {
      code: "UNSUPPORTED_ORIGIN"
    });
  }
  const value = remoteUrl.trim();
  const scp = /^git@github\.com:([^?#]+)$/.exec(value);
  if (scp)
    return Object.freeze({
      host: "github.com",
      repository: repositoryFromPathname(scp[1]),
      protocol: "ssh"
    });

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InstallerError("origin must use GitHub.com HTTPS or SSH.", {
      code: "UNSUPPORTED_ORIGIN"
    });
  }
  if (parsed.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:"].includes(parsed.protocol)) {
    throw new InstallerError("GitHub Enterprise Server and non-GitHub origins are not supported.", { code: "UNSUPPORTED_ORIGIN" });
  }
  if (parsed.search || parsed.hash || parsed.password || (parsed.protocol === "https:" && parsed.username)) {
    throw new InstallerError("origin must not contain credentials, query parameters, or fragments.", { code: "UNSUPPORTED_ORIGIN" });
  }
  if (parsed.protocol === "ssh:" && parsed.username !== "git") {
    throw new InstallerError("GitHub SSH origins must use the git user.", {
      code: "UNSUPPORTED_ORIGIN"
    });
  }
  return Object.freeze({
    host: "github.com",
    repository: repositoryFromPathname(parsed.pathname),
    protocol: parsed.protocol === "https:" ? "https" : "ssh"
  });
}

export function parseRemoteBranchSha(output, defaultBranch) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) throw new InstallerError(`origin does not expose exactly one ${defaultBranch} branch tip.`, { code: "REMOTE_HEAD_INVALID" });
  const [sha, ref, ...extra] = lines[0].split(/\s+/);
  if (!FULL_SHA.test(sha) || ref !== `refs/heads/${defaultBranch}` || extra.length) {
    throw new InstallerError("origin returned an invalid default-branch tip.", {
      code: "REMOTE_HEAD_INVALID"
    });
  }
  return sha;
}

async function assertNoGitOperation(root, runner, fsImpl) {
  const names = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"];
  for (const name of names) {
    const gitPath = await requireSuccess(runner, "git", ["rev-parse", "--git-path", name], { cwd: root }, "Could not inspect Git operation state.");
    const resolved = path.isAbsolute(gitPath) ? gitPath : path.join(root, gitPath);
    if (await exists(fsImpl, resolved)) {
      throw new InstallerError("Finish the active Git operation before installing Codekeeper.", { code: "GIT_OPERATION_ACTIVE" });
    }
  }
}

export async function inspectLocalCheckout({ runner, cwd, fsImpl }) {
  const rootOutput = await requireSuccess(runner, "git", ["rev-parse", "--show-toplevel"], { cwd }, "Run Codekeeper init inside a Git checkout.");
  const root = await fsImpl.realpath(rootOutput);
  const bare = await requireSuccess(runner, "git", ["rev-parse", "--is-bare-repository"], { cwd: root }, "Could not inspect the Git checkout.");
  if (bare !== "false")
    throw new InstallerError("Bare repositories are not supported.", {
      code: "UNSUPPORTED_CHECKOUT"
    });
  const sparse = await runner.run("git", ["config", "--bool", "core.sparseCheckout"], { cwd: root });
  if (sparse.status === 0 && sparse.stdout.trim() === "true")
    throw new InstallerError("Sparse checkouts are not supported.", {
      code: "UNSUPPORTED_CHECKOUT"
    });
  if (![0, 1].includes(sparse.status))
    throw new InstallerError("Could not inspect sparse-checkout state.", {
      code: "PREFLIGHT_COMMAND_FAILED"
    });
  await assertNoGitOperation(root, runner, fsImpl);

  const currentBranch = await requireSuccess(runner, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root }, "Detached HEAD checkouts are not supported.");
  const originUrl = await requireSuccess(runner, "git", ["remote", "get-url", "origin"], { cwd: root }, "An origin remote is required.");
  const origin = parseGitHubRemote(originUrl);
  return { root, currentBranch, originUrl, origin };
}

export function assertDefaultBranchCheckout(currentBranch, defaultBranch) {
  if (typeof defaultBranch !== "string" || !defaultBranch || currentBranch !== defaultBranch) {
    throw new InstallerError(`The checkout must be attached to the GitHub default branch${defaultBranch ? ` (${defaultBranch})` : ""}.`, { code: "WRONG_BRANCH" });
  }
}

export async function assertFreshCleanCheckout({ runner, root, defaultBranch }) {
  const status = await requireSuccess(runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }, "Could not inspect Git status.");
  if (status) throw new InstallerError("The Git checkout must be clean, including untracked files.", { code: "DIRTY_CHECKOUT" });
  const headSha = await requireSuccess(runner, "git", ["rev-parse", "HEAD"], { cwd: root }, "Could not read HEAD.");
  if (!FULL_SHA.test(headSha))
    throw new InstallerError("Git returned an invalid HEAD commit.", {
      code: "INVALID_HEAD"
    });
  const remoteDefaultSha = parseRemoteBranchSha(await requireSuccess(runner, "git", ["ls-remote", "origin", `refs/heads/${defaultBranch}`], { cwd: root }, "Could not read the remote default branch."), defaultBranch);
  if (headSha !== remoteDefaultSha) throw new InstallerError("HEAD must exactly match the remote default branch before setup.", { code: "STALE_CHECKOUT" });
  return { headSha, remoteDefaultSha };
}

export async function assertGitIdentity({ runner, root }) {
  const authorName = await runner.run("git", ["config", "--get", "user.name"], {
    cwd: root
  });
  const authorEmail = await runner.run("git", ["config", "--get", "user.email"], { cwd: root });
  if (authorName.status !== 0 || !authorName.stdout.trim() || authorEmail.status !== 0 || !authorEmail.stdout.trim()) {
    throw new InstallerError("Configure Git user.name and user.email before setup.", { code: "GIT_IDENTITY_REQUIRED" });
  }
}
