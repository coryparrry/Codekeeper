import { InstallerError } from "../errors.mjs";
import { requireSuccess } from "../command-runner.mjs";

export function assertNodeVersion(nodeVersion = process.versions.node) {
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 22) {
    throw new InstallerError("Node.js 22 or newer is required.", {
      code: "UNSUPPORTED_NODE"
    });
  }
}

export async function assertInstallerEnvironment({
  runner,
  cwd,
  nodeVersion = process.versions.node,
  interactive = true,
}) {
  assertNodeVersion(nodeVersion);
  if (!interactive) throw new InstallerError("Codekeeper init requires an interactive terminal.", { code: "NON_INTERACTIVE" });
  await requireSuccess(runner, "git", ["--version"], { cwd }, "Git is required.");
  await requireSuccess(runner, "gh", ["--version"], { cwd }, "GitHub CLI is required.");
}
