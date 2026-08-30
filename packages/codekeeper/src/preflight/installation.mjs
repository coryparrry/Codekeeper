import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PROFILE_IDS,
  AGENT_PROFILES,
  ASSISTANT_WORKFLOW,
  MODE_IDS,
  POLICY_TARGET,
  RELEASE_MANIFEST_TARGET
} from "../constants.mjs";
import { RELEASE_MANAGED_CATALOG } from "../repository-artifacts.mjs";
import { InstallerError } from "../errors.mjs";
import { upgradePolicy } from "../policy.mjs";
import { assertNoInstallationFiles } from "./collisions.mjs";
import {
  assertManagedArtifacts,
  isInstalledCodekeeperWorkflow,
  parseReleaseManifest,
  readExactManagedTarget
} from "./managed-files.mjs";

export {
  assertManagedArtifacts,
  isInstalledCodekeeperWorkflow,
  parseReleaseManifest
};

const PACKAGE_MANAGER_LOCKFILES = Object.freeze([
  Object.freeze({ manager: "npm", names: Object.freeze(["package-lock.json", "npm-shrinkwrap.json"]) }),
  Object.freeze({ manager: "pnpm", names: Object.freeze(["pnpm-lock.yaml"]) }),
  Object.freeze({ manager: "yarn", names: Object.freeze(["yarn.lock"]) }),
  Object.freeze({ manager: "bun", names: Object.freeze(["bun.lock", "bun.lockb"]) }),
]);

function callerBoolean(source, name) {
  const matches = [...source.matchAll(new RegExp(`^\\s*(?:#\\s*)?${name}:\\s*(true|false)\\s*$`, "gm"))];
  if (matches.length > 1) throw new InstallerError(`Existing caller has duplicate ${name} controls.`, { code: "EXISTING_INSTALLATION_INVALID" });
  return matches.length ? matches[0][1] === "true" : null;
}

function callerSchedule(source) {
  const matches = [...source.matchAll(/^\s*-\s+cron:\s*["']([^"']+)["']\s*$/gm)];
  if (matches.length > 1) throw new InstallerError("Existing maintenance caller has duplicate schedules.", { code: "EXISTING_INSTALLATION_INVALID" });
  const value = matches[0]?.[1] ?? null;
  if (value !== null && !/^[^\s"'#]+(?:\s+[^\s"'#]+){4}$/.test(value)) {
    throw new InstallerError("Existing maintenance caller has an invalid schedule.", { code: "EXISTING_INSTALLATION_INVALID" });
  }
  return value;
}

function installedModes(source) {
  const matches = [
    ...source.matchAll(
      /^\s*installed_modes:\s*(?:"([a-z,]+)"|([a-z,]+))\s*$/gm,
    ),
  ].map((match) => match[1] ?? match[2]);
  if (!matches.length || matches.some((value) => value !== matches[0])) {
    throw new InstallerError("Existing unified caller has inconsistent installed_modes controls.", { code: "EXISTING_INSTALLATION_INVALID" });
  }
  const modes = matches[0].split(",");
  if (
    modes.length === 0 ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => !MODE_IDS.includes(mode))
  ) {
    throw new InstallerError("Existing unified caller has invalid installed modes.", { code: "EXISTING_INSTALLATION_INVALID" });
  }
  return modes;
}

async function exists(fsImpl, target) {
  try {
    return await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function packageManagerName(value) {
  const match = typeof value === "string" ? /^([a-z]+)@/.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

async function isRegularFile(fsImpl, target) {
  const stat = await exists(fsImpl, target);
  return Boolean(stat?.isFile?.() && !stat.isSymbolicLink?.());
}

async function readRootRegularFile(root, name, fsImpl) {
  const target = path.join(root, name);
  if (!await isRegularFile(fsImpl, target)) return null;
  try {
    return await fsImpl.readFile(target, "utf8");
  } catch {
    return null;
  }
}

async function isExecutableRegularFile(fsImpl, target) {
  const stat = await exists(fsImpl, target);
  return Boolean(stat?.isFile?.() && !stat.isSymbolicLink?.() && (stat.mode & 0o111));
}

async function discoverPackageValidationCommand(root, fsImpl) {
  const packageSource = await readRootRegularFile(root, "package.json", fsImpl);
  if (packageSource === null) return null;

  let packageJson;
  try {
    packageJson = JSON.parse(packageSource);
  } catch {
    return null;
  }
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) return null;

  const lockfileManagers = [];
  for (const definition of PACKAGE_MANAGER_LOCKFILES) {
    const found = [];
    for (const name of definition.names) {
      if (await isRegularFile(fsImpl, path.join(root, name))) found.push(name);
    }
    if (found.length) lockfileManagers.push({ ...definition, found });
  }
  if (lockfileManagers.length !== 1) return null;
  const lockfile = lockfileManagers[0];
  const declaredManager = packageManagerName(packageJson.packageManager);
  if (declaredManager && declaredManager !== lockfile.manager) return null;

  const scripts = packageJson.scripts;
  const script = ["check", "test"].find((name) => typeof scripts?.[name] === "string" && scripts[name].trim());
  if (!script) return null;
  return Object.freeze({
    command: `${lockfile.manager} run ${script}`,
    packageManager: lockfile.manager,
    lockfile: lockfile.found[0],
    script,
  });
}

function makeTarget(source) {
  return ["check", "test"].find((target) => new RegExp(`^\\s*${target}\\s*:(?:\\s|$)`, "m").test(source));
}

async function discoverNonNodeValidationCandidates(root, fsImpl) {
  const candidates = [];
  const makefile = await readRootRegularFile(root, "Makefile", fsImpl);
  const makeTargetName = makefile === null ? null : makeTarget(makefile);
  if (makeTargetName) candidates.push(Object.freeze({ command: `make ${makeTargetName}`, ecosystem: "make", buildFile: "Makefile" }));

  const pyproject = await readRootRegularFile(root, "pyproject.toml", fsImpl);
  if (pyproject !== null && /(?:^|[^A-Za-z0-9_-])pytest(?:[^A-Za-z0-9_-]|$)/.test(pyproject)) {
    const pythonLocks = [];
    for (const definition of [
      { lockfile: "uv.lock", command: "uv run pytest" },
      { lockfile: "poetry.lock", command: "poetry run pytest" },
      { lockfile: "Pipfile.lock", command: "pipenv run pytest" },
    ]) {
      if (await isRegularFile(fsImpl, path.join(root, definition.lockfile))) pythonLocks.push(definition);
    }
    if (pythonLocks.length === 1) {
      candidates.push(Object.freeze({
        command: pythonLocks[0].command,
        ecosystem: "python",
        buildFile: "pyproject.toml",
        lockfile: pythonLocks[0].lockfile,
      }));
    }
  }

  if (await isRegularFile(fsImpl, path.join(root, "Cargo.toml")) && await isRegularFile(fsImpl, path.join(root, "Cargo.lock"))) {
    candidates.push(Object.freeze({ command: "cargo test --locked", ecosystem: "cargo", buildFile: "Cargo.toml", lockfile: "Cargo.lock" }));
  }
  if (await isRegularFile(fsImpl, path.join(root, "Package.swift"))) {
    candidates.push(Object.freeze({ command: "swift test", ecosystem: "swift", buildFile: "Package.swift" }));
  }
  const gradleBuildFile = await isRegularFile(fsImpl, path.join(root, "build.gradle"))
    ? "build.gradle"
    : await isRegularFile(fsImpl, path.join(root, "build.gradle.kts"))
      ? "build.gradle.kts"
      : null;
  if (gradleBuildFile && await isExecutableRegularFile(fsImpl, path.join(root, "gradlew"))) {
    candidates.push(Object.freeze({ command: "./gradlew test", ecosystem: "gradle", buildFile: gradleBuildFile }));
  }
  if (await isRegularFile(fsImpl, path.join(root, "pom.xml")) && await isExecutableRegularFile(fsImpl, path.join(root, "mvnw"))) {
    candidates.push(Object.freeze({ command: "./mvnw test", ecosystem: "maven", buildFile: "pom.xml" }));
  }
  return candidates;
}

/**
 * Discover one deterministic repository validation command without executing
 * project code or searching beyond the checked-out repository root. A locked
 * package-manager script is the only documented priority; all other mixed
 * ecosystems fail closed rather than guessing which test command is intended.
 */
export async function discoverRepositoryValidationCommand(
  root,
  { fsImpl = { lstat, readFile } } = {},
) {
  const packageCandidate = await discoverPackageValidationCommand(root, fsImpl);
  if (packageCandidate) return packageCandidate;
  const candidates = await discoverNonNodeValidationCandidates(root, fsImpl);
  return candidates.length === 1 ? candidates[0] : null;
}

async function installedCaller(root, mode, releaseManifest, fsImpl, artifactCatalog) {
  const currentArtifact = artifactCatalog.callerArtifactForMode(mode);
  if (!currentArtifact) return null;
  const targets = [
    currentArtifact.target,
    ...Object.keys(releaseManifest?.managedFiles ?? {}).filter((target) => {
      const artifact = artifactCatalog.artifactForTarget(target);
      return artifact?.validation === "caller"
        && artifact.callerModes.includes(mode)
        && target !== currentArtifact.target;
    })
  ];
  const installed = [];
  for (const target of targets) {
    const source = await readExactManagedTarget(root, target, fsImpl);
    if (source !== null) installed.push({ target, source });
  }
  if (installed.length > 1) {
    throw new InstallerError(`The existing installation has multiple ${mode} caller workflows.`, { code: "EXISTING_INSTALLATION_INVALID" });
  }
  return installed[0] ?? null;
}

export async function inspectInstallationFiles(root, {
  fsImpl = { lstat, readdir, readFile },
  artifactCatalog = RELEASE_MANAGED_CATALOG
} = {}) {
  const policyPath = path.join(root, ...POLICY_TARGET.split("/"));
  const policyStat = await exists(fsImpl, policyPath);
  if (!policyStat) {
    await assertNoInstallationFiles(root, { fsImpl, artifactCatalog });
    return null;
  }
  await assertNoInstallationFiles(root, {
    fsImpl,
    allowExisting: true,
    artifactCatalog
  });
  const releaseManifestPath = path.join(root, ...RELEASE_MANIFEST_TARGET.split("/"));
  const releaseManifestStat = await exists(fsImpl, releaseManifestPath);
  const releaseManifestSource = releaseManifestStat ? await fsImpl.readFile(releaseManifestPath, "utf8") : null;
  const releaseManifest = releaseManifestSource ? parseReleaseManifest(releaseManifestSource, { artifactCatalog }) : null;
  let policy;
  const installedPolicySource = await fsImpl.readFile(policyPath, "utf8");
  try {
    policy = JSON.parse(installedPolicySource);
  } catch (cause) {
    throw new InstallerError("The existing Codekeeper policy is not valid JSON.", { code: "EXISTING_INSTALLATION_INVALID", cause });
  }
  if (!policy?.ai?.agents || !policy?.repository || !policy?.audit || !policy?.issues || !policy?.merge) {
    throw new InstallerError("The existing Codekeeper policy does not have the required sections.", { code: "EXISTING_INSTALLATION_INVALID" });
  }
  try {
    policy = upgradePolicy(policy);
  } catch (cause) {
    throw new InstallerError("The existing Codekeeper policy version is unsupported.", { code: "EXISTING_INSTALLATION_INVALID", cause });
  }
  // The planner was removed from the production flow. Strip its legacy policy
  // entry during reruns so the current strict policy validator can accept the
  // existing installation and render the single-pass fixer contract.
  delete policy.ai.agents.plan;
  for (const agent of Object.values(policy.ai.agents)) {
    if (agent && typeof agent === "object" && !Array.isArray(agent)) agent.maxTurns = 1;
  }
  const contents = { [POLICY_TARGET]: installedPolicySource };
  if (releaseManifestSource) contents[RELEASE_MANIFEST_TARGET] = releaseManifestSource;
  for (const profile of AGENT_PROFILE_IDS) {
    const target = AGENT_PROFILES[profile].target;
    const filePath = path.join(root, ...target.split("/"));
    const stat = await exists(fsImpl, filePath);
    if (!stat) continue;
    contents[target] = await fsImpl.readFile(filePath, "utf8");
  }
  let modes = [];
  const callerSources = {};
  let maintenanceScheduled = false;
  const assistantCaller = await installedCaller(root, ASSISTANT_WORKFLOW.id, releaseManifest, fsImpl, artifactCatalog);
  const unifiedTarget = artifactCatalog.callerArtifactForMode(ASSISTANT_WORKFLOW.id)?.target;
  if (assistantCaller?.target === unifiedTarget) {
    modes = installedModes(assistantCaller.source);
    contents[assistantCaller.target] = assistantCaller.source;
    for (const mode of modes) callerSources[mode] = assistantCaller.source;
  } else {
    for (const mode of MODE_IDS) {
      const caller = await installedCaller(root, mode, releaseManifest, fsImpl, artifactCatalog);
      if (!caller) continue;
      modes.push(mode);
      contents[caller.target] = caller.source;
      callerSources[mode] = caller.source;
    }
  }
  if (!modes.length) throw new InstallerError("The existing installation has no Codekeeper workflows.", { code: "EXISTING_INSTALLATION_INVALID" });
  if (callerSources.review) {
    policy.automation.automaticPrReview = callerBoolean(callerSources.review, "auto_review") ?? policy.automation.automaticPrReview;
    policy.automation.reviewFeedbackTriage = callerBoolean(callerSources.review, "feedback_triage") ?? policy.automation.reviewFeedbackTriage;
  }
  if (callerSources.issues) {
    policy.automation.issueTriage = callerBoolean(callerSources.issues, "auto_triage") ?? policy.automation.issueTriage;
  }
  if (callerSources.maintain) {
    const installedSchedule = callerSchedule(callerSources.maintain);
    policy.automation.maintenanceSchedule = installedSchedule ?? policy.automation.maintenanceSchedule;
    maintenanceScheduled = installedSchedule !== null;
  }
  if (assistantCaller) {
    contents[assistantCaller.target] = assistantCaller.source;
    policy.automation.ownerRequests = callerBoolean(assistantCaller.source, "owner_requests") ?? policy.automation.ownerRequests;
  } else {
    const legacyOwnerRequests = [callerSources.issues, callerSources.fix]
      .filter(Boolean)
      .map((source) => callerBoolean(source, "owner_requests"))
      .filter((value) => typeof value === "boolean");
    if (legacyOwnerRequests.includes(false)) policy.automation.ownerRequests = false;
    else if (legacyOwnerRequests.includes(true)) policy.automation.ownerRequests = true;
  }
  for (const target of Object.keys(releaseManifest?.managedFiles ?? {})) {
    if (contents[target] !== undefined) continue;
    contents[target] = await fsImpl.readFile(path.join(root, ...target.split("/")), "utf8");
  }
  const policySource = `${JSON.stringify(policy, null, 2)}\n`;
  const legacyPlannerProfile = ".github/codekeeper/agents/maintenance-planner.md";
  const legacyFiles = await exists(fsImpl, path.join(root, ...legacyPlannerProfile.split("/")))
    ? [legacyPlannerProfile]
    : [];
  return Object.freeze({
    policy: Object.freeze(policy),
    policySource,
    modes: Object.freeze(modes),
    maintenanceScheduled,
    contents: Object.freeze(contents),
    releaseManifest,
    legacyFiles: Object.freeze(legacyFiles)
  });
}
