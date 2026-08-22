import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  RELEASE_MANIFEST_TARGET,
  SETUP_BRANCH
} from "../constants.mjs";
import { RELEASE_MANAGED_CATALOG } from "../repository-artifacts.mjs";
import { InstallerError } from "../errors.mjs";
import { requireSuccess } from "../command-runner.mjs";
import { parseJson } from "./github.mjs";
import {
  assertManagedArtifacts,
  isInstalledCodekeeperWorkflow,
  parseReleaseManifest
} from "./managed-files.mjs";

const GITHUB_WORKFLOW_REFERENCE = /(?:\/tools\/codekeeper@|\/.github\/workflows\/codekeeper(?:-|\.yml)|codekeeper@[0-9]|\.\/\.github\/workflows\/codekeeper(?:-|\.yml))/i;

async function exists(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function safeDirectoryEntries(fsImpl, target) {
  const stat = await exists(fsImpl, target);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new InstallerError(`${target} must be a regular directory, not a symlink.`, { code: "PATH_COLLISION" });
  }
  return fsImpl.readdir(target, { withFileTypes: true });
}

function caseEntry(entries, expected) {
  return entries.find((entry) => entry.name.toLowerCase() === expected.toLowerCase());
}

export async function assertNoInstallationFiles(
  root,
  {
    fsImpl = { lstat, readdir, readFile },
    allowExisting = false,
    artifactCatalog = RELEASE_MANAGED_CATALOG,
  } = {},
) {
  const rootEntries = await safeDirectoryEntries(fsImpl, root);
  const githubEntry = caseEntry(rootEntries, ".github");
  if (!githubEntry) return;
  if (githubEntry.name !== ".github" || githubEntry.isSymbolicLink() || !githubEntry.isDirectory()) {
    throw new InstallerError("A case-colliding or symlinked .github path already exists.", { code: "PATH_COLLISION" });
  }

  const githubRoot = path.join(root, ".github");
  const githubEntries = await safeDirectoryEntries(fsImpl, githubRoot);
  const policyEntry = caseEntry(githubEntries, "codekeeper.json");
  if (policyEntry) {
    if (policyEntry.name !== "codekeeper.json" || policyEntry.isSymbolicLink() || !policyEntry.isFile()) {
      throw new InstallerError("A case-colliding or symlinked Codekeeper policy exists.", { code: "PATH_COLLISION" });
    }
    if (!allowExisting)
      throw new InstallerError("A Codekeeper policy already exists.", {
        code: "EXISTING_INSTALLATION"
      });
  }

  const releaseManifestName = path.basename(RELEASE_MANIFEST_TARGET);
  const releaseManifestEntry = caseEntry(githubEntries, releaseManifestName);
  let releaseManifest = null;
  if (releaseManifestEntry) {
    if (releaseManifestEntry.name !== releaseManifestName || releaseManifestEntry.isSymbolicLink() || !releaseManifestEntry.isFile()) {
      throw new InstallerError("A case-colliding or symlinked Codekeeper release manifest exists.", { code: "PATH_COLLISION" });
    }
    if (!allowExisting)
      throw new InstallerError(
        "A Codekeeper release manifest already exists.",
        { code: "EXISTING_INSTALLATION" },
      );
    releaseManifest = parseReleaseManifest(
      await fsImpl.readFile(
        path.join(githubRoot, releaseManifestEntry.name),
        "utf8",
      ),
      { artifactCatalog },
    );
  }
  await assertManagedArtifacts(
    root,
    releaseManifest,
    fsImpl,
    artifactCatalog,
  );

  const codekeeperEntry = caseEntry(githubEntries, "codekeeper");
  if (codekeeperEntry) {
    if (codekeeperEntry.name !== "codekeeper" || codekeeperEntry.isSymbolicLink() || !codekeeperEntry.isDirectory()) {
      throw new InstallerError("A case-colliding or symlinked .github/codekeeper path already exists.", { code: "PATH_COLLISION" });
    }
    const codekeeperRoot = path.join(githubRoot, "codekeeper");
    const codekeeperEntries = await safeDirectoryEntries(fsImpl, codekeeperRoot);
    const agentsEntry = caseEntry(codekeeperEntries, "agents");
    if (agentsEntry) {
      if (agentsEntry.name !== "agents" || agentsEntry.isSymbolicLink() || !agentsEntry.isDirectory()) {
        throw new InstallerError("A case-colliding or symlinked Codekeeper agents path already exists.", { code: "PATH_COLLISION" });
      }
      const agentsRoot = path.join(codekeeperRoot, "agents");
      const agentEntries = await safeDirectoryEntries(fsImpl, agentsRoot);
      const knownProfileNames = new Map(AGENT_PROFILE_IDS.map((profile) => {
        const name = path.basename(AGENT_PROFILES[profile].target);
        return [name.toLowerCase(), name];
      }));
      for (const entry of agentEntries) {
        const expectedName = knownProfileNames.get(entry.name.toLowerCase());
        if (!expectedName) continue;
        if (entry.name !== expectedName
          || entry.isSymbolicLink() || !entry.isFile()) {
          throw new InstallerError("A case-colliding or symlinked Codekeeper agent profile exists.", { code: "PATH_COLLISION" });
        }
        if (!allowExisting) throw new InstallerError("A Codekeeper agent profile already exists.", { code: "EXISTING_INSTALLATION" });
      }
    }
  }

  const workflowsEntry = caseEntry(githubEntries, "workflows");
  if (!workflowsEntry) return;
  if (workflowsEntry.name !== "workflows" || workflowsEntry.isSymbolicLink() || !workflowsEntry.isDirectory()) {
    throw new InstallerError("A case-colliding or symlinked workflows path already exists.", { code: "PATH_COLLISION" });
  }

  const workflowsRoot = path.join(githubRoot, "workflows");
  const workflowEntries = await safeDirectoryEntries(fsImpl, workflowsRoot);
  const knownWorkflowNames = new Map(artifactCatalog.artifacts
    .filter((artifact) => artifact.validation === "caller" && artifact.target.startsWith(".github/workflows/"))
    .map((artifact) => [
      path.basename(artifact.target).toLowerCase(),
      { name: path.basename(artifact.target), artifact }
    ]));
  const releasedWorkflowNames = new Map(
    Object.keys(releaseManifest?.managedFiles ?? {})
      .filter((target) => target.startsWith(".github/workflows/"))
      .map((target) => [
        path.basename(target).toLowerCase(),
        {
          name: path.basename(target),
          digest: releaseManifest.managedFiles[target],
          artifact: artifactCatalog.artifactForTarget(target),
        },
      ]),
  );
  for (const entry of workflowEntries) {
    const knownWorkflow = knownWorkflowNames.get(entry.name.toLowerCase());
    if (knownWorkflow) {
      if (entry.name !== knownWorkflow.name || entry.isSymbolicLink() || !entry.isFile()) {
        throw new InstallerError("A case-colliding or symlinked Codekeeper workflow exists.", { code: "PATH_COLLISION" });
      }
      if (!allowExisting)
        throw new InstallerError("A Codekeeper workflow already exists.", {
          code: "EXISTING_INSTALLATION"
        });
      const source = await fsImpl.readFile(path.join(workflowsRoot, entry.name), "utf8");
      if (!isInstalledCodekeeperWorkflow(source, knownWorkflow.artifact.callerModes)) {
        throw new InstallerError(`Existing workflow ${entry.name} is not an installed Codekeeper caller.`, { code: "PATH_COLLISION" });
      }
      releasedWorkflowNames.delete(entry.name.toLowerCase());
      continue;
    }
    const releasedWorkflow = releasedWorkflowNames.get(entry.name.toLowerCase());
    if (releasedWorkflow) {
      if (entry.name !== releasedWorkflow.name || entry.isSymbolicLink() || !entry.isFile()) {
        throw new InstallerError("A case-colliding or symlinked released Codekeeper workflow exists.", { code: "PATH_COLLISION" });
      }
      releasedWorkflowNames.delete(entry.name.toLowerCase());
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (/codekeeper/i.test(entry.name)) throw new InstallerError("A symlinked Codekeeper workflow path already exists.", { code: "PATH_COLLISION" });
      continue;
    }
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const source = await fsImpl.readFile(path.join(workflowsRoot, entry.name), "utf8");
    if (GITHUB_WORKFLOW_REFERENCE.test(source)) {
      throw new InstallerError(`Existing workflow ${entry.name} already invokes Codekeeper.`, { code: "EXISTING_INSTALLATION" });
    }
  }
}

export async function assertNoSetupBranch({ runner, root, repository, branch = SETUP_BRANCH }) {
  const localRefs = await requireSuccess(
    runner,
    "git",
    ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
    { cwd: root },
    "Could not inspect local Git refs."
  );
  const collidingRefs = new Set([
    "refs/heads/codekeeper",
    `refs/heads/${branch}`,
    "refs/remotes/origin/codekeeper",
    `refs/remotes/origin/${branch}`
  ]);
  if (localRefs.split("\n").some((ref) => collidingRefs.has(ref.trim()) || ref.trim().startsWith(`refs/heads/${branch}/`) || ref.trim().startsWith(`refs/remotes/origin/${branch}/`))) {
    throw new InstallerError(`Local Git refs collide with ${branch}.`, {
      code: "SETUP_BRANCH_EXISTS"
    });
  }

  const remoteRefs = await requireSuccess(
    runner,
    "git",
    ["ls-remote", "--heads", "origin", "refs/heads/codekeeper", `refs/heads/${branch}`, `refs/heads/${branch}/*`],
    { cwd: root },
    "Could not inspect remote setup refs."
  );
  if (remoteRefs.trim()) throw new InstallerError(`Remote branch ${branch} or a colliding ref already exists.`, { code: "SETUP_BRANCH_EXISTS" });

  const pulls = parseJson(await requireSuccess(runner, "gh", ["pr", "list", "--repo", repository, "--state", "open", "--head", branch, "--json", "number,url"], { cwd: root }, "Could not inspect existing setup pull requests."), "GitHub pull-request query");
  if (!Array.isArray(pulls))
    throw new InstallerError("GitHub returned an invalid pull-request list.", {
      code: "PREFLIGHT_INVALID_RESPONSE"
    });
  if (pulls.length) throw new InstallerError(`A setup pull request already exists for ${branch}.`, { code: "SETUP_BRANCH_EXISTS" });
}
