import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { InstallerError } from "./errors.mjs";
import { discoverNpmPackageLockPreparation } from "./preflight/installation.mjs";
import { resolveNpmCliPath } from "./updater.mjs";

const NPM_LOCKFILE_ARGS = Object.freeze([
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
]);

async function existingEntry(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeGeneratedLockfile(root, fsImpl) {
  const target = path.join(root, "package-lock.json");
  const stat = await existingEntry(fsImpl, target);
  if (!stat) return;
  if (stat.isDirectory?.()) {
    throw new InstallerError("The generated package-lock.json could not be removed safely.", {
      code: "PACKAGE_LOCK_CLEANUP_FAILED"
    });
  }
  await fsImpl.unlink(target);
}

function commandFailed(result) {
  return result.status !== 0 || result.timedOut || result.truncated;
}

function generatedFileDiff(source) {
  if (typeof source !== "string") throw new TypeError("generated package-lock.json must be text");
  const endsWithNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (endsWithNewline) lines.pop();
  const lineCount = lines.length;
  const hunk = lineCount ? `@@ -0,0 +1,${lineCount} @@\n` : "@@ -0,0 +0,0 @@\n";
  const body = lines.map((line) => `+${line}\n`).join("");
  const missingFinalNewline = !endsWithNewline && source.length > 0 ? "\\ No newline at end of file\n" : "";
  return `diff --git a/package-lock.json b/package-lock.json\nnew file mode 100644\n--- /dev/null\n+++ b/package-lock.json\n${hunk}${body}${missingFinalNewline}`;
}

/**
 * Offer and, with two explicit confirmations, prepare a missing npm lockfile.
 * The helper never stages or commits the generated file. A false result means
 * setup should continue without retaining a generated lockfile; true means
 * the caller must stop and tell the user to commit it before rerunning setup.
 */
export async function prepareNpmPackageLock({
  root,
  runner,
  prompt,
  secondPrompt = prompt,
  output,
  candidate = null,
  platform = process.platform,
  environment = process.env,
  execPath = process.execPath,
  npmCli = null,
  resolveNpm = resolveNpmCliPath,
  withInteractiveTerminal = null,
  fsImpl = { lstat, readFile, unlink },
} = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root must be a non-empty string");
  if (!runner || typeof runner.run !== "function") throw new TypeError("runner must provide run");
  if (!prompt || typeof prompt.confirm !== "function") throw new TypeError("prompt must provide confirm");
  if (!secondPrompt || typeof secondPrompt.confirm !== "function") throw new TypeError("secondPrompt must provide confirm");
  if (!output || typeof output.write !== "function") throw new TypeError("output must provide write");

  const preparation = candidate ?? await discoverNpmPackageLockPreparation(root, { fsImpl });
  if (!preparation) return false;

  let requested;
  try {
    requested = await prompt.confirm({
      message: "Create package-lock.json for Codekeeper validation?",
      defaultValue: false,
    });
  } catch (error) {
    if (error?.code === "PROMPT_ABORTED") return false;
    throw error;
  }
  if (!requested) return false;

  let retained = false;
  try {
    const resolvedNpmCli = npmCli ?? await resolveNpm({ cwd: root, environment, platform });
    if (typeof resolvedNpmCli !== "string" || !resolvedNpmCli) {
      throw new InstallerError("Could not safely locate npm.", { code: "NPM_UNAVAILABLE" });
    }
    const npmResult = await runner.run(execPath, [resolvedNpmCli, ...NPM_LOCKFILE_ARGS], { cwd: root });
    if (commandFailed(npmResult)) {
      throw new InstallerError("npm could not prepare package-lock.json.", {
        code: npmResult.timedOut ? "COMMAND_TIMEOUT" : "COMMAND_FAILED"
      });
    }

    const generated = await existingEntry(fsImpl, path.join(root, "package-lock.json"));
    if (!generated || !generated.isFile?.() || generated.isSymbolicLink?.()) {
      throw new InstallerError("npm did not generate a safe package-lock.json.", {
        code: "PACKAGE_LOCK_GENERATION_FAILED"
      });
    }

    const generatedSource = await fsImpl.readFile(path.join(root, "package-lock.json"), "utf8");
    let keep;
    try {
      const confirmRetention = () => secondPrompt.confirm({
        message: "Keep generated package-lock.json in this checkout?",
        defaultValue: false,
      });
      const showDiffAndConfirm = async () => {
        output.write("\nGenerated package-lock.json diff\n");
        output.write(generatedFileDiff(generatedSource));
        return confirmRetention();
      };
      keep = typeof withInteractiveTerminal === "function"
        ? await withInteractiveTerminal(showDiffAndConfirm)
        : await showDiffAndConfirm();
    } catch (error) {
      if (error?.code === "PROMPT_ABORTED") {
        await removeGeneratedLockfile(root, fsImpl);
        return false;
      }
      throw error;
    }
    if (!keep) {
      await removeGeneratedLockfile(root, fsImpl);
      return false;
    }
    retained = true;
    output.write("\nCodekeeper setup stopped. Commit or merge package-lock.json to the repository, then rerun setup from a clean, current default-branch checkout.\n");
    return true;
  } catch (error) {
    if (!retained) await removeGeneratedLockfile(root, fsImpl);
    throw error;
  }
}
