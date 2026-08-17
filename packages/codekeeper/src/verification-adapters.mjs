import { rm } from "node:fs/promises";
import path from "node:path";
import {
  resolveNpmCliPath,
  resolveNpmRelease,
  stageVerifiedPackage,
} from "./updater.mjs";
import { verifyCodekeeperRelease } from "./release-verifier.mjs";

const REQUIRED_DRY_RUN_JOBS = Object.freeze([
  "Codekeeper maintenance workspace specialist",
  "Codekeeper maintenance analysis",
  "Codekeeper maintenance verification",
]);

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

export async function inspectInstalledApp({
  runner,
  root,
  repository,
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
  if (!clientId || !slug) return false;

  const appResult = await runner.run(
    "gh",
    ["api", "--hostname", "github.com", `apps/${slug}`],
    { cwd: root },
  );
  if (!successful(appResult)) return false;
  let app;
  try {
    app = JSON.parse(appResult.stdout);
  } catch {
    return false;
  }
  const expectedPermissions = {
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  };
  if (
    app.client_id !== clientId ||
    JSON.stringify(Object.entries(app.permissions ?? {}).sort()) !==
      JSON.stringify(Object.entries(expectedPermissions).sort()) ||
    !Array.isArray(app.events) ||
    app.events.length !== 0
  ) {
    return false;
  }

  const installationsResult = await runner.run(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      "user/installations",
      "--paginate",
      "--slurp",
    ],
    { cwd: root },
  );
  if (!successful(installationsResult)) return false;
  let installation;
  try {
    const pages = JSON.parse(installationsResult.stdout);
    const installations = Array.isArray(pages)
      ? pages.flatMap((page) => page?.installations ?? [])
      : [];
    installation = installations.find(
      (candidate) =>
        candidate?.app_slug === slug && candidate?.suspended_at == null,
    );
  } catch {
    return false;
  }
  if (
    !Number.isSafeInteger(installation?.id) ||
    installation.repository_selection !== "selected"
  )
    return false;

  const repositoriesResult = await runner.run(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      `user/installations/${installation.id}/repositories?per_page=2`,
    ],
    { cwd: root },
  );
  if (!successful(repositoriesResult)) return false;
  try {
    const response = JSON.parse(repositoriesResult.stdout);
    return (
      response?.total_count === 1 &&
      Array.isArray(response.repositories) &&
      response.repositories.length === 1 &&
      response.repositories[0]?.full_name?.toLowerCase() ===
        repository.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function verifyInstalledPackage(
  { packageRelease, installation, root },
  { runner, environment, platform },
) {
  const npmCli = await resolveNpmCliPath({ cwd: root, environment, platform });
  const resolved = await resolveNpmRelease({
    cwd: root,
    environment,
    platform,
    requestedVersion: packageRelease.version,
    resolveNpm: async () => npmCli,
    runner,
  });
  if (resolved.integrity !== packageRelease.integrity) return false;
  const staged = await stageVerifiedPackage({
    cwd: root,
    environment,
    platform,
    receipt: resolved,
    npmCli,
    runner,
  });
  try {
    const packageRoot = path.dirname(path.dirname(staged.executable));
    await verifyCodekeeperRelease({
      root: packageRoot,
      expectedName: packageRelease.name,
      expectedVersion: packageRelease.version,
      expectedIntegrity: packageRelease.integrity,
      expectedSourceCommit: installation.releaseManifest?.source?.commit,
    });
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
    await rm(staged.root, { recursive: true, force: true });
  }
}

function runIds(result) {
  if (!successful(result)) return null;
  try {
    const runs = JSON.parse(result.stdout);
    if (
      !Array.isArray(runs) ||
      runs.some((run) => !Number.isSafeInteger(run?.databaseId))
    )
      return null;
    return new Set(runs.map((run) => run.databaseId));
  } catch {
    return null;
  }
}

async function listDryRuns(runner, root, repository) {
  return runIds(
    await runner.run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        "codekeeper-maintain.yml",
        "--event",
        "workflow_dispatch",
        "--limit",
        "20",
        "--json",
        "databaseId",
      ],
      { cwd: root },
    ),
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
  } = {},
) {
  if (!installation?.modes?.includes("maintain")) return false;
  const before = await listDryRuns(runner, root, repository);
  if (!before) return false;
  const dispatched = await runner.run(
    "gh",
    [
      "workflow",
      "run",
      "codekeeper-maintain.yml",
      "--repo",
      repository,
      "--ref",
      installation.policy.repository.defaultBranch,
      "--field",
      "dry_run=true",
    ],
    { cwd: root },
  );
  if (!successful(dispatched)) return false;

  let newRunIds = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await wait(2_000);
    const after = await listDryRuns(runner, root, repository);
    if (!after) return false;
    newRunIds = [...after].filter((id) => !before.has(id));
    if (newRunIds.length > 1) return false;
    if (newRunIds.length === 1) break;
  }
  if (newRunIds.length !== 1) return false;

  const runId = String(newRunIds[0]);
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
