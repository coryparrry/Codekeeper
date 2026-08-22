import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveNpmCliPath,
  resolveNpmRelease,
  stageVerifiedPackage,
} from "./updater.mjs";
import { verifyCodekeeperRelease } from "./release-verifier.mjs";
import { appPermissions } from "./plan.mjs";

const REQUIRED_DRY_RUN_JOBS = Object.freeze([
  "Codekeeper maintenance workspace specialist",
  "Codekeeper maintenance analysis",
  "Codekeeper maintenance verification",
]);
const APP_CREDENTIAL_JOB = "Codekeeper App credential verification";

function successful(result) {
  return (
    Boolean(result) &&
    result.status === 0 &&
    !result.timedOut &&
    !result.truncated
  );
}

function variableValue(variables, name) {
  if (variables instanceof Map) return variables.get(name) ?? null;
  if (variables && typeof variables === "object")
    return variables[name] ?? null;
  return null;
}

function exactPermissions(value, expected) {
  return JSON.stringify(Object.entries(value ?? {}).sort()) ===
    JSON.stringify(Object.entries(expected).sort());
}

function permissionDelta(expected, registration) {
  return [...new Set([
    ...Object.keys(expected),
    ...Object.keys(registration ?? {})
  ])]
    .sort()
    .filter((permission) => registration?.[permission] !== expected[permission])
    .map((permission) => Object.freeze({
      permission,
      required: expected[permission] ?? "none",
      registered: registration?.[permission] ?? "none"
    }));
}

function appSettingsUrl(app, slug) {
  const owner = app?.owner;
  if (owner?.type === "Organization" && typeof owner.login === "string" && owner.login) {
    return `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/${encodeURIComponent(slug)}/permissions`;
  }
  return `https://github.com/settings/apps/${encodeURIComponent(slug)}/permissions`;
}

function appProof(status, details = {}) {
  return Object.freeze({ status, ...details });
}

export async function inspectInstalledAppRegistration({
  runner,
  root,
  repository,
  installation = null,
  variables = null,
}) {
  const readVariable = async (name) => {
    const supplied = variableValue(variables, name);
    if (typeof supplied === "string") return supplied;
    const result = await runner.run(
      "gh",
      [
        "variable",
        "get",
        name,
        "--repo",
        repository,
        "--json",
        "value",
        "--jq",
        ".value",
      ],
      { cwd: root },
    );
    return successful(result) ? result.stdout.trim() : null;
  };
  const [clientId, botLogin] = await Promise.all([
    readVariable("CODEKEEPER_APP_CLIENT_ID"),
    readVariable("CODEKEEPER_AUTOMATION_BOT_LOGIN"),
  ]);
  const slug = botLogin?.match(/^([a-z0-9](?:[a-z0-9-]{0,99}))\[bot\]$/)?.[1];
  if (!clientId || !slug) return appProof("mismatch", { reason: "missing-identity" });

  const appResult = await runner.run(
    "gh",
    ["api", "--hostname", "github.com", `apps/${slug}`],
    { cwd: root },
  );
  if (!successful(appResult)) return appProof("mismatch", { reason: "registration-unavailable" });
  let app;
  try {
    app = JSON.parse(appResult.stdout);
  } catch {
    return appProof("mismatch", { reason: "registration-invalid" });
  }
  const capabilities = installation?.policy
    ? {
        reviewRepair: installation.policy.review?.autoRepair === true,
        repair: installation.policy.audit?.repair?.enabled === true,
        issueImplementation: installation.policy.issues?.allowAiImplementation === true,
        autoMerge: installation.policy.merge?.enabled === true
      }
    : ["reviewRepair", "repair", "issueImplementation", "autoMerge"];
  const required = appPermissions({
    modes: installation?.modes,
    capabilities,
    ownerRequests: installation?.policy?.automation?.ownerRequests ?? true
  });
  const expectedPermissions = {
    contents: required.contents,
    issues: required.issues,
    metadata: required.metadata,
    pull_requests: required.pullRequests
  };
  const settingsUrl = appSettingsUrl(app, slug);
  if (
    app.client_id !== clientId ||
    !Array.isArray(app.events) ||
    app.events.length !== 0
  ) {
    return appProof("mismatch", {
      reason: "registration-identity",
      slug,
      settingsUrl,
      expectedPermissions,
      registrationPermissions: app.permissions ?? {}
    });
  }

  if (!exactPermissions(app.permissions, expectedPermissions)) {
    return appProof("mismatch", {
      reason: "permissions",
      slug,
      settingsUrl,
      expectedPermissions: Object.freeze({ ...expectedPermissions }),
      registrationPermissions: Object.freeze({ ...(app.permissions ?? {}) }),
      permissionDelta: Object.freeze(permissionDelta(expectedPermissions, app.permissions))
    });
  }
  return appProof("pass", {
    slug,
    settingsUrl,
    expectedPermissions: Object.freeze({ ...expectedPermissions })
  });
}

export async function inspectInstalledApp(options) {
  return (await inspectInstalledAppRegistration(options)).status === "pass";
}

export async function verifyInstalledPackage(
  { packageRelease, installation, root },
  {
    runner,
    environment,
    platform,
    resolveNpm = resolveNpmCliPath,
    resolveRelease = resolveNpmRelease,
    stagePackage = stageVerifiedPackage,
    verifyRelease = verifyCodekeeperRelease,
    remove = rm,
  },
) {
  const npmCli = await resolveNpm({ cwd: root, environment, platform });
  const resolved = await resolveRelease({
    cwd: root,
    environment,
    platform,
    requestedVersion: packageRelease.version,
    resolveNpm: async () => npmCli,
    runner,
  });
  if (resolved.integrity !== packageRelease.integrity) return false;
  const staged = await stagePackage({
    cwd: root,
    environment,
    platform,
    receipt: resolved,
    npmCli,
    runner,
  });
  try {
    const packageRoot = path.dirname(path.dirname(staged.executable));
    await writeFile(
      path.join(packageRoot, "release", "package-integrity.json"),
      `${JSON.stringify(
        {
          version: 1,
          algorithm: "sha512",
          integrity: packageRelease.integrity,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    await verifyRelease({
      root: packageRoot,
      expectedName: packageRelease.name,
      expectedVersion: packageRelease.version,
      expectedIntegrity: packageRelease.integrity,
    });
    const packagedSource = JSON.parse(
      await readFile(path.join(packageRoot, "assets", "metadata.json"), "utf8"),
    ).source;
    const installedSource = installation.releaseManifest?.source;
    if (
      packagedSource?.repository !== installedSource?.repository ||
      packagedSource?.commit !== installedSource?.commit
    ) {
      return false;
    }
    const runtimeRoot = path.join(packageRoot, "runtime");
    const installed = await runner.run(
      "node",
      [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: runtimeRoot, timeoutMs: 5 * 60 * 1000 },
    );
    if (!successful(installed)) return false;
    const checked = await runner.run(
      "node",
      [
        path.join(runtimeRoot, "src", "cli.mjs"),
        "check-config",
        "--config",
        path.join(root, ".github", "codekeeper.json"),
      ],
      { cwd: root, timeoutMs: 30_000 },
    );
    return successful(checked);
  } finally {
    await remove(staged.root, { recursive: true, force: true });
  }
}

function matchingRunIds(result, verificationId) {
  if (!successful(result)) return null;
  try {
    const runs = JSON.parse(result.stdout);
    if (
      !Array.isArray(runs) ||
      runs.some((run) => !Number.isSafeInteger(run?.databaseId) || typeof run?.displayTitle !== "string")
    )
      return null;
    const expectedTitle = `Codekeeper maintenance verification ${verificationId}`;
    return runs.filter((run) => run.displayTitle === expectedTitle).map((run) => run.databaseId);
  } catch {
    return null;
  }
}

async function listDryRuns(runner, root, repository, verificationId) {
  return matchingRunIds(
    await runner.run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        "codekeeper.yml",
        "--event",
        "workflow_dispatch",
        "--limit",
        "20",
        "--json",
        "databaseId,displayTitle",
      ],
      { cwd: root },
    ),
    verificationId,
  );
}

function requiredJobsPassed(result) {
  if (!successful(result)) return false;
  try {
    const response = JSON.parse(result.stdout);
    if (!Array.isArray(response?.jobs)) return false;
    return REQUIRED_DRY_RUN_JOBS.every((name) =>
      response.jobs.some(
        (job) => job?.name === name && job?.conclusion === "success",
      ),
    );
  } catch {
    return false;
  }
}

export async function runMaintenanceDryRun(
  { runner, root, repository, installation },
  {
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    verificationId = randomUUID(),
  } = {},
) {
  if (!installation?.modes?.includes("maintain")) return false;
  if (!/^[0-9a-f-]{36}$/.test(verificationId)) return false;
  const dispatched = await runner.run(
    "gh",
    [
      "workflow",
      "run",
      "codekeeper.yml",
      "--repo",
      repository,
      "--ref",
      installation.policy.repository.defaultBranch,
      "--field",
      "dry_run=true",
      "--field",
      `verification_id=${verificationId}`,
    ],
    { cwd: root },
  );
  if (!successful(dispatched)) return false;

  let matchingIds = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await wait(2_000);
    matchingIds = await listDryRuns(runner, root, repository, verificationId);
    if (!matchingIds || matchingIds.length > 1) return false;
    if (matchingIds.length === 1) break;
  }
  if (matchingIds.length !== 1) return false;

  const runId = String(matchingIds[0]);
  const watched = await runner.run(
    "gh",
    ["run", "watch", runId, "--repo", repository, "--exit-status"],
    { cwd: root, stdio: "ignore", timeoutMs: 30 * 60 * 1000 },
  );
  if (!successful(watched)) return false;
  const viewed = await runner.run(
    "gh",
    ["run", "view", runId, "--repo", repository, "--json", "jobs"],
    { cwd: root },
  );
  return requiredJobsPassed(viewed);
}

function appCredentialRunIds(result, verificationId) {
  if (!successful(result)) return null;
  try {
    const runs = JSON.parse(result.stdout);
    if (!Array.isArray(runs) || runs.some((run) => !Number.isSafeInteger(run?.databaseId) || typeof run?.displayTitle !== "string")) {
      return null;
    }
    const expectedTitle = `Codekeeper App credential verification ${verificationId}`;
    return runs
      .filter((run) => run.displayTitle === expectedTitle)
      .map((run) => run.databaseId);
  } catch {
    return null;
  }
}

function appCredentialJobPassed(result) {
  if (!successful(result)) return false;
  try {
    const response = JSON.parse(result.stdout);
    return Array.isArray(response?.jobs) && response.jobs.some(
      (job) => job?.name === APP_CREDENTIAL_JOB && job?.conclusion === "success"
    );
  } catch {
    return false;
  }
}

export async function runAppCredentialProbe(
  { runner, root, repository, installation },
  {
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    verificationId = randomUUID()
  } = {}
) {
  if (!installation || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(verificationId)) {
    return false;
  }
  const dispatched = await runner.run(
    "gh",
    [
      "workflow",
      "run",
      "codekeeper.yml",
      "--repo",
      repository,
      "--ref",
      installation.policy.repository.defaultBranch,
      "--field",
      "verify_app_credentials=true",
      "--field",
      `verification_id=${verificationId}`
    ],
    { cwd: root }
  );
  if (!successful(dispatched)) return false;

  let matchingIds = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await wait(2_000);
    const listed = await runner.run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        "codekeeper.yml",
        "--event",
        "workflow_dispatch",
        "--limit",
        "20",
        "--json",
        "databaseId,displayTitle"
      ],
      { cwd: root }
    );
    matchingIds = appCredentialRunIds(listed, verificationId);
    if (!matchingIds || matchingIds.length > 1) return false;
    if (matchingIds.length === 1) break;
  }
  if (matchingIds.length !== 1) return false;

  const runId = String(matchingIds[0]);
  const watched = await runner.run(
    "gh",
    ["run", "watch", runId, "--repo", repository, "--exit-status"],
    { cwd: root, stdio: "ignore", timeoutMs: 10 * 60 * 1000 }
  );
  if (!successful(watched)) return false;
  return appCredentialJobPassed(await runner.run(
    "gh",
    ["run", "view", runId, "--repo", repository, "--json", "jobs"],
    { cwd: root }
  ));
}
