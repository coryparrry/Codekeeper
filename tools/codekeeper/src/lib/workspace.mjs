import { realpathSync } from "node:fs";
import path from "node:path";

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function canonicalPath(candidate) {
  let existing = path.resolve(candidate);
  const missing = [];
  while (true) {
    try {
      return path.join(realpathSync(existing), ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

// Prompts, model output, and generated artifacts must never be written through
// a path controlled by the checked-out repository. GitHub runners provide
// RUNNER_TEMP for this purpose; local callers can use any absolute sibling.
export function assertRunnerOwnedDirectory(directory, cwd = process.cwd()) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("A runner-owned --directory is required");
  }
  if (!path.isAbsolute(directory)) {
    throw new Error("--directory must be an absolute runner-owned path");
  }
  const resolvedDirectory = canonicalPath(directory);
  const resolvedCwd = canonicalPath(cwd);
  if (isWithin(resolvedCwd, resolvedDirectory) || isWithin(resolvedDirectory, resolvedCwd)) {
    throw new Error("--directory must be outside the checked-out repository");
  }
  return resolvedDirectory;
}

export function runUrl(repository = process.env.GITHUB_REPOSITORY, runId = process.env.GITHUB_RUN_ID) {
  if (!repository || !runId) return "";
  return `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${runId}`;
}
