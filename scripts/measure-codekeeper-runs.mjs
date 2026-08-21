import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(fileURLToPath(import.meta.url));
const MAX_RUN_RANGE = 100;
const MAX_BUFFER = 16 * 1024 * 1024;
const GH_COMMAND = process.env.CODEKEEPER_GH_COMMAND || "gh";

class MeasurementError extends Error {}

function fail(message) {
  throw new MeasurementError(message);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/measure-codekeeper-runs.mjs --repo OWNER/REPO --run RUN_ID [--run RUN_ID ...]",
    "  node scripts/measure-codekeeper-runs.mjs --repo OWNER/REPO --range START-END",
    "  node scripts/measure-codekeeper-runs.mjs OWNER/REPO#START-END",
    "",
    "Run IDs can also be supplied as a comma-separated value with --runs.",
  ].join("\n");
}

function validRepository(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function parseRunId(value) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail(`invalid workflow run ID: ${value}`);
  }
  const runId = Number(value);
  if (!Number.isSafeInteger(runId)) {
    fail(`workflow run ID is outside the safe integer range: ${value}`);
  }
  return runId;
}

function parseRunIds(value) {
  const values = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) {
    fail("at least one workflow run ID is required");
  }
  return values.map(parseRunId);
}

function parseRange(value) {
  const match = String(value).match(/^([1-9][0-9]*)-([1-9][0-9]*)$/);
  if (!match) {
    fail(`invalid workflow run range: ${value}`);
  }
  const start = parseRunId(match[1]);
  const end = parseRunId(match[2]);
  if (start > end) {
    fail("workflow run range must be ascending");
  }
  if (end - start + 1 > MAX_RUN_RANGE) {
    fail(`workflow run range cannot contain more than ${MAX_RUN_RANGE} runs`);
  }
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function parseRepositoryRange(value) {
  const match = String(value).match(/^([^#]+)#(.+)$/);
  if (!match || !validRepository(match[1])) {
    fail(`invalid repository/run range: ${value}`);
  }
  return { repository: match[1], runIds: parseRange(match[2]) };
}

function parseArguments(argv) {
  let repository = null;
  const runIds = [];
  let range = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--repo" || argument === "--repository") {
      repository = argv[++index];
      if (!repository || !validRepository(repository)) {
        fail("--repo must be an OWNER/REPO value");
      }
      continue;
    }
    if (
      argument === "--run" ||
      argument === "--run-id" ||
      argument === "--runs"
    ) {
      const value = argv[++index];
      if (!value) {
        fail(`${argument} requires a value`);
      }
      runIds.push(...parseRunIds(value));
      continue;
    }
    if (argument === "--range" || argument === "--run-range") {
      range = argv[++index];
      if (!range) {
        fail(`${argument} requires START-END or OWNER/REPO#START-END`);
      }
      continue;
    }
    if (argument.startsWith("--")) {
      fail(`unknown option: ${argument}`);
    }
    if (argument.includes("#")) {
      const parsed = parseRepositoryRange(argument);
      if (repository && repository !== parsed.repository) {
        fail("repository was supplied more than once with different values");
      }
      repository = parsed.repository;
      runIds.push(...parsed.runIds);
      continue;
    }
    if (/^[1-9][0-9]*$/.test(argument)) {
      runIds.push(parseRunId(argument));
      continue;
    }
    fail(`unexpected argument: ${argument}`);
  }

  if (help) {
    return { help: true };
  }
  if (range) {
    if (range.includes("#")) {
      const parsed = parseRepositoryRange(range);
      if (repository && repository !== parsed.repository) {
        fail("repository was supplied more than once with different values");
      }
      repository = parsed.repository;
      runIds.push(...parsed.runIds);
    } else {
      runIds.push(...parseRange(range));
    }
  }
  if (runIds.length === 0) {
    fail(`a workflow run ID or repository/run range is required\n${usage()}`);
  }
  return {
    help: false,
    repository,
    runIds: [...new Set(runIds)].sort((left, right) => left - right),
  };
}

async function gh(args, description) {
  try {
    const result = await execFileAsync(GH_COMMAND, args, {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return result.stdout;
  } catch {
    fail(`GitHub CLI request failed while ${description}`);
  }
}

async function ghJson(args, description) {
  const output = await gh(args, description);
  try {
    return JSON.parse(output);
  } catch {
    fail(`GitHub CLI returned malformed JSON while ${description}`);
  }
}

async function resolveRepository(repository) {
  const candidate = repository || process.env.GITHUB_REPOSITORY || "";
  if (candidate) {
    if (!validRepository(candidate)) {
      fail("GITHUB_REPOSITORY must be an OWNER/REPO value");
    }
    return candidate;
  }
  const output = await gh(
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    "resolving the current repository",
  );
  const resolved = output.trim();
  if (!validRepository(resolved)) {
    fail("GitHub CLI did not return a valid current repository");
  }
  return resolved;
}

function timestamp(value, label, { nullable = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    fail(`${label} is missing from the GitHub API response`);
  }
  if (typeof value !== "string") {
    fail(`${label} is not an RFC3339 UTC timestamp`);
  }
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/,
  );
  if (!match) {
    fail(`${label} is not an RFC3339 UTC timestamp`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecondsInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > millisecondsInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail(`${label} is not an RFC3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail(`${label} is not an RFC3339 UTC timestamp`);
  }
  return { value, milliseconds };
}

function interval(start, end, label) {
  if (start === null || end === null) return null;
  const durationMs = end.milliseconds - start.milliseconds;
  if (durationMs < 0) {
    fail(`${label} has a negative duration`);
  }
  return durationMs;
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is missing or malformed`);
  }
  return value;
}

function normalizeJobs(payload) {
  if (Array.isArray(payload)) {
    const pages = payload;
    const jobs = [];
    let expectedCount = null;
    for (const page of pages) {
      if (Array.isArray(page)) {
        jobs.push(...page);
      } else {
        const object = requiredObject(page, "jobs API page");
        if (!Array.isArray(object.jobs)) {
          fail("jobs API page does not contain a jobs array");
        }
        if (Number.isInteger(object.total_count)) {
          expectedCount = Math.max(expectedCount ?? 0, object.total_count);
        }
        jobs.push(...object.jobs);
      }
    }
    if (expectedCount !== null && expectedCount !== jobs.length) {
      fail("jobs API response is incomplete");
    }
    if (jobs.length === 0) {
      fail("jobs API response contains no jobs");
    }
    return jobs;
  }
  const object = requiredObject(payload, "jobs API response");
  if (!Array.isArray(object.jobs)) {
    fail("jobs API response does not contain a jobs array");
  }
  if (
    Number.isInteger(object.total_count) &&
    object.total_count !== object.jobs.length
  ) {
    fail("jobs API response is incomplete");
  }
  if (object.jobs.length === 0) {
    fail("jobs API response contains no jobs");
  }
  return object.jobs;
}

function stepLabel(step) {
  return typeof step?.name === "string" ? step.name : "";
}

function stepUses(step) {
  return typeof step?.uses === "string" ? step.uses : "";
}

function isPostRunStep(step) {
  return /^Post\b/i.test(stepLabel(step).trim());
}

function countSteps(steps, pattern) {
  return steps.filter(
    (step) =>
      !isPostRunStep(step) &&
      pattern.test(`${stepLabel(step)} ${stepUses(step)}`),
  ).length;
}

function modelCallStage(step) {
  const label = stepLabel(step);
  if (
    isPostRunStep(step) ||
    !(
      /^(?:Finalize|Triage) .* with configured Agents SDK model$/i.test(
        label,
      ) ||
      /^(?:Review with isolated Codex|Inspect issue with Codex|Implement with Codex|Audit checkout with Codex) through the Agents SDK$/i.test(
        label,
      )
    )
  ) {
    return null;
  }
  const started = timestamp(step.started_at, "model step started_at", {
    nullable: true,
  });
  const completed = timestamp(step.completed_at, "model step completed_at", {
    nullable: true,
  });
  const durationMs = interval(
    started,
    completed,
    `model step ${label || "(unnamed)"}`,
  );
  if (durationMs === null) return null;
  return { stage: label, durationMs };
}

function normalizeJob(job, workflowCreated, runId) {
  const object = requiredObject(job, "job");
  if (!Number.isSafeInteger(object.id) || object.id < 1) {
    fail(`run ${runId} contains a job with an invalid ID`);
  }
  if (typeof object.name !== "string" || object.name.length === 0) {
    fail(`run ${runId} contains a job with no name`);
  }
  if (!Array.isArray(object.steps)) {
    fail(`run ${runId} job ${object.id} has no complete steps array`);
  }
  const started = timestamp(
    object.started_at,
    `run ${runId} job ${object.id} started_at`,
    {
      nullable: true,
    },
  );
  const completed = timestamp(
    object.completed_at,
    `run ${runId} job ${object.id} completed_at`,
    {
      nullable: true,
    },
  );
  if (completed && !started) {
    fail(`run ${runId} job ${object.id} has completion without a start`);
  }
  const durationMs = interval(
    started,
    completed,
    `run ${runId} job ${object.id}`,
  );
  const queueDelayMs = started
    ? interval(workflowCreated, started, `run ${runId} job ${object.id} queue`)
    : null;
  const modelCallStages = object.steps
    .map(modelCallStage)
    .filter(Boolean)
    .map((stage) => ({ jobId: object.id, jobName: object.name, ...stage }));
  const artifactUploadCount = countSteps(
    object.steps,
    /upload\b|actions\/upload-artifact/i,
  );
  const artifactDownloadCount = countSteps(
    object.steps,
    /download\b|actions\/download-artifact/i,
  );
  return {
    id: object.id,
    name: object.name,
    status: typeof object.status === "string" ? object.status : null,
    conclusion:
      typeof object.conclusion === "string" ? object.conclusion : null,
    startedAt: started?.value ?? null,
    completedAt: completed?.value ?? null,
    queueDelayMs,
    durationMs,
    checkoutCount: countSteps(
      object.steps,
      /\bcheck(?:out| out)\b|actions\/checkout/i,
    ),
    setupNodeCount: countSteps(
      object.steps,
      /set\s+up[^\n]*node|setup[- ]node|actions\/setup-node/i,
    ),
    packageAcquisitionCount: countSteps(
      object.steps,
      /acquire(?: exact)? codekeeper package|verify downloaded codekeeper package|acquire-package/i,
    ),
    runtimeInstallationCount: countSteps(
      object.steps,
      /install exact codekeeper runtime|install-runtime\.mjs/i,
    ),
    artifactUploadCount,
    artifactDownloadCount,
    artifactUploadDownloadCount: artifactUploadCount + artifactDownloadCount,
    modelCallStages,
  };
}

function normalizeRun(run, jobsPayload, requestedRunId, repository) {
  const object = requiredObject(run, "workflow run response");
  if (object.id !== requestedRunId) {
    fail(
      `GitHub returned workflow run ${object.id ?? "unknown"} for requested run ${requestedRunId}`,
    );
  }
  const created = timestamp(
    object.created_at,
    `run ${requestedRunId} created_at`,
  );
  const started = timestamp(
    object.run_started_at,
    `run ${requestedRunId} run_started_at`,
    {
      nullable: true,
    },
  );
  const updated = timestamp(
    object.updated_at,
    `run ${requestedRunId} updated_at`,
  );
  const jobs = normalizeJobs(jobsPayload)
    .map((job) => normalizeJob(job, created, requestedRunId))
    .sort((left, right) => left.id - right.id);
  const totalElapsedMs = interval(created, updated, `run ${requestedRunId}`);
  return {
    id: requestedRunId,
    repository,
    workflowName: typeof object.name === "string" ? object.name : null,
    workflowPath: typeof object.path === "string" ? object.path : null,
    event: typeof object.event === "string" ? object.event : null,
    status: typeof object.status === "string" ? object.status : null,
    conclusion:
      typeof object.conclusion === "string" ? object.conclusion : null,
    createdAt: created.value,
    startedAt: started?.value ?? null,
    updatedAt: updated.value,
    totalElapsedMs,
    runnerAllocationCount: jobs.filter(runnerWasAllocated).length,
    checkoutCount: jobs.reduce((total, job) => total + job.checkoutCount, 0),
    setupNodeCount: jobs.reduce((total, job) => total + job.setupNodeCount, 0),
    packageAcquisitionCount: jobs.reduce(
      (total, job) => total + job.packageAcquisitionCount,
      0,
    ),
    runtimeInstallationCount: jobs.reduce(
      (total, job) => total + job.runtimeInstallationCount,
      0,
    ),
    artifactUploadCount: jobs.reduce(
      (total, job) => total + job.artifactUploadCount,
      0,
    ),
    artifactDownloadCount: jobs.reduce(
      (total, job) => total + job.artifactDownloadCount,
      0,
    ),
    artifactUploadDownloadCount: jobs.reduce(
      (total, job) => total + job.artifactUploadDownloadCount,
      0,
    ),
    modelCallStageDurations: jobs.flatMap((job) => job.modelCallStages),
    jobs,
  };
}

function runnerWasAllocated(job) {
  return job.startedAt !== null && job.conclusion !== "skipped";
}

async function measureRun(repository, runId) {
  const runEndpoint = `repos/${repository}/actions/runs/${runId}`;
  const jobsEndpoint = `${runEndpoint}/jobs?per_page=100`;
  const [run, jobs] = await Promise.all([
    ghJson(
      ["api", runEndpoint, "--header", "Accept: application/vnd.github+json"],
      `reading workflow run ${runId}`,
    ),
    ghJson(
      [
        "api",
        jobsEndpoint,
        "--paginate",
        "--slurp",
        "--header",
        "Accept: application/vnd.github+json",
      ],
      `reading jobs for workflow run ${runId}`,
    ),
  ]);
  return normalizeRun(run, jobs, runId, repository);
}

export async function measureRuns({ repository, runIds }) {
  const resolvedRepository = await resolveRepository(repository);
  const runs = [];
  for (const runId of runIds) {
    runs.push(await measureRun(resolvedRepository, runId));
  }
  return {
    schemaVersion: 1,
    repository: resolvedRepository,
    runIds: runs.map((run) => run.id),
    runs,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const argumentsValue = parseArguments(argv);
  if (argumentsValue.help) {
    console.log(usage());
    return;
  }
  const result = await measureRuns(argumentsValue);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export { countSteps, modelCallStage, runnerWasAllocated, timestamp };

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    const message =
      error instanceof MeasurementError
        ? error.message
        : "unexpected measurement failure";
    console.error(`measure-codekeeper-runs: ${message}`);
    process.exitCode = 1;
  });
}
