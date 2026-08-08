import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareEvidenceDestination, writeEvidenceAtomically } from "./evidence.mjs";

const PRIVATE_REPOSITORY_PREFIX = "codekeeper-acceptance-";
const SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const SAFE_PREFIX = /^(?!\/)(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+$/;
const MAX_REPOSITORY_LENGTH = 140;
const MAX_GITHUB_URL_LENGTH = 2048;
const MAX_GH_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_GH_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_GH_KILL_GRACE_MS = 1_000;
const ACCEPTANCE_TAG_PREFIX = "codekeeper-acceptance/dispatch-";
const MAX_ACCEPTANCE_TAG_LENGTH = 160;
const REVIEW_MARKER = "<!-- codekeeper:review -->";
const ISSUE_TRIAGE_MARKER = "<!-- codekeeper:issue-triage -->";
const MUTATING_SCENARIOS = new Set([
  "maintenance-dry-run",
  "review-introduced-defect",
  "issue-triage-related",
  "controlled-fix"
]);
const SCENARIO_DETAILS = Object.freeze({
  "maintenance-dry-run": {
    workflow: "codekeeper-maintain.yml",
    workflowName: "Codekeeper maintenance",
    event: "workflow_dispatch"
  },
  "review-introduced-defect": {
    workflow: "codekeeper-review.yml",
    workflowName: "Codekeeper review",
    event: "pull_request_target"
  },
  "issue-triage-related": {
    workflow: "codekeeper-issues.yml",
    workflowName: "Codekeeper issue triage",
    event: "issues"
  },
  "controlled-fix": {
    workflow: "codekeeper-fix.yml",
    workflowName: "Codekeeper issue implementation",
    event: "workflow_dispatch"
  }
});

export const FIXTURE_ALLOWED_FIX_PATHS = Object.freeze(["src/discount.mjs", "test/discount.test.mjs"]);

export class AcceptanceError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AcceptanceError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function repairMarker(fingerprint) {
  return `<!-- codekeeper:repair=${fingerprint} -->`;
}

function repairNotificationMarker(fingerprint) {
  return `<!-- codekeeper:repair-notification=${fingerprint} -->`;
}

function branchSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");
}

export function redact(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?-----END [^-]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:token|bearer)\s+[^\s,;]+/gi, "token [REDACTED]")
    .replace(/\b(?:gh|github)[_-]?token\s*[:=]\s*[^\s,;]+/gi, "GH_TOKEN=[REDACTED]")
    .replace(/\b(?:authorization|token|secret|password|api[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, (_match, label) => `${label}=[REDACTED]`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function safeEnvironment(source = process.env) {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];
  const entries = [];
  for (const name of allowed) {
    if (source[name] !== undefined) entries.push([name, source[name]]);
  }
  return Object.fromEntries(entries);
}

export function createGhRunner({
  spawn = nodeSpawn,
  environment = process.env,
  timeoutMs = DEFAULT_GH_COMMAND_TIMEOUT_MS,
  killGraceMs = DEFAULT_GH_KILL_GRACE_MS
} = {}) {
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "GitHub CLI command timeout must be positive");
  assert(Number.isInteger(killGraceMs) && killGraceMs > 0, "GitHub CLI kill grace must be positive");
  return async (args) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], env: safeEnvironment(environment) });
    } catch {
      reject(new AcceptanceError("GitHub CLI command failed"));
      return;
    }

    let stdout = "";
    let stderr = "";
    let received = 0;
    let settled = false;
    let terminating = false;
    let deadlineTimer;
    let killTimer;
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      child.stdout?.off?.("data", onStdout);
      child.stderr?.off?.("data", onStderr);
      child.off?.("error", onError);
      child.off?.("close", onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      clearTimeout(deadlineTimer);
      try { child.kill?.("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill?.("SIGKILL"); } catch {}
        finish(reject, new AcceptanceError("GitHub CLI command failed"));
      }, killGraceMs);
    };
    const receive = (chunk, stream) => {
      if (settled || terminating) return;
      received += Buffer.byteLength(chunk);
      if (received > MAX_GH_OUTPUT_BYTES) {
        terminate();
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    const onStdout = (chunk) => receive(chunk, "stdout");
    const onStderr = (chunk) => receive(chunk, "stderr");
    const onError = () => terminate();
    const onClose = (exitCode) => {
      if (terminating) {
        finish(reject, new AcceptanceError("GitHub CLI command failed"));
        return;
      }
      finish(resolve, { exitCode: exitCode ?? 1, stdout: redact(stdout), stderr: redact(stderr) });
    };

    child.stdout?.on?.("data", onStdout);
    child.stderr?.on?.("data", onStderr);
    child.on?.("error", onError);
    child.on?.("close", onClose);
    deadlineTimer = setTimeout(terminate, timeoutMs);
  });
}

async function callGh(gh, args) {
  let result;
  try {
    result = await gh([...args]);
  } catch {
    throw new AcceptanceError("GitHub CLI command failed");
  }
  const exitCode = Number(result?.exitCode ?? 0);
  if (exitCode !== 0) throw new AcceptanceError("GitHub CLI command failed");
  return { stdout: redact(result?.stdout ?? ""), stderr: redact(result?.stderr ?? "") };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new AcceptanceError(`${label} returned invalid metadata`);
  }
}

function decodeBase64(text, label) {
  const encoded = String(text).replace(/\s/g, "");
  assert(encoded.length > 0 && encoded.length <= 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), `${label} returned invalid content`);
  return Buffer.from(encoded, "base64").toString("utf8");
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function happensOnOrAfter(value, boundary) {
  return validTimestamp(value) && validTimestamp(boundary) && Date.parse(value) >= Date.parse(boundary);
}

function normaliseLogin(value) {
  return String(value ?? "").trim().toLowerCase();
}

function validateRepositoryName(repo) {
  assert(typeof repo === "string" && repo.length <= MAX_REPOSITORY_LENGTH && REPOSITORY.test(repo), "An explicit --repo OWNER/REPOSITORY is required; implicit or current repositories are rejected");
  const [owner, name] = repo.split("/");
  assert(owner.length <= 39 && name.length <= 100, "Target repository name exceeds GitHub's bounded repository limits");
  assert(name.startsWith(PRIVATE_REPOSITORY_PREFIX), `Target repository name must begin with ${PRIVATE_REPOSITORY_PREFIX}`);
  return repo;
}

function validateSourceSha(sourceSha) {
  assert(typeof sourceSha === "string" && SHA.test(sourceSha), "--source-sha must be an immutable 40-character commit SHA; branches and tags are rejected");
  return sourceSha.toLowerCase();
}

function validatePositiveInteger(value, option) {
  assert(typeof value === "string" && POSITIVE_INTEGER.test(value), `${option} must be a positive integer`);
  return Number(value);
}

function validateAppIdentity(options) {
  const login = normaliseLogin(options["app-login"]);
  assert(/^[a-z0-9](?:[a-z0-9-]{0,38}\[bot\])?$/.test(login), "--app-login must be an explicit GitHub App bot login");
  return { login, id: String(validatePositiveInteger(options["app-id"], "--app-id")) };
}

function expect(assertions, expectation, passed) {
  assertions.push({ expectation, passed: Boolean(passed) });
}

function labelsFrom(value) {
  return (value?.labels ?? []).map((label) => typeof label === "string" ? label : label?.name).filter(Boolean);
}

function hasExactCheck(checks, name, expectedBucket) {
  return checks.some((check) => check?.name === name && String(check?.bucket ?? check?.state ?? "").toLowerCase() === expectedBucket);
}

function workflowEvidence(run) {
  return run ? { id: run.databaseId, url: run.url, conclusion: run.conclusion } : null;
}

function resourceEvidence(kind, resource) {
  return resource ? { kind, number: resource.number, url: resource.url } : null;
}

function runEvidenceLine(url) {
  return `<sub>Codekeeper workflow run: ${url}</sub>`;
}

function expectedRunUrl(repo, runId) {
  return `https://github.com/${repo}/actions/runs/${runId}`;
}

function isBoundedGitHubUrl(value, expected = null) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_GITHUB_URL_LENGTH
    && value.startsWith(expected ?? "https://github.com/");
}

function currentIso(now) {
  return now().toISOString();
}

function issueRunTitle(issueNumber) {
  return `Codekeeper issue triage #${issueNumber}`;
}

function reviewRunTitle(pullRequestNumber, headSha) {
  return `Codekeeper review #${pullRequestNumber} @${headSha}`;
}

function dispatchRunTitle(scenario) {
  return SCENARIO_DETAILS[scenario].workflowName;
}

function acceptanceTagName(scenario, headSha) {
  const name = `${ACCEPTANCE_TAG_PREFIX}${scenario}-${headSha.slice(0, 12)}-${randomUUID()}`;
  assert(name.length <= MAX_ACCEPTANCE_TAG_LENGTH && new RegExp(`^${ACCEPTANCE_TAG_PREFIX}[a-z0-9-]+-[0-9a-f]{12}-[0-9a-f-]{36}$`).test(name), "Acceptance dispatch tag is invalid");
  return name;
}

export function parsePinnedWorkflowUses(yaml, workflow, sourceSha) {
  const activeUses = [];
  const expectedPath = `.github/workflows/${workflow}`.toLowerCase();
  const exact = new RegExp(`^\\s*uses\\s*:\\s*(?:["'])?[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+\\/\\.github\\/workflows\\/${workflow.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}@${sourceSha}(?:["'])?\\s*$`, "i");
  for (const rawLine of String(yaml).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const isUses = /^uses\s*:|^-\s*uses\s*:/i.test(trimmed);
    const mentionsExpectedPath = trimmed.toLowerCase().includes(expectedPath);
    if (isUses) activeUses.push(trimmed);
    if (mentionsExpectedPath && !isUses) throw new AcceptanceError("Caller workflow contains an unrelated active Codekeeper workflow reference");
  }
  assert(activeUses.length === 1, "Caller workflow must contain exactly one active reusable-workflow uses entry");
  assert(exact.test(activeUses[0]), "Caller workflow must use the expected Codekeeper workflow at the supplied immutable SHA");
  return true;
}

export function parseEventCallerRunName(yaml, scenario) {
  const expected = scenario === "review-introduced-defect"
    ? 'run-name: "Codekeeper review #${{ github.event.pull_request.number }} @${{ github.event.pull_request.head.sha }}"'
    : scenario === "issue-triage-related"
      ? 'run-name: "Codekeeper issue triage #${{ github.event.issue.number }}"'
      : null;
  assert(expected !== null, "Only event-driven scenarios require a caller run-name contract");
  const active = String(yaml)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#") && /^run-name\s*:/i.test(line);
    });
  assert(active.length === 1 && active[0] === expected, "Caller workflow must contain exactly the expected active deterministic run-name expression");
  return true;
}

async function repositoryFile({ repo, file, ref, gh }) {
  const revision = ref === undefined ? "" : `?ref=${encodeURIComponent(ref)}`;
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/contents/${file}${revision}`, "--jq", ".content"]);
  return decodeBase64(stdout, file);
}

async function repositoryFileAtImmutableSnapshot({ repo, file, snapshot, expectedSource, gh }) {
  const [byTag, bySha] = await Promise.all([
    repositoryFile({ repo, file, ref: snapshot.dispatchRef, gh }),
    repositoryFile({ repo, file, ref: snapshot.headSha, gh })
  ]);
  assert(byTag === bySha, "Immutable acceptance tag did not resolve to the recorded fixture revision");
  if (expectedSource !== undefined) assert(bySha === expectedSource, "Immutable acceptance tag content did not match the prevalidated fixture revision");
  return bySha;
}

async function assertPinnedSource({ repo, scenario, sourceSha, revision, snapshot, expectedSource, gh }) {
  const workflow = SCENARIO_DETAILS[scenario].workflow;
  const file = `.github/workflows/${workflow}`;
  const source = snapshot
    ? await repositoryFileAtImmutableSnapshot({ repo, file, snapshot, expectedSource, gh })
    : await repositoryFile({ repo, file, ref: revision, gh });
  parsePinnedWorkflowUses(source, workflow, sourceSha);
  if (scenario === "review-introduced-defect" || scenario === "issue-triage-related") {
    parseEventCallerRunName(source, scenario);
  }
  return source;
}

async function listWorkflowRuns({ repo, workflow, event, gh }) {
  const { stdout } = await callGh(gh, [
    "run", "list", "--repo", repo, "--workflow", workflow, "--event", event,
    "--json", "databaseId,attempt,status,createdAt,updatedAt,headSha,headBranch,displayTitle", "--limit", "100"
  ]);
  const runs = parseJson(stdout, "Workflow run list");
  assert(Array.isArray(runs) && runs.length <= 100, "Workflow run list returned invalid metadata");
  return runs.map((run) => {
    assert(Number.isInteger(run?.databaseId) && run.databaseId > 0, "Workflow run list has an invalid run identifier");
    assert(Number.isInteger(run?.attempt) && run.attempt > 0, "Workflow run list has an invalid attempt");
    assert(typeof run?.status === "string" && run.status.length > 0, "Workflow run list has an invalid status");
    assert(validTimestamp(run?.createdAt) && validTimestamp(run?.updatedAt), "Workflow run list has invalid timestamps");
    assert(typeof run?.headSha === "string" && SHA.test(run.headSha) && typeof run?.headBranch === "string" && run.headBranch.length > 0, "Workflow run list has no immutable revision");
    assert(typeof run?.displayTitle === "string" && run.displayTitle.length > 0 && run.displayTitle.length <= 180, "Workflow run list has an invalid display title");
    return run;
  });
}

async function workflowRunMetadata({ repo, runId, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/actions/runs/${runId}`]);
  const metadata = parseJson(stdout, "Workflow run");
  assert(String(metadata?.id) === String(runId), "Workflow run metadata did not match the requested run");
  assert(isBoundedGitHubUrl(metadata?.html_url, `https://github.com/${repo}/actions/runs/`) && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(metadata.html_url), "Workflow run metadata has an invalid URL");
  assert(typeof metadata?.head_sha === "string" && SHA.test(metadata.head_sha), "Workflow run metadata has no immutable head SHA");
  assert(typeof metadata?.head_branch === "string" && metadata.head_branch.length > 0, "Workflow run metadata has no head branch");
  assert(typeof metadata?.event === "string" && metadata.event.length > 0, "Workflow run metadata has no event");
  assert(Number.isInteger(metadata?.run_attempt) && metadata.run_attempt > 0, "Workflow run metadata has an invalid attempt");
  assert(typeof metadata?.status === "string" && metadata.status.length > 0, "Workflow run metadata has an invalid status");
  assert(typeof metadata?.display_title === "string" && metadata.display_title.length > 0 && metadata.display_title.length <= 180, "Workflow run metadata has an invalid display title");
  assert(validTimestamp(metadata?.created_at) && validTimestamp(metadata?.updated_at), "Workflow run metadata has invalid timestamps");
  return {
    databaseId: metadata.id,
    url: metadata.html_url,
    event: metadata.event,
    headSha: metadata.head_sha,
    headBranch: metadata.head_branch,
    createdAt: metadata.created_at,
    updatedAt: metadata.updated_at,
    attempt: metadata.run_attempt,
    status: metadata.status,
    displayTitle: metadata.display_title,
    actorLogin: normaliseLogin(metadata?.actor?.login)
  };
}

async function waitForRun({ repo, runId, expectedEvent, expectedWorkflowName, expectedDisplayTitle, gh, sleep, boundary = null, attempts = 20 }) {
  assert(typeof expectedDisplayTitle === "string" && expectedDisplayTitle.length > 0, "An expected workflow display title is required");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { stdout } = await callGh(gh, [
      "run", "view", String(runId), "--repo", repo,
      "--json", "databaseId,url,conclusion,status,workflowName,headSha,headBranch,createdAt,startedAt,updatedAt,attempt,displayTitle"
    ]);
    const view = parseJson(stdout, "Workflow run");
    assert(String(view.databaseId) === String(runId), "Workflow run did not match the explicit run identifier");
    assert(view.workflowName === expectedWorkflowName, "Workflow run did not match the expected Codekeeper workflow");
    assert(view.displayTitle === expectedDisplayTitle, "Workflow run did not match the durable expected display title");
    assert(Number.isInteger(view.attempt) && view.attempt > 0, "Workflow run has an invalid attempt");
    if (view.status === "completed") {
      const metadata = await workflowRunMetadata({ repo, runId, gh });
      assert(metadata.event === expectedEvent, "Workflow run event did not match the acceptance scenario");
      assert(view.url === metadata.url, "Workflow run URL did not match GitHub metadata");
      assert(view.headSha === metadata.headSha && view.headBranch === metadata.headBranch && view.displayTitle === metadata.displayTitle && view.attempt === metadata.attempt && view.status === metadata.status && view.updatedAt === metadata.updatedAt, "Workflow run view did not match immutable GitHub metadata");
      const run = { ...view, ...metadata, startedAt: view.startedAt || metadata.createdAt };
      assert(validTimestamp(run.startedAt), "Workflow run has no valid start timestamp");
      if (boundary) {
        assert(run.headSha === boundary.headSha && run.headBranch === boundary.headBranch && run.displayTitle === boundary.displayTitle, "Workflow run did not use the recorded dispatch revision");
        assert(happensOnOrAfter(run.createdAt, boundary.dispatchedAt), "Workflow run predates the recorded dispatch boundary");
        assert(run.actorLogin === boundary.actorLogin, "Workflow run actor did not match the authenticated dispatcher");
      }
      return run;
    }
    if (attempt < attempts - 1) await sleep(3000);
  }
  throw new AcceptanceError("Workflow run did not complete within the bounded acceptance wait");
}

async function defaultBranchRevision({ repo, defaultBranch, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/git/ref/heads/${defaultBranch}`]);
  const payload = parseJson(stdout, "Default branch ref");
  assert(typeof payload?.object?.sha === "string" && SHA.test(payload.object.sha), "Default branch ref has no immutable SHA");
  return payload.object.sha;
}

function assertQuiescent(runs) {
  assert(runs.every((run) => run?.status === "completed"), "Target workflow is not quiescent; refusing a concurrent scenario");
}

async function acceptanceTagRef({ repo, tag, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`]);
  const payload = parseJson(stdout, "Acceptance tag ref");
  assert(payload?.ref === `refs/tags/${tag}` && payload?.object?.type === "commit" && typeof payload?.object?.sha === "string" && SHA.test(payload.object.sha), "Acceptance tag ref is invalid");
  return payload.object.sha.toLowerCase();
}

async function prevalidateDispatchSnapshot({ repo, scenario, sourceSha, preflight, gh }) {
  const headSha = (await defaultBranchRevision({ repo, defaultBranch: preflight.defaultBranch, gh })).toLowerCase();
  const callerSource = await assertPinnedSource({ repo, scenario, sourceSha, revision: headSha, gh });
  const fixPolicy = scenario === "controlled-fix"
    ? await configuredFixPolicy({ repo, revision: headSha, gh })
    : null;
  return { headSha, callerSource, fixPolicy };
}

async function createImmutableDispatchSnapshot({ repo, scenario, sourceSha, prevalidated, gh, onSnapshot = () => {} }) {
  const headSha = prevalidated.headSha;
  const dispatchRef = acceptanceTagName(scenario, headSha);
  await callGh(gh, ["api", "--hostname", "github.com", "--method", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/tags/${dispatchRef}`, "-f", `sha=${headSha}`]);
  const snapshot = { headSha, dispatchRef };
  onSnapshot(snapshot);
  assert(await acceptanceTagRef({ repo, tag: dispatchRef, gh }) === headSha, "Acceptance tag did not resolve to the recorded default-branch SHA");
  await assertPinnedSource({ repo, scenario, sourceSha, snapshot, expectedSource: prevalidated.callerSource, gh });
  return snapshot;
}

async function revalidateBaselineRuns({ repo, baseline, observedRuns, dispatchedAt, gh }) {
  const observedById = new Map(observedRuns.map((run) => [String(run.databaseId), run]));
  for (const prior of baseline) {
    const observed = observedById.get(String(prior.databaseId));
    assert(observed && observed.attempt === prior.attempt && observed.status === prior.status && observed.updatedAt === prior.updatedAt, "A baseline workflow run changed or disappeared after the dispatch boundary");
    const current = await workflowRunMetadata({ repo, runId: prior.databaseId, gh });
    assert(current.attempt === prior.attempt && current.status === prior.status && current.updatedAt === prior.updatedAt, "A baseline workflow run changed after the dispatch boundary");
    assert(!happensOnOrAfter(current.updatedAt, dispatchedAt), "A baseline workflow run overlaps the dispatch boundary");
  }
}

function matchesDispatchBoundary(run, boundary) {
  return run.headSha === boundary.headSha
    && run.headBranch === boundary.headBranch
    && run.displayTitle === boundary.displayTitle
    && happensOnOrAfter(run.createdAt, boundary.dispatchedAt);
}

async function dispatchAndWait({ repo, scenario, issue, preflight, snapshot, gh, sleep, now }) {
  const detail = SCENARIO_DETAILS[scenario];
  const baseline = await listWorkflowRuns({ repo, workflow: detail.workflow, event: detail.event, gh });
  assertQuiescent(baseline);
  const boundary = {
    baselineIds: new Set(baseline.map((run) => String(run.databaseId))),
    dispatchedAt: currentIso(now),
    headSha: snapshot.headSha,
    headBranch: snapshot.dispatchRef,
    displayTitle: dispatchRunTitle(scenario),
    actorLogin: preflight.actorLogin,
    dispatchRef: snapshot.dispatchRef
  };
  const inputs = scenario === "maintenance-dry-run"
    ? ["-f", "dry_run=true"]
    : ["-f", `issue_number=${issue}`, "-f", "dry_run=false"];
  await callGh(gh, ["workflow", "run", detail.workflow, "--repo", repo, "--ref", snapshot.dispatchRef, ...inputs]);
  assert(await acceptanceTagRef({ repo, tag: snapshot.dispatchRef, gh }) === snapshot.headSha, "Acceptance tag changed after workflow dispatch");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await listWorkflowRuns({ repo, workflow: detail.workflow, event: detail.event, gh });
    await revalidateBaselineRuns({ repo, baseline, observedRuns: runs, dispatchedAt: boundary.dispatchedAt, gh });
    const candidates = runs.filter((run) => !boundary.baselineIds.has(String(run.databaseId)) && matchesDispatchBoundary(run, boundary));
    assert(candidates.length <= 1, "Concurrent workflow runs made dispatch attribution ambiguous");
    if (candidates.length === 1) {
      const candidate = candidates[0];
      const run = await waitForRun({ repo, runId: candidate.databaseId, expectedEvent: detail.event, expectedWorkflowName: detail.workflowName, expectedDisplayTitle: boundary.displayTitle, gh, sleep, boundary });
      const completedRuns = await listWorkflowRuns({ repo, workflow: detail.workflow, event: detail.event, gh });
      await revalidateBaselineRuns({ repo, baseline, observedRuns: completedRuns, dispatchedAt: boundary.dispatchedAt, gh });
      assert(await acceptanceTagRef({ repo, tag: snapshot.dispatchRef, gh }) === snapshot.headSha, "Acceptance tag changed while waiting for the workflow run");
      return run;
    }
    if (attempt < 19) await sleep(3000);
  }
  throw new AcceptanceError("A unique dispatched workflow run was not observed within the bounded acceptance wait");
}

async function runJobs({ repo, runId, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  const payload = parseJson(stdout, "Workflow jobs");
  assert(Array.isArray(payload.jobs) && payload.jobs.length <= 100, "Workflow jobs returned invalid metadata");
  return payload.jobs;
}

async function pullRequest({ repo, number, gh }) {
  const { stdout } = await callGh(gh, ["pr", "view", String(number), "--repo", repo, "--json", "number,url,state,isDraft,isCrossRepository,baseRefName,headRefOid,headRefName,labels,updatedAt"]);
  const pull = parseJson(stdout, "Pull request");
  assert(Number(pull?.number) === number && isBoundedGitHubUrl(pull?.url, `https://github.com/${repo}/pull/`) && pull.url === `https://github.com/${repo}/pull/${number}`, "Pull request metadata did not match the requested PR");
  assert(typeof pull?.headRefOid === "string" && SHA.test(pull.headRefOid) && typeof pull?.headRefName === "string" && typeof pull?.baseRefName === "string" && typeof pull?.isDraft === "boolean", "Pull request has no supported current shape");
  assert(validTimestamp(pull?.updatedAt), "Pull request has no valid update timestamp");
  return pull;
}

async function issue({ repo, number, gh }) {
  const { stdout } = await callGh(gh, ["issue", "view", String(number), "--repo", repo, "--json", "number,url,state,labels,updatedAt"]);
  const targetIssue = parseJson(stdout, "Issue");
  assert(Number(targetIssue?.number) === number && isBoundedGitHubUrl(targetIssue?.url, `https://github.com/${repo}/issues/`) && targetIssue.url === `https://github.com/${repo}/issues/${number}` && validTimestamp(targetIssue?.updatedAt), "Issue metadata did not match the requested issue");
  return targetIssue;
}

async function pullRequestChecks({ repo, number, gh }) {
  const { stdout } = await callGh(gh, ["pr", "checks", String(number), "--repo", repo, "--json", "name,state,bucket"]);
  const checks = parseJson(stdout, "Pull request checks");
  assert(Array.isArray(checks), "Pull request checks returned invalid metadata");
  return checks;
}

async function graphql({ gh, query, variables }) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) args.push("-F", `${name}=${value}`);
  const { stdout } = await callGh(gh, args);
  return parseJson(stdout, "GitHub metadata");
}

async function currentMarkerComment({ repo, kind, number, marker, app, expectedRunUrl = null, notBefore = null, gh }) {
  const [owner, name] = repo.split("/");
  const object = kind === "issue" ? "issue" : "pullRequest";
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${object}(number:$number){comments(last:100){nodes{body updatedAt author{login ... on Bot{databaseId}}} pageInfo{hasNextPage}}}}}`;
  const payload = await graphql({ gh, query, variables: { owner, name, number } });
  const comments = payload?.data?.repository?.[object]?.comments;
  assert(Array.isArray(comments?.nodes) && comments.nodes.length <= 100 && comments?.pageInfo?.hasNextPage === false, "Marker-comment metadata exceeded its safe bound");
  const expectedEvidence = expectedRunUrl === null ? null : runEvidenceLine(expectedRunUrl);
  const owned = comments.nodes
    .filter((comment) => normaliseLogin(comment?.author?.login) === app.login && String(comment?.author?.databaseId ?? "") === app.id && typeof comment?.body === "string" && comment.body.endsWith(marker) && (expectedEvidence === null || comment.body.includes(expectedEvidence)))
    .map((comment) => ({ updatedAt: comment.updatedAt }));
  assert(owned.length === 1 && validTimestamp(owned[0].updatedAt) && (notBefore === null || happensOnOrAfter(owned[0].updatedAt, notBefore)), "Current App publication marker lacks a unique current App-owned publication record");
  return owned[0];
}

async function changedPullRequestPaths({ repo, number, gh }) {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){files(first:100){nodes{path} pageInfo{hasNextPage}}}}}";
  const payload = await graphql({ gh, query, variables: { owner, name, number } });
  const files = payload?.data?.repository?.pullRequest?.files;
  assert(Array.isArray(files?.nodes) && files.nodes.length <= 100 && files.pageInfo?.hasNextPage === false, "Pull request file metadata exceeded its safe bound");
  return files.nodes.map((file) => file?.path).filter((file) => typeof file === "string");
}

async function fixedPullRequestMetadata({ repo, number, gh }) {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url state mergedAt autoMergeRequest headRefName createdAt body author{login ... on Bot{databaseId}}}}}";
  const pull = (await graphql({ gh, query, variables: { owner, name, number } }))?.data?.repository?.pullRequest;
  assert(Number(pull?.number) === number && isBoundedGitHubUrl(pull?.url, `https://github.com/${repo}/pull/`) && pull.url === `https://github.com/${repo}/pull/${number}` && validTimestamp(pull?.createdAt), "Fix pull request metadata did not match the candidate");
  return pull;
}

async function configuredFixPolicy({ repo, revision, snapshot, expectedSource, gh }) {
  const source = snapshot
    ? await repositoryFileAtImmutableSnapshot({ repo, file: ".github/codekeeper.json", snapshot, expectedSource, gh })
    : await repositoryFile({ repo, file: ".github/codekeeper.json", ref: revision, gh });
  const config = parseJson(source, "Codekeeper policy");
  const prefix = config?.repository?.automationBranchPrefix;
  const repair = config?.audit?.repair;
  assert(typeof prefix === "string" && SAFE_PREFIX.test(prefix), "Target Codekeeper policy has no safe automation branch prefix");
  assert(config?.issues?.allowAiImplementation === true, "Target Codekeeper policy does not explicitly enable controlled issue implementation");
  assert(Array.isArray(repair?.allowedPaths) && repair.allowedPaths.length === FIXTURE_ALLOWED_FIX_PATHS.length && repair.allowedPaths.every((item) => FIXTURE_ALLOWED_FIX_PATHS.includes(item)), "Target Codekeeper policy must allow exactly the bounded fixture paths");
  assert(Array.isArray(repair?.validationCommands) && repair.validationCommands.includes("node --test test/*.test.mjs"), "Target Codekeeper policy must configure the deterministic fixture test command");
  return { prefix, source };
}

async function listOpenPulls({ repo, gh }) {
  const { stdout } = await callGh(gh, ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,url,headRefName,createdAt"]);
  const pulls = parseJson(stdout, "Open pull requests");
  assert(Array.isArray(pulls) && pulls.length <= 100, "Open pull requests returned invalid metadata");
  return pulls;
}

function validateScenarioOptions(scenario, options) {
  assert(MUTATING_SCENARIOS.has(scenario), "Unknown acceptance scenario");
  const commonOptions = new Set(["repo", "source-sha", "acknowledge-private-acceptance", "evidence", "fixture-checkout"]);
  const scenarioOptions = {
    "maintenance-dry-run": commonOptions,
    "review-introduced-defect": new Set([...commonOptions, "pr", "run-id", "app-login", "app-id"]),
    "issue-triage-related": new Set([...commonOptions, "issue", "run-id", "app-login", "app-id"]),
    "controlled-fix": new Set([...commonOptions, "issue", "app-login", "app-id"])
  }[scenario];
  assert(Object.keys(options).every((option) => scenarioOptions.has(option)), "Scenario command received an option that does not apply to this scenario");
  const result = {
    repo: validateRepositoryName(options.repo),
    sourceSha: validateSourceSha(options["source-sha"]),
    evidencePath: options.evidence,
    fixtureCheckout: options["fixture-checkout"]
  };
  assert(options["acknowledge-private-acceptance"] === true, "--acknowledge-private-acceptance is required before any scenario action");
  assert(typeof result.evidencePath === "string" && result.evidencePath.length > 0, "An explicit --evidence PATH is required");
  assert(typeof result.fixtureCheckout === "string" && result.fixtureCheckout.length > 0, "An explicit --fixture-checkout PATH is required to keep evidence out of the target checkout");
  if (scenario === "review-introduced-defect") {
    result.pr = validatePositiveInteger(options.pr, "--pr");
    result.runId = validatePositiveInteger(options["run-id"], "--run-id");
    result.app = validateAppIdentity(options);
  }
  if (scenario === "issue-triage-related") {
    result.issue = validatePositiveInteger(options.issue, "--issue");
    result.runId = validatePositiveInteger(options["run-id"], "--run-id");
    result.app = validateAppIdentity(options);
  }
  if (scenario === "controlled-fix") {
    result.issue = validatePositiveInteger(options.issue, "--issue");
    result.app = validateAppIdentity(options);
  }
  return result;
}

export async function preflight({ repo, gh }) {
  const target = validateRepositoryName(repo);
  await callGh(gh, ["auth", "status", "--hostname", "github.com"]);
  const { stdout: repositoryOutput } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${target}`]);
  const metadata = parseJson(repositoryOutput, "Repository preflight");
  const privateGitHubComTarget = metadata?.full_name === target
    && metadata?.name === target.split("/")[1]
    && metadata?.private === true
    && String(metadata?.visibility ?? "").toUpperCase() === "PRIVATE"
    && metadata?.html_url === `https://github.com/${target}`;
  assert(privateGitHubComTarget, "Target must be the explicit private GitHub.com acceptance repository");
  assert(typeof metadata?.default_branch === "string" && metadata.default_branch.length > 0, "Target repository has no default branch");
  const { stdout: actorOutput } = await callGh(gh, ["api", "--hostname", "github.com", "user", "--jq", ".login"]);
  const actorLogin = normaliseLogin(actorOutput);
  assert(/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(actorLogin), "GitHub.com authentication did not report a usable actor");
  return { repository: target, defaultBranch: metadata.default_branch, actorLogin };
}

async function verifyMaintenance({ request, preflightResult, gh, sleep, now, recordDispatchRef }) {
  const assertions = [];
  const prevalidated = await prevalidateDispatchSnapshot({ repo: request.repo, scenario: "maintenance-dry-run", sourceSha: request.sourceSha, preflight: preflightResult, gh });
  const snapshot = await createImmutableDispatchSnapshot({ repo: request.repo, scenario: "maintenance-dry-run", sourceSha: request.sourceSha, prevalidated, gh, onSnapshot: ({ dispatchRef }) => recordDispatchRef(dispatchRef) });
  const run = await dispatchAndWait({ repo: request.repo, scenario: "maintenance-dry-run", preflight: preflightResult, snapshot, gh, sleep, now });
  const jobs = await runJobs({ repo: request.repo, runId: run.databaseId, gh });
  const publication = jobs.filter((job) => String(job?.name ?? "").toLowerCase().includes("publish"));
  expect(assertions, "maintenance dry-run workflow completed successfully", run.conclusion === "success");
  expect(assertions, "maintenance dry-run has exactly one skipped publication job", publication.length === 1 && publication[0]?.conclusion === "skipped");
  expect(assertions, `maintenance dispatch retained immutable acceptance tag ${snapshot.dispatchRef}`, true);
  return { assertions, workflow: workflowEvidence(run), resource: null, dispatchRef: snapshot.dispatchRef, passed: assertions.every((assertion) => assertion.passed) };
}

function assertSupportedReviewShape(pull, defaultBranch) {
  assert(pull.state === "OPEN" && pull.isDraft === false && pull.isCrossRepository === false && pull.baseRefName === defaultBranch, "Review PR must remain open, non-draft, same-repository, and target the preflight default branch");
}

async function verifyReview({ request, preflightResult, gh, sleep }) {
  const assertions = [];
  const initialPull = await pullRequest({ repo: request.repo, number: request.pr, gh });
  assertSupportedReviewShape(initialPull, preflightResult.defaultBranch);
  const initialTitle = reviewRunTitle(request.pr, initialPull.headRefOid);
  const run = await waitForRun({ repo: request.repo, runId: request.runId, expectedEvent: SCENARIO_DETAILS["review-introduced-defect"].event, expectedWorkflowName: SCENARIO_DETAILS["review-introduced-defect"].workflowName, expectedDisplayTitle: initialTitle, gh, sleep });
  await assertPinnedSource({ repo: request.repo, scenario: "review-introduced-defect", sourceSha: request.sourceSha, revision: run.headSha, gh });
  const pull = await pullRequest({ repo: request.repo, number: request.pr, gh });
  assertSupportedReviewShape(pull, preflightResult.defaultBranch);
  assert(run.displayTitle === reviewRunTitle(request.pr, pull.headRefOid) && run.headSha === pull.headRefOid, "Review run no longer matches the PR's current immutable head");
  const [marker, checks] = await Promise.all([
    currentMarkerComment({ repo: request.repo, kind: "pull_request", number: request.pr, marker: REVIEW_MARKER, app: request.app, expectedRunUrl: expectedRunUrl(request.repo, run.databaseId), gh }),
    pullRequestChecks({ repo: request.repo, number: request.pr, gh })
  ]);
  expect(assertions, "introduced-defect pull request remains open, non-draft, same-repository, and targets the default branch", true);
  expect(assertions, "review run title and immutable head are bound to the requested pull request", run.headSha === pull.headRefOid && run.headBranch === pull.headRefName && run.displayTitle === reviewRunTitle(request.pr, pull.headRefOid));
  expect(assertions, "review workflow completed with the expected blocking conclusion", run.conclusion === "failure");
  expect(assertions, "blocking review state is accompanied by publisher evidence for this exact run", labelsFrom(pull).includes("codekeeper:blocked") && hasExactCheck(checks, "Codekeeper review gate", "fail"));
  expect(assertions, "review publication has one current canonical App marker correlated to the selected run URL", Boolean(marker));
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("pull_request", pull), passed: assertions.every((assertion) => assertion.passed) };
}

async function verifyIssue({ request, gh, sleep }) {
  const assertions = [];
  const run = await waitForRun({ repo: request.repo, runId: request.runId, expectedEvent: SCENARIO_DETAILS["issue-triage-related"].event, expectedWorkflowName: SCENARIO_DETAILS["issue-triage-related"].workflowName, expectedDisplayTitle: issueRunTitle(request.issue), gh, sleep });
  await assertPinnedSource({ repo: request.repo, scenario: "issue-triage-related", sourceSha: request.sourceSha, revision: run.headSha, gh });
  const targetIssue = await issue({ repo: request.repo, number: request.issue, gh });
  const marker = await currentMarkerComment({ repo: request.repo, kind: "issue", number: request.issue, marker: ISSUE_TRIAGE_MARKER, app: request.app, expectedRunUrl: expectedRunUrl(request.repo, run.databaseId), gh });
  const labels = labelsFrom(targetIssue);
  expect(assertions, "issue triage workflow title is bound to the requested issue", run.displayTitle === issueRunTitle(request.issue));
  expect(assertions, "issue triage workflow completed successfully", run.conclusion === "success");
  expect(assertions, "issue publication is bound to this run's exact App marker evidence", Boolean(marker));
  expect(assertions, "related issue remains open", targetIssue.state === "OPEN");
  expect(assertions, "related issue is not marked as a duplicate", !labels.includes("codekeeper:duplicate-candidate"));
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("issue", targetIssue), passed: assertions.every((assertion) => assertion.passed) };
}

async function verifyFix({ request, preflightResult, gh, sleep, now, recordDispatchRef }) {
  const assertions = [];
  const prevalidated = await prevalidateDispatchSnapshot({ repo: request.repo, scenario: "controlled-fix", sourceSha: request.sourceSha, preflight: preflightResult, gh });
  const snapshot = await createImmutableDispatchSnapshot({ repo: request.repo, scenario: "controlled-fix", sourceSha: request.sourceSha, prevalidated, gh, onSnapshot: ({ dispatchRef }) => recordDispatchRef(dispatchRef) });
  const { prefix } = await configuredFixPolicy({ repo: request.repo, snapshot, expectedSource: prevalidated.fixPolicy.source, gh });
  const existing = (await listOpenPulls({ repo: request.repo, gh })).filter((pull) => String(pull?.headRefName ?? "").startsWith(prefix));
  assert(existing.length === 0, "Target has an existing automation-prefix pull request; refusing an ambiguous fix scenario");
  const existingIds = new Set(existing.map((pull) => String(pull.number)));
  const run = await dispatchAndWait({ repo: request.repo, scenario: "controlled-fix", issue: request.issue, preflight: preflightResult, snapshot, gh, sleep, now });
  const candidates = (await listOpenPulls({ repo: request.repo, gh }))
    .filter((pull) => !existingIds.has(String(pull?.number)) && String(pull?.headRefName ?? "").startsWith(prefix) && happensOnOrAfter(pull?.createdAt, run.createdAt));
  assert(candidates.length === 1, "Expected exactly one newly created open Codekeeper fix pull request on the configured prefix");
  const candidate = candidates[0];
  const fingerprint = sha256(`issue|${request.repo}|${request.issue}`);
  const [pull, paths, jobs, marker] = await Promise.all([
    fixedPullRequestMetadata({ repo: request.repo, number: Number(candidate.number), gh }),
    changedPullRequestPaths({ repo: request.repo, number: Number(candidate.number), gh }),
    runJobs({ repo: request.repo, runId: run.databaseId, gh }),
    currentMarkerComment({ repo: request.repo, kind: "issue", number: request.issue, marker: repairNotificationMarker(fingerprint), app: request.app, notBefore: run.startedAt, gh })
  ]);
  const expectedBranch = branchSlug(`${prefix}fix-${fingerprint}`);
  expect(assertions, "controlled fix workflow completed successfully", run.conclusion === "success");
  expect(assertions, "fix pull request is open, App-owned, and not auto-merged", pull.state === "OPEN" && !pull.mergedAt && pull.autoMergeRequest == null && normaliseLogin(pull?.author?.login) === request.app.login && String(pull?.author?.databaseId ?? "") === request.app.id);
  expect(assertions, "fix pull request is the canonical repair for the requested issue", pull.headRefName === expectedBranch && typeof pull.body === "string" && pull.body.includes(`Closes #${request.issue}`) && pull.body.endsWith(repairMarker(fingerprint)) && happensOnOrAfter(marker.updatedAt, run.startedAt));
  expect(assertions, "fix changed only bounded fixture paths", paths.length > 0 && paths.every((changedPath) => FIXTURE_ALLOWED_FIX_PATHS.includes(changedPath)));
  expect(assertions, "fixture tests passed in Codekeeper verification", jobs.some((job) => String(job?.name ?? "").toLowerCase().includes("implementation verification") && job?.conclusion === "success"));
  expect(assertions, `controlled fix dispatch retained immutable acceptance tag ${snapshot.dispatchRef}`, true);
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("pull_request", pull), dispatchRef: snapshot.dispatchRef, passed: assertions.every((assertion) => assertion.passed) };
}

export async function runScenario({ scenario, options, gh, now = () => new Date(), sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }) {
  const request = validateScenarioOptions(scenario, options);
  const destination = await prepareEvidenceDestination({ evidencePath: request.evidencePath, fixtureCheckout: request.fixtureCheckout });
  const startedAt = currentIso(now);
  let dispatchRef = null;
  let result = {
    assertions: [{ expectation: "scenario completed without an unredacted operational error", passed: false }],
    workflow: null,
    resource: null,
    dispatchRef: null,
    passed: false
  };
  try {
    const preflightResult = await preflight({ repo: request.repo, gh });
    if (scenario === "maintenance-dry-run") result = await verifyMaintenance({ request, preflightResult, gh, sleep, now, recordDispatchRef: (value) => { dispatchRef = value; } });
    if (scenario === "review-introduced-defect") result = await verifyReview({ request, preflightResult, gh, sleep });
    if (scenario === "issue-triage-related") result = await verifyIssue({ request, gh, sleep });
    if (scenario === "controlled-fix") result = await verifyFix({ request, preflightResult, gh, sleep, now, recordDispatchRef: (value) => { dispatchRef = value; } });
    result.passed = result.passed !== false;
  } catch {
    result.passed = false;
  }
  const evidence = {
    schemaVersion: 1,
    targetRepository: request.repo,
    scenario,
    sourceSha: request.sourceSha,
    dispatchRef: result.dispatchRef ?? dispatchRef,
    workflow: result.workflow,
    resource: result.resource,
    assertions: result.assertions,
    passed: result.passed,
    startedAt,
    completedAt: currentIso(now)
  };
  const evidencePath = await writeEvidenceAtomically({ evidence, destination });
  return { passed: result.passed, evidence, evidencePath };
}

export function parseCommandLine(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") return { command: "help", options: {} };
  const [command, ...tokens] = argv;
  assert(command === "preflight" || MUTATING_SCENARIOS.has(command), `Unknown command: ${command}`);
  const options = {};
  const booleanFlags = new Set(["acknowledge-private-acceptance"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    assert(token.startsWith("--"), `Unexpected positional argument: ${token}`);
    const name = token.slice(2);
    assert(name.length > 0 && !(name in options), `Duplicate or invalid option: ${token}`);
    if (booleanFlags.has(name)) {
      options[name] = true;
      continue;
    }
    const value = tokens[index + 1];
    assert(value !== undefined && !value.startsWith("--"), `Option ${token} requires a value`);
    options[name] = value;
    index += 1;
  }
  if (command === "preflight") {
    assert(Object.keys(options).length === 1 && typeof options.repo === "string", "preflight requires exactly --repo OWNER/REPOSITORY");
    return { command, options };
  }
  const permitted = new Set(["repo", "source-sha", "acknowledge-private-acceptance", "evidence", "fixture-checkout", "pr", "issue", "run-id", "app-login", "app-id"]);
  assert(Object.keys(options).every((option) => permitted.has(option)), "Scenario command received an unsupported option");
  return { command, options };
}

export function formatUsage() {
  const fixture = path.dirname(fileURLToPath(import.meta.url));
  return `Codekeeper private acceptance harness (Node >=22)\n\nRead-only:\n  node ${path.join(fixture, "../bin/codekeeper-acceptance.mjs")} preflight --repo OWNER/codekeeper-acceptance-NAME\n\nScenario commands require --repo, --source-sha (40-character commit),\n--acknowledge-private-acceptance, --fixture-checkout, and --evidence PATH.\nReview, issue, and fix verification also require the configured App bot login\nand immutable numeric --app-id.\n\nMaintenance and fix dispatch create one retained unique acceptance tag at the\npreflight default-branch SHA; GitHub workflow_dispatch receives that tag, never\na raw SHA. The evidence records the tag and the harness never deletes it.\n\n  maintenance-dry-run\n  review-introduced-defect --pr NUMBER --run-id NUMBER --app-login APP[bot] --app-id NUMBER\n  issue-triage-related --issue NUMBER --run-id NUMBER --app-login APP[bot] --app-id NUMBER\n  controlled-fix --issue NUMBER --app-login APP[bot] --app-id NUMBER`;
}
