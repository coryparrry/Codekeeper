import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareEvidenceDestination, writeEvidenceAtomically } from "./evidence.mjs";

const PRIVATE_REPOSITORY_PREFIX = "codekeeper-acceptance-";
const DURABLE_PRIVATE_REPOSITORY = "codekeeper-test-environment";
const SHA_PATTERN = "[0-9A-Fa-f]{40}";
const REPOSITORY_PATTERN = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const SHA = new RegExp(`^${SHA_PATTERN}$`, "i");
const REPOSITORY = new RegExp(`^${REPOSITORY_PATTERN}$`);
const PACKAGE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA512_INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const ISO_8601_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_PREFIX = /^(?!\/)(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+$/;
const MAX_REPOSITORY_LENGTH = 140;
const MAX_GITHUB_URL_LENGTH = 2048;
const MAX_GH_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_GH_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_GH_KILL_GRACE_MS = 1_000;
const DISPATCH_DISCOVERY_POLL_INTERVAL_MS = 3_000;
const DISPATCH_DISCOVERY_POLL_ATTEMPTS = 20;
const MAX_WORKFLOW_RUNS = 1_000;
const WORKFLOW_RUN_PAGE_SIZE = 100;
const MAX_WORKFLOW_RUN_PAGES = MAX_WORKFLOW_RUNS / WORKFLOW_RUN_PAGE_SIZE;
export const WORKFLOW_COMPLETION_POLL_INTERVAL_MS = 5_000;
export const WORKFLOW_COMPLETION_TIMEOUT_MS = 10 * 60_000;
export const WORKFLOW_COMPLETION_POLL_ATTEMPTS = (WORKFLOW_COMPLETION_TIMEOUT_MS / WORKFLOW_COMPLETION_POLL_INTERVAL_MS) + 1;
const ACCEPTANCE_TAG_PREFIX = "codekeeper-acceptance/dispatch-";
const MAX_ACCEPTANCE_TAG_LENGTH = 160;
const CONTROLLED_FIX_RECOVERY_COMMAND = "recover-controlled-fix";
const CONTROLLED_FIX_DISPATCH_REF = /^codekeeper-acceptance\/dispatch-controlled-fix-([0-9a-f]{12})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVIEW_MARKER = "<!-- codekeeper:review -->";
const ISSUE_TRIAGE_MARKER = "<!-- codekeeper:issue-triage -->";
const MUTATING_SCENARIOS = new Set([
  "maintenance-dry-run",
  "review-introduced-defect",
  "issue-triage-related",
  "issue-resolved-by-pr",
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
  "issue-resolved-by-pr": {
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
const CALLER_JOB_BY_WORKFLOW = Object.freeze({
  "codekeeper-maintain.yml": "maintain",
  "codekeeper-review.yml": "review",
  "codekeeper-issues.yml": "triage",
  "codekeeper-fix.yml": "fix"
});

export const FIXTURE_ALLOWED_FIX_PATHS = Object.freeze(["src/discount.mjs", "test/discount.test.mjs"]);

export class AcceptanceError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AcceptanceError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validatePackageRelease(value) {
  const integrityMatch = SHA512_INTEGRITY.exec(value?.integrity ?? "");
  const digest = integrityMatch ? Buffer.from(integrityMatch[1], "base64") : null;
  assert(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && value.name === "@coryparry/codekeeper"
      && typeof value.version === "string"
      && PACKAGE_VERSION.test(value.version)
      && digest?.length === 64
      && digest.toString("base64").replace(/=+$/, "") === integrityMatch[1].replace(/=+$/, ""),
    "Caller workflow requires a valid exact Codekeeper package receipt"
  );
  return Object.freeze({ name: value.name, version: value.version, integrity: value.integrity });
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

function validBranchName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
    && !value.includes("..")
    && !value.includes("@{")
    && !value.includes("//")
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && value.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
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
  return typeof value === "string"
    && ISO_8601_INSTANT.test(value)
    && Number.isFinite(Date.parse(value));
}

function happensOnOrAfter(value, boundary) {
  return validTimestamp(value) && validTimestamp(boundary) && Date.parse(value) >= Date.parse(boundary);
}

function happensOnOrBefore(value, boundary) {
  return validTimestamp(value) && validTimestamp(boundary) && Date.parse(value) <= Date.parse(boundary);
}

function normaliseLogin(value) {
  return String(value ?? "").trim().toLowerCase();
}

function canonicalAppBotLogin(value) {
  const login = normaliseLogin(value);
  return login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;
}

function validateRepositoryName(repo) {
  assert(typeof repo === "string" && repo.length <= MAX_REPOSITORY_LENGTH && REPOSITORY.test(repo), "An explicit --repo OWNER/REPOSITORY is required; implicit or current repositories are rejected");
  const [owner, name] = repo.split("/");
  assert(owner.length <= 39 && name.length <= 100, "Target repository name exceeds GitHub's bounded repository limits");
  assert(
    name === DURABLE_PRIVATE_REPOSITORY || name.startsWith(PRIVATE_REPOSITORY_PREFIX),
    `Target repository name must be ${DURABLE_PRIVATE_REPOSITORY} or begin with ${PRIVATE_REPOSITORY_PREFIX}`
  );
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

function validateTimestamp(value, option) {
  assert(validTimestamp(value), `${option} must be an ISO-8601 timestamp`);
  return new Date(value).toISOString();
}

function validateControlledFixDispatchRef(value) {
  assert(typeof value === "string" && value.length <= MAX_ACCEPTANCE_TAG_LENGTH && CONTROLLED_FIX_DISPATCH_REF.test(value), "--dispatch-ref must be the exact retained controlled-fix acceptance tag");
  return value;
}

function validateAppIdentity(options) {
  const suppliedLogin = normaliseLogin(options["app-login"]);
  assert(/^[a-z0-9](?:[a-z0-9-]{0,38})?\[bot\]$/.test(suppliedLogin), "--app-login must be an explicit GitHub App bot login ending in [bot]");
  return { login: canonicalAppBotLogin(suppliedLogin), id: String(validatePositiveInteger(options["app-id"], "--app-id")) };
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

function stripYamlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function unquotedYamlText(value) {
  let quote = null;
  let escaped = false;
  let result = "";
  for (const character of value) {
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      result += " ";
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = null;
      result += " ";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += " ";
      continue;
    }
    result += character;
  }
  assert(quote === null, "Caller workflow contains an unterminated quoted scalar");
  return result;
}

function yamlLine(rawLine) {
  const uncommented = stripYamlComment(rawLine);
  if (!uncommented.trim()) return null;
  assert(!uncommented.includes("\t"), "Caller workflow contains unsupported YAML indentation");
  const indentation = /^( *)/.exec(uncommented)[1].length;
  assert(indentation % 2 === 0, "Caller workflow contains unsupported YAML indentation");
  const content = uncommented.slice(indentation).trimEnd();
  const unquoted = unquotedYamlText(content);
  assert(
    !/(^|[\s:[{,}-])[*&][A-Za-z_][A-Za-z0-9_-]*(?=$|[\s,}\]])/.test(unquoted),
    "Caller workflow does not support YAML anchors or aliases"
  );
  assert(!/:\s*![^\s]+(?:\s|$)/.test(unquoted), "Caller workflow does not support YAML tags");
  const withoutExpressions = unquoted.replace(/\$\{\{.*?\}\}/g, "");
  assert(!/[{}]/.test(withoutExpressions), "Caller workflow does not support YAML flow mappings");
  assert(!/^(?:[-?]\s*$|[?]\s+|:\s)/.test(unquoted), "Caller workflow contains an unsupported YAML collection entry");
  return { indentation, content, blockScalar: /:\s*[>|][+-]?\d*\s*$/.test(unquoted) };
}

function yamlMapping(line) {
  const match = /^(?<sequence>-\s+)?(?<key>[A-Za-z0-9_-]+)\s*:\s*(?<value>.*)$/.exec(line.content);
  if (match) return { sequence: Boolean(match.groups.sequence), key: match.groups.key, value: match.groups.value };
  assert(!/^(?:"uses"|'uses')\s*:/.test(line.content), "Caller workflow contains an unsupported quoted uses key");
  return null;
}

function yamlScalar(value) {
  const trimmed = value.trim();
  assert(trimmed.length > 0, "Caller workflow uses entries require a scalar value");
  if (trimmed.startsWith('"')) {
    const match = /^"([^"\\]+)"$/.exec(trimmed);
    assert(match, "Caller workflow uses entries require a plain immutable scalar");
    return match[1];
  }
  if (trimmed.startsWith("'")) {
    const match = /^'([^']+)'$/.exec(trimmed);
    assert(match, "Caller workflow uses entries require a plain immutable scalar");
    return match[1];
  }
  assert(!/[\s"'{}[\],]/.test(trimmed), "Caller workflow uses entries require a plain immutable scalar");
  return trimmed;
}

function expectedCallerJob(workflow) {
  const job = CALLER_JOB_BY_WORKFLOW[workflow];
  assert(job, "Caller workflow is missing its expected Codekeeper workflow name");
  return job;
}

function recordUse(entries, mapping, location) {
  if (mapping.key !== "uses") return;
  entries.push({ ...location, value: yamlScalar(mapping.value) });
}

function unsupportedUse(mapping) {
  if (mapping?.key === "uses") throw new AcceptanceError("Caller workflow contains a uses entry outside the supported local reusable-workflow location");
}

export function parsePinnedWorkflowUses(yaml, workflow, packageRelease) {
  const reusableJob = expectedCallerJob(workflow);
  const expectedPackage = validatePackageRelease(packageRelease);

  let jobsIndent = null;
  let currentJob = null;
  let steps = null;
  let withInputs = null;
  let currentStepIndent = null;
  let sawJobs = false;
  const jobNames = new Set();
  const entries = [];
  const expectedJobs = new Map();
  let blockScalarIndent = null;

  for (const rawLine of String(yaml).split(/\r?\n/)) {
    if (blockScalarIndent !== null) {
      if (!rawLine.trim()) continue;
      const rawIndentation = /^( *)/.exec(rawLine)[1].length;
      if (rawIndentation > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    const line = yamlLine(rawLine);
    if (!line) continue;
    if (line.blockScalar) blockScalarIndent = line.indentation;
    const mapping = yamlMapping(line);

    if (jobsIndent === null) {
      if (line.indentation === 0 && mapping?.key === "jobs") {
        assert(!mapping.sequence && mapping.value.trim() === "", "Caller workflow must use a block-style jobs mapping");
        assert(!sawJobs, "Caller workflow contains duplicate jobs mappings");
        sawJobs = true;
        jobsIndent = line.indentation;
        continue;
      }
      unsupportedUse(mapping);
      continue;
    }

    if (line.indentation <= jobsIndent) {
      jobsIndent = null;
      currentJob = null;
      steps = null;
      withInputs = null;
      currentStepIndent = null;
      if (line.indentation === 0 && mapping?.key === "jobs") {
        assert(false, "Caller workflow contains duplicate jobs mappings");
      }
      unsupportedUse(mapping);
      continue;
    }

    if (line.indentation === jobsIndent + 2) {
      assert(mapping && !mapping.sequence && mapping.value.trim() === "", "Caller workflow contains an unsupported job mapping");
      assert(!jobNames.has(mapping.key), "Caller workflow contains duplicate job names");
      jobNames.add(mapping.key);
      currentJob = { name: mapping.key, indentation: line.indentation, stepsSeen: false, needs: [], conditions: [], inputs: new Map() };
      if (mapping.key === reusableJob) expectedJobs.set(mapping.key, currentJob);
      steps = null;
      withInputs = null;
      currentStepIndent = null;
      continue;
    }

    assert(currentJob !== null, "Caller workflow contains an unsupported jobs structure");
    if (line.indentation === currentJob.indentation + 2) {
      assert(mapping && !mapping.sequence, "Caller workflow contains an unsupported job property");
      if (mapping.key === "if" && currentJob.name === reusableJob) {
        currentJob.conditions.push(mapping.value.trim());
      }
      if (mapping.key === "needs" && currentJob.name === reusableJob) {
        currentJob.needs.push(mapping.value.trim());
      }
      if (mapping.key === "steps") {
        assert(mapping.value.trim() === "" && !currentJob.stepsSeen, "Caller workflow contains an unsupported steps mapping");
        currentJob.stepsSeen = true;
        steps = { indentation: line.indentation };
        withInputs = null;
        currentStepIndent = null;
      } else if (mapping.key === "with") {
        assert(mapping.value.trim() === "" && withInputs === null, "Caller workflow contains an unsupported with mapping");
        withInputs = { indentation: line.indentation, job: currentJob };
        steps = null;
        currentStepIndent = null;
      } else {
        recordUse(entries, mapping, { kind: "job", job: currentJob.name });
        steps = null;
        withInputs = null;
        currentStepIndent = null;
      }
      continue;
    }

    if (withInputs && line.indentation === withInputs.indentation + 2) {
      assert(mapping && !mapping.sequence, "Caller workflow contains an unsupported reusable-workflow input");
      unsupportedUse(mapping);
      assert(!withInputs.job.inputs.has(mapping.key), "Caller workflow contains duplicate reusable-workflow inputs");
      withInputs.job.inputs.set(mapping.key, mapping.value.trim());
      continue;
    }

    if (steps && line.indentation === steps.indentation + 2) {
      assert(mapping?.sequence, "Caller workflow contains an unsupported step mapping");
      const step = { hasIf: mapping.key === "if" };
      recordUse(entries, mapping, { kind: "step", job: currentJob.name, step });
      currentStepIndent = line.indentation;
      steps.current = step;
      continue;
    }

    if (steps && currentStepIndent !== null && line.indentation === currentStepIndent + 2) {
      assert(mapping && !mapping.sequence, "Caller workflow contains an unsupported step property");
      if (mapping.key === "if") steps.current.hasIf = true;
      recordUse(entries, mapping, { kind: "step", job: currentJob.name, step: steps.current });
      continue;
    }

    unsupportedUse(mapping);
  }

  assert(sawJobs, "Caller workflow is missing a supported jobs mapping");
  assert(entries.length === 1, "Caller workflow must contain exactly one local Codekeeper reusable-workflow uses entry");
  const reusableEntries = entries.filter((entry) => entry.kind === "job" && entry.job === reusableJob);
  assert(reusableEntries.length === 1, "Caller workflow must contain exactly one Codekeeper reusable-workflow call");
  const reusableJobDefinition = expectedJobs.get(reusableJob);
  const simpleDependencyShape = reusableJobDefinition
    && reusableJobDefinition.needs.length === 0
    && reusableJobDefinition.conditions.length === 0;
  const routedReviewShape = workflow === "codekeeper-review.yml"
    && reusableJobDefinition
    && reusableJobDefinition.needs.length === 1
    && reusableJobDefinition.needs[0] === "intent"
    && reusableJobDefinition.conditions.length === 1
    && reusableJobDefinition.conditions[0] === "needs.intent.outputs.route == 'true'";
  assert(simpleDependencyShape || routedReviewShape, "Caller workflow must use the exact supported Codekeeper dependency and routing shape");

  const expectedRuntime = `./.github/workflows/codekeeper-runtime-${reusableJob === "triage" ? "issues" : reusableJob}.yml`;
  assert(
    reusableEntries[0].value === expectedRuntime,
    "Caller workflow must invoke the expected local Codekeeper runtime workflow"
  );
  const packageVersion = yamlScalar(reusableJobDefinition.inputs.get("package_version") ?? "");
  const packageIntegrity = yamlScalar(reusableJobDefinition.inputs.get("package_integrity") ?? "");
  assert(
    packageVersion === expectedPackage.version && packageIntegrity === expectedPackage.integrity,
    "Caller workflow package receipt must exactly match the installed Codekeeper release"
  );
  return true;
}

export function parseEventCallerRunName(yaml, scenario) {
  const expected = scenario === "review-introduced-defect"
    ? 'run-name: "Codekeeper review #${{ github.event.pull_request.number || github.event.client_payload.number }} @${{ github.event.pull_request.head.sha || github.event.client_payload.head_sha }}"'
    : scenario === "issue-triage-related" || scenario === "issue-resolved-by-pr"
      ? 'run-name: "Codekeeper issue triage #${{ github.event.issue.number || github.event.client_payload.number }}"'
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

function releasePackageReceipt(source, sourceSha) {
  const manifest = parseJson(source, "Codekeeper release manifest");
  assert(
    manifest?.version === 2
      && typeof manifest?.source?.repository === "string"
      && REPOSITORY.test(manifest.source.repository)
      && typeof manifest?.source?.commit === "string"
      && SHA.test(manifest.source.commit)
      && manifest.source.commit.toLowerCase() === sourceSha.toLowerCase(),
    "Codekeeper release manifest must prove the supplied immutable source SHA"
  );
  return validatePackageRelease(manifest.package);
}

async function assertPinnedRelease({ repo, scenario, sourceSha, revision, snapshot, expectedSource, gh }) {
  const workflow = SCENARIO_DETAILS[scenario].workflow;
  const file = `.github/workflows/${workflow}`;
  const releaseFile = ".github/codekeeper-release.json";
  const [source, releaseSource] = snapshot
    ? await Promise.all([
      repositoryFileAtImmutableSnapshot({ repo, file, snapshot, expectedSource: expectedSource?.callerSource, gh }),
      repositoryFileAtImmutableSnapshot({ repo, file: releaseFile, snapshot, expectedSource: expectedSource?.releaseSource, gh })
    ])
    : await Promise.all([
      repositoryFile({ repo, file, ref: revision, gh }),
      repositoryFile({ repo, file: releaseFile, ref: revision, gh })
    ]);
  parsePinnedWorkflowUses(source, workflow, releasePackageReceipt(releaseSource, sourceSha));
  if (scenario === "review-introduced-defect" || scenario === "issue-triage-related" || scenario === "issue-resolved-by-pr") {
    parseEventCallerRunName(source, scenario);
  }
  return { callerSource: source, releaseSource };
}

async function listWorkflowRuns({ repo, workflow, event, gh }) {
  const runs = [];
  let totalCount = null;
  for (let page = 1; page <= MAX_WORKFLOW_RUN_PAGES && runs.length < Math.min(totalCount ?? MAX_WORKFLOW_RUNS, MAX_WORKFLOW_RUNS); page += 1) {
    const endpoint = `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=${encodeURIComponent(event)}&per_page=${WORKFLOW_RUN_PAGE_SIZE}&page=${page}`;
    const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", endpoint]);
    const payload = parseJson(stdout, "Workflow run list");
    assert(Number.isSafeInteger(payload?.total_count) && payload.total_count >= 0, "Workflow run list returned invalid metadata");
    if (totalCount === null) totalCount = payload.total_count;
    assert(payload.total_count === totalCount, "Workflow run inventory changed during pagination");
    assert(Array.isArray(payload?.workflow_runs) && payload.workflow_runs.length <= WORKFLOW_RUN_PAGE_SIZE, "Workflow run list returned invalid metadata");
    if (totalCount > MAX_WORKFLOW_RUNS) {
      return { runs: [], paginationComplete: false };
    }
    for (const entry of payload.workflow_runs) {
      runs.push({
        databaseId: entry?.id,
        attempt: entry?.run_attempt,
        status: entry?.status,
        createdAt: entry?.created_at,
        updatedAt: entry?.updated_at,
        headSha: entry?.head_sha,
        headBranch: entry?.head_branch,
        displayTitle: entry?.display_title
      });
    }
    if (payload.workflow_runs.length === 0) break;
  }
  const validated = runs.map((run) => {
    assert(Number.isInteger(run?.databaseId) && run.databaseId > 0, "Workflow run list has an invalid run identifier");
    assert(Number.isInteger(run?.attempt) && run.attempt > 0, "Workflow run list has an invalid attempt");
    assert(typeof run?.status === "string" && run.status.length > 0, "Workflow run list has an invalid status");
    assert(validTimestamp(run?.createdAt) && validTimestamp(run?.updatedAt), "Workflow run list has invalid timestamps");
    assert(typeof run?.headSha === "string" && SHA.test(run.headSha) && typeof run?.headBranch === "string" && run.headBranch.length > 0, "Workflow run list has no immutable revision");
    assert(typeof run?.displayTitle === "string" && run.displayTitle.length > 0 && run.displayTitle.length <= 180, "Workflow run list has an invalid display title");
    return run;
  });
  return { runs: validated, paginationComplete: validated.length === totalCount };
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

async function waitForRun({ repo, runId, expectedEvent, expectedWorkflowName, expectedDisplayTitle, gh, sleep, now = () => new Date(), boundary = null, beforePoll = null, timeoutMs = WORKFLOW_COMPLETION_TIMEOUT_MS, attempts = WORKFLOW_COMPLETION_POLL_ATTEMPTS }) {
  assert(typeof expectedDisplayTitle === "string" && expectedDisplayTitle.length > 0, "An expected workflow display title is required");
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, "Workflow completion timeout must be positive");
  assert(Number.isInteger(attempts) && attempts > 0, "Workflow completion polling must have a positive bounded attempt count");
  const startedAt = now().getTime();
  assert(Number.isFinite(startedAt), "Workflow completion clock is invalid");
  const elapsedWithinDeadline = () => {
    const elapsed = now().getTime() - startedAt;
    assert(Number.isFinite(elapsed) && elapsed >= 0, "Workflow completion clock moved backwards or became invalid");
    assert(elapsed <= timeoutMs, "Workflow run did not complete within the bounded acceptance wait");
    return elapsed;
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    elapsedWithinDeadline();
    if (beforePoll) await beforePoll();
    elapsedWithinDeadline();
    const { stdout } = await callGh(gh, [
      "run", "view", String(runId), "--repo", repo,
      "--json", "databaseId,url,conclusion,status,workflowName,headSha,headBranch,createdAt,startedAt,updatedAt,attempt,displayTitle"
    ]);
    elapsedWithinDeadline();
    const view = parseJson(stdout, "Workflow run");
    assert(String(view.databaseId) === String(runId), "Workflow run did not match the explicit run identifier");
    assert(view.workflowName === expectedWorkflowName, "Workflow run did not match the expected Codekeeper workflow");
    assert(view.displayTitle === expectedDisplayTitle, "Workflow run did not match the durable expected display title");
    assert(Number.isInteger(view.attempt) && view.attempt > 0, "Workflow run has an invalid attempt");
    if (view.status === "completed") {
      const metadata = await workflowRunMetadata({ repo, runId, gh });
      elapsedWithinDeadline();
      assert(metadata.event === expectedEvent, "Workflow run event did not match the acceptance scenario");
      assert(view.url === metadata.url, "Workflow run URL did not match GitHub metadata");
      assert(view.headSha === metadata.headSha && view.headBranch === metadata.headBranch && view.displayTitle === metadata.displayTitle && view.attempt === metadata.attempt && view.status === metadata.status && view.updatedAt === metadata.updatedAt, "Workflow run view did not match immutable GitHub metadata");
      const run = { ...view, ...metadata, startedAt: view.startedAt || metadata.createdAt };
      assert(validTimestamp(run.startedAt), "Workflow run has no valid start timestamp");
      if (boundary) {
        if (boundary.headSha !== undefined || boundary.headBranch !== undefined || boundary.displayTitle !== undefined) {
          assert(run.headSha === boundary.headSha && run.headBranch === boundary.headBranch && run.displayTitle === boundary.displayTitle, "Workflow run did not use the recorded dispatch revision");
        }
        assert(happensOnOrAfter(run.createdAt, boundary.dispatchedAt), "Workflow run predates the recorded dispatch boundary");
        if (boundary.actorLogin !== undefined) assert(run.actorLogin === boundary.actorLogin, "Workflow run actor did not match the authenticated dispatcher");
      }
      elapsedWithinDeadline();
      return run;
    }
    const elapsed = elapsedWithinDeadline();
    if (attempt < attempts - 1 && elapsed < timeoutMs) await sleep(Math.min(WORKFLOW_COMPLETION_POLL_INTERVAL_MS, timeoutMs - elapsed));
  }
  throw new AcceptanceError("Workflow run did not complete within the bounded acceptance wait");
}

async function defaultBranchRevision({ repo, defaultBranch, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/git/ref/heads/${defaultBranch}`]);
  const payload = parseJson(stdout, "Default branch ref");
  assert(typeof payload?.object?.sha === "string" && SHA.test(payload.object.sha), "Default branch ref has no immutable SHA");
  return payload.object.sha;
}

function assertQuiescent(page) {
  assert(page.paginationComplete, "Workflow run pagination exceeded the bounded acceptance inventory");
  assert(page.runs.every((run) => run?.status === "completed"), "Target workflow is not quiescent; refusing a concurrent scenario");
}

async function acceptanceTagRef({ repo, tag, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`]);
  const payload = parseJson(stdout, "Acceptance tag ref");
  assert(payload?.ref === `refs/tags/${tag}` && payload?.object?.type === "commit" && typeof payload?.object?.sha === "string" && SHA.test(payload.object.sha), "Acceptance tag ref is invalid");
  return payload.object.sha.toLowerCase();
}

async function prevalidateDispatchSnapshot({ repo, scenario, sourceSha, preflight, gh }) {
  const headSha = (await defaultBranchRevision({ repo, defaultBranch: preflight.defaultBranch, gh })).toLowerCase();
  const callerEvidence = await assertPinnedRelease({ repo, scenario, sourceSha, revision: headSha, gh });
  const fixPolicy = scenario === "controlled-fix"
    ? await configuredFixPolicy({ repo, revision: headSha, gh })
    : null;
  return { headSha, callerEvidence, fixPolicy };
}

async function createImmutableDispatchSnapshot({ repo, scenario, sourceSha, prevalidated, gh, onSnapshot = () => {} }) {
  const headSha = prevalidated.headSha;
  const dispatchRef = acceptanceTagName(scenario, headSha);
  await callGh(gh, ["api", "--hostname", "github.com", "--method", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/tags/${dispatchRef}`, "-f", `sha=${headSha}`]);
  const snapshot = { headSha, dispatchRef };
  onSnapshot(snapshot);
  assert(await acceptanceTagRef({ repo, tag: dispatchRef, gh }) === headSha, "Acceptance tag did not resolve to the recorded default-branch SHA");
  await assertPinnedRelease({ repo, scenario, sourceSha, snapshot, expectedSource: prevalidated.callerEvidence, gh });
  return snapshot;
}

function revalidateBaselineRuns({ baseline, observedRuns, dispatchedAt }) {
  const observedById = new Map(observedRuns.map((run) => [String(run.databaseId), run]));
  for (const prior of baseline) {
    const observed = observedById.get(String(prior.databaseId));
    assert(observed && observed.attempt === prior.attempt && observed.status === prior.status && observed.updatedAt === prior.updatedAt, "A baseline workflow run changed or disappeared after the dispatch boundary");
    assert(!happensOnOrAfter(observed.updatedAt, dispatchedAt), "A baseline workflow run overlaps the dispatch boundary");
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
  const baselinePage = await listWorkflowRuns({ repo, workflow: detail.workflow, event: detail.event, gh });
  assertQuiescent(baselinePage);
  const baseline = baselinePage.runs;
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

  let selectedRunId = null;
  const observeDispatchRuns = async () => {
    const page = await listWorkflowRuns({ repo, workflow: detail.workflow, event: detail.event, gh });
    assert(page.paginationComplete, "Workflow run pagination exceeded the bounded acceptance inventory");
    const runs = page.runs;
    revalidateBaselineRuns({ baseline, observedRuns: runs, dispatchedAt: boundary.dispatchedAt });
    const candidates = runs.filter((run) => !boundary.baselineIds.has(String(run.databaseId)) && matchesDispatchBoundary(run, boundary));
    assert(candidates.length <= 1, "Concurrent workflow runs made dispatch attribution ambiguous");
    if (selectedRunId === null) {
      if (candidates.length === 0) return null;
      selectedRunId = String(candidates[0].databaseId);
      return candidates[0];
    }
    assert(candidates.length === 1 && String(candidates[0].databaseId) === selectedRunId, "Selected workflow run no longer has unique dispatch attribution");
    return candidates[0];
  };

  for (let attempt = 0; attempt < DISPATCH_DISCOVERY_POLL_ATTEMPTS; attempt += 1) {
    const candidate = await observeDispatchRuns();
    if (candidate) {
      const run = await waitForRun({ repo, runId: candidate.databaseId, expectedEvent: detail.event, expectedWorkflowName: detail.workflowName, expectedDisplayTitle: boundary.displayTitle, gh, sleep, now, boundary, beforePoll: observeDispatchRuns });
      await observeDispatchRuns();
      assert(await acceptanceTagRef({ repo, tag: snapshot.dispatchRef, gh }) === snapshot.headSha, "Acceptance tag changed while waiting for the workflow run");
      return run;
    }
    if (attempt < DISPATCH_DISCOVERY_POLL_ATTEMPTS - 1) await sleep(DISPATCH_DISCOVERY_POLL_INTERVAL_MS);
  }
  throw new AcceptanceError("A unique dispatched workflow run was not observed within the bounded acceptance wait");
}

async function runJobs({ repo, runId, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  const payload = parseJson(stdout, "Workflow jobs");
  assert(Number.isInteger(payload?.total_count) && payload.total_count >= 0 && payload.total_count <= 100 && Array.isArray(payload?.jobs) && payload.jobs.length === payload.total_count, "Workflow jobs exceeded the safe single-page bound or returned invalid metadata");
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

async function currentMarkerComment({ repo, kind, number, marker, app, expectedRunUrl = null, expectedBody = null, notBefore = null, notAfter = null, gh }) {
  const [owner, name] = repo.split("/");
  const object = kind === "issue" ? "issue" : "pullRequest";
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${object}(number:$number){comments(last:100){nodes{body updatedAt author{login ... on Bot{databaseId}}} pageInfo{hasPreviousPage hasNextPage}}}}}`;
  const payload = await graphql({ gh, query, variables: { owner, name, number } });
  const comments = payload?.data?.repository?.[object]?.comments;
  assert(Array.isArray(comments?.nodes) && comments.nodes.length <= 100 && comments?.pageInfo?.hasPreviousPage === false && comments?.pageInfo?.hasNextPage === false, "Marker-comment metadata exceeded its safe single-page bound");
  const expectedEvidence = expectedRunUrl === null ? null : runEvidenceLine(expectedRunUrl);
  const owned = comments.nodes
    .filter((comment) => canonicalAppBotLogin(comment?.author?.login) === app.login && String(comment?.author?.databaseId ?? "") === app.id && typeof comment?.body === "string" && comment.body.endsWith(marker) && (expectedEvidence === null || comment.body.includes(expectedEvidence)) && (expectedBody === null || comment.body === expectedBody))
    .map((comment) => ({ updatedAt: comment.updatedAt }));
  assert(owned.length === 1 && validTimestamp(owned[0].updatedAt) && (notBefore === null || happensOnOrAfter(owned[0].updatedAt, notBefore)) && (notAfter === null || happensOnOrBefore(owned[0].updatedAt, notAfter)), "Current App publication marker lacks a unique current App-owned publication record within the selected run window");
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

async function fixedPullRequestMetadata({ repo, number, defaultBranch, gh }) {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url state isDraft baseRefName headRefOid headRefName headRepository{nameWithOwner} mergedAt autoMergeRequest{enabledAt} createdAt body author{login ... on Bot{databaseId}}}}}";
  const pull = (await graphql({ gh, query, variables: { owner, name, number } }))?.data?.repository?.pullRequest;
  assert(Number(pull?.number) === number && isBoundedGitHubUrl(pull?.url, `https://github.com/${repo}/pull/`) && pull.url === `https://github.com/${repo}/pull/${number}` && validTimestamp(pull?.createdAt), "Fix pull request metadata did not match the candidate");
  assert(pull?.isDraft === false && pull?.baseRefName === defaultBranch && typeof pull?.headRefOid === "string" && SHA.test(pull.headRefOid) && typeof pull?.headRefName === "string" && pull.headRefName.length > 0 && normaliseLogin(pull?.headRepository?.nameWithOwner) === normaliseLogin(repo), "Fix pull request must be non-draft, same-repository, target the default branch, and retain an immutable head");
  return pull;
}

async function fixedPullRequestCommits({ repo, number, gh }) {
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", `repos/${repo}/pulls/${number}/commits?per_page=2`]);
  const commits = parseJson(stdout, "Fix pull request commits");
  assert(Array.isArray(commits) && commits.length === 1, "Fix pull request must contain exactly one publication commit");
  return commits[0];
}

function isAppOwnedPublicationCommit({ commit, pull, app, run }) {
  const appActor = (actor) => canonicalAppBotLogin(actor?.login) === app.login
    && String(actor?.id ?? "") === app.id
    && actor?.type === "Bot";
  const authorDate = commit?.commit?.author?.date;
  const committerDate = commit?.commit?.committer?.date;
  const parents = commit?.parents;
  return commit?.sha === pull.headRefOid
    && appActor(commit?.author)
    && appActor(commit?.committer)
    && Array.isArray(parents)
    && parents.length === 1
    && typeof parents[0]?.sha === "string"
    && SHA.test(parents[0].sha)
    && parents[0].sha.toLowerCase() === run.headSha.toLowerCase()
    && happensOnOrAfter(authorDate, run.startedAt)
    && happensOnOrBefore(authorDate, run.updatedAt)
    && happensOnOrAfter(committerDate, run.startedAt)
    && happensOnOrBefore(committerDate, run.updatedAt);
}

async function uniquelyAttributedControlledFixRun({ repo, dispatchRef, run, expectedActorLogin, gh }) {
  const detail = SCENARIO_DETAILS["controlled-fix"];
  const endpoint = `repos/${repo}/actions/workflows/${detail.workflow}/runs?event=${detail.event}&branch=${encodeURIComponent(dispatchRef)}&per_page=100`;
  const { stdout } = await callGh(gh, ["api", "--hostname", "github.com", endpoint]);
  const payload = parseJson(stdout, "Controlled-fix workflow runs");
  assert(Number.isInteger(payload?.total_count) && payload.total_count === 1 && Array.isArray(payload?.workflow_runs) && payload.workflow_runs.length === 1, "Retained dispatch ref does not have unique controlled-fix run attribution");
  const attributed = payload.workflow_runs[0];
  assert(
    String(attributed?.id) === String(run.databaseId)
      && attributed?.name === detail.workflowName
      && attributed?.display_title === dispatchRunTitle("controlled-fix")
      && attributed?.event === detail.event
      && attributed?.status === "completed"
      && attributed?.conclusion === "success"
      && attributed?.head_sha === run.headSha
      && attributed?.head_branch === dispatchRef
      && attributed?.run_attempt === run.attempt
      && attributed?.created_at === run.createdAt
      && attributed?.updated_at === run.updatedAt
      && normaliseLogin(attributed?.actor?.login) === expectedActorLogin,
    "Explicit controlled-fix run does not match the uniquely attributed retained dispatch"
  );
  return attributed;
}

async function configuredFixPolicy({ repo, revision, snapshot, expectedSource, gh }) {
  const source = snapshot
    ? await repositoryFileAtImmutableSnapshot({ repo, file: ".github/codekeeper.json", snapshot, expectedSource, gh })
    : await repositoryFile({ repo, file: ".github/codekeeper.json", ref: revision, gh });
  const config = parseJson(source, "Codekeeper policy");
  const prefix = config?.repository?.automationBranchPrefix;
  const defaultBranch = config?.repository?.defaultBranch;
  const repair = config?.audit?.repair;
  assert(typeof prefix === "string" && SAFE_PREFIX.test(prefix), "Target Codekeeper policy has no safe automation branch prefix");
  assert(validBranchName(defaultBranch), "Target Codekeeper policy has no safe default branch");
  assert(config?.issues?.allowAiImplementation === true, "Target Codekeeper policy does not explicitly enable controlled issue implementation");
  assert(Array.isArray(repair?.allowedPaths) && repair.allowedPaths.length === FIXTURE_ALLOWED_FIX_PATHS.length && new Set(repair.allowedPaths).size === FIXTURE_ALLOWED_FIX_PATHS.length && repair.allowedPaths.every((item) => FIXTURE_ALLOWED_FIX_PATHS.includes(item)), "Target Codekeeper policy must allow exactly the bounded fixture paths");
  assert(Array.isArray(repair?.validationCommands) && repair.validationCommands.includes("node --test test/*.test.mjs"), "Target Codekeeper policy must configure the deterministic fixture test command");
  assert(config?.merge?.enabled === false, "Target Codekeeper policy must keep auto-merge disabled for controlled fixes");
  return { prefix, defaultBranch, source };
}

async function listOpenPulls({ repo, gh }) {
  const { stdout } = await callGh(gh, ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,url,headRefName,createdAt"]);
  const pulls = parseJson(stdout, "Open pull requests");
  assert(Array.isArray(pulls) && pulls.length < 100, "Open pull request inventory is invalid or incomplete");
  return pulls;
}

function validateScenarioOptions(scenario, options) {
  assert(MUTATING_SCENARIOS.has(scenario), "Unknown acceptance scenario");
  const commonOptions = new Set(["repo", "source-sha", "acknowledge-private-acceptance", "evidence", "fixture-checkout"]);
  const scenarioOptions = {
    "maintenance-dry-run": commonOptions,
    "review-introduced-defect": new Set([...commonOptions, "pr", "run-id", "run-created-after", "app-login", "app-id"]),
    "issue-triage-related": new Set([...commonOptions, "issue", "run-id", "run-created-after", "app-login", "app-id"]),
    "issue-resolved-by-pr": new Set([...commonOptions, "issue", "pr", "run-id", "run-created-after", "app-login", "app-id"]),
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
    result.runCreatedAfter = validateTimestamp(options["run-created-after"], "--run-created-after");
    result.app = validateAppIdentity(options);
  }
  if (scenario === "issue-triage-related" || scenario === "issue-resolved-by-pr") {
    result.issue = validatePositiveInteger(options.issue, "--issue");
    if (scenario === "issue-resolved-by-pr") result.pr = validatePositiveInteger(options.pr, "--pr");
    result.runId = validatePositiveInteger(options["run-id"], "--run-id");
    result.runCreatedAfter = validateTimestamp(options["run-created-after"], "--run-created-after");
    result.app = validateAppIdentity(options);
  }
  if (scenario === "controlled-fix") {
    result.issue = validatePositiveInteger(options.issue, "--issue");
    result.app = validateAppIdentity(options);
  }
  return result;
}

function validateControlledFixRecoveryOptions(options) {
  const permitted = new Set(["repo", "source-sha", "acknowledge-private-acceptance", "evidence", "fixture-checkout", "issue", "run-id", "pr", "dispatch-ref", "app-login", "app-id"]);
  assert(Object.keys(options).length === permitted.size && Object.keys(options).every((option) => permitted.has(option)), "Controlled-fix recovery requires every explicit recovery option and no others");
  const request = {
    repo: validateRepositoryName(options.repo),
    sourceSha: validateSourceSha(options["source-sha"]),
    evidencePath: options.evidence,
    fixtureCheckout: options["fixture-checkout"],
    issue: validatePositiveInteger(options.issue, "--issue"),
    runId: validatePositiveInteger(options["run-id"], "--run-id"),
    pr: validatePositiveInteger(options.pr, "--pr"),
    dispatchRef: validateControlledFixDispatchRef(options["dispatch-ref"]),
    app: validateAppIdentity(options)
  };
  assert(options["acknowledge-private-acceptance"] === true, "--acknowledge-private-acceptance is required before controlled-fix recovery");
  assert(typeof request.evidencePath === "string" && request.evidencePath.length > 0, "An explicit --evidence PATH is required");
  assert(typeof request.fixtureCheckout === "string" && request.fixtureCheckout.length > 0, "An explicit --fixture-checkout PATH is required to keep evidence out of the target checkout");
  return request;
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
  const run = await waitForRun({ repo: request.repo, runId: request.runId, expectedEvent: SCENARIO_DETAILS["review-introduced-defect"].event, expectedWorkflowName: SCENARIO_DETAILS["review-introduced-defect"].workflowName, expectedDisplayTitle: initialTitle, gh, sleep, boundary: { dispatchedAt: request.runCreatedAfter } });
  await assertPinnedRelease({ repo: request.repo, scenario: "review-introduced-defect", sourceSha: request.sourceSha, revision: run.headSha, gh });
  const pull = await pullRequest({ repo: request.repo, number: request.pr, gh });
  assertSupportedReviewShape(pull, preflightResult.defaultBranch);
  const matchesCurrentPull = run.displayTitle === reviewRunTitle(request.pr, pull.headRefOid)
    && run.headSha === pull.headRefOid
    && run.headBranch === pull.headRefName;
  assert(matchesCurrentPull, "Review run no longer matches the PR's current immutable head");
  const [marker, checks] = await Promise.all([
    currentMarkerComment({ repo: request.repo, kind: "pull_request", number: request.pr, marker: REVIEW_MARKER, app: request.app, expectedRunUrl: expectedRunUrl(request.repo, run.databaseId), gh }),
    pullRequestChecks({ repo: request.repo, number: request.pr, gh })
  ]);
  expect(assertions, "introduced-defect pull request remains open, non-draft, same-repository, and targets the default branch", true);
  expect(assertions, "review run title and immutable head are bound to the requested pull request", matchesCurrentPull);
  expect(assertions, "review workflow completed with the expected blocking conclusion", run.conclusion === "failure");
  expect(assertions, "blocking review state is accompanied by publisher evidence for this exact run", labelsFrom(pull).includes("blocked") && hasExactCheck(checks, "review / Codekeeper review gate", "fail"));
  expect(assertions, "review publication has one current canonical App marker correlated to the selected run URL", Boolean(marker));
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("pull_request", pull), passed: assertions.every((assertion) => assertion.passed) };
}

async function verifyIssue({ request, gh, sleep }) {
  const assertions = [];
  const run = await waitForRun({ repo: request.repo, runId: request.runId, expectedEvent: SCENARIO_DETAILS["issue-triage-related"].event, expectedWorkflowName: SCENARIO_DETAILS["issue-triage-related"].workflowName, expectedDisplayTitle: issueRunTitle(request.issue), gh, sleep, boundary: { dispatchedAt: request.runCreatedAfter } });
  await assertPinnedRelease({ repo: request.repo, scenario: "issue-triage-related", sourceSha: request.sourceSha, revision: run.headSha, gh });
  const targetIssue = await issue({ repo: request.repo, number: request.issue, gh });
  const marker = await currentMarkerComment({ repo: request.repo, kind: "issue", number: request.issue, marker: ISSUE_TRIAGE_MARKER, app: request.app, expectedRunUrl: expectedRunUrl(request.repo, run.databaseId), gh });
  const labels = labelsFrom(targetIssue);
  expect(assertions, "issue triage workflow title is bound to the requested issue", run.displayTitle === issueRunTitle(request.issue));
  expect(assertions, "issue triage workflow completed successfully", run.conclusion === "success");
  expect(assertions, "issue publication is bound to this run's exact App marker evidence", Boolean(marker));
  expect(assertions, "related issue remains open", targetIssue.state === "OPEN");
  expect(assertions, "related issue is not marked as a duplicate", !labels.includes("duplicate"));
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("issue", targetIssue), passed: assertions.every((assertion) => assertion.passed) };
}

async function mergedPullRequestsClosingIssue({ repo, number, gh }) {
  const [owner, name] = repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){closedByPullRequestsReferences(first:100,includeClosedPrs:true){nodes{number url merged mergedAt repository{nameWithOwner}} pageInfo{hasNextPage}}}}}";
  const payload = await graphql({ gh, query, variables: { owner, name, number } });
  const references = payload?.data?.repository?.issue?.closedByPullRequestsReferences;
  assert(Array.isArray(references?.nodes) && references.nodes.length <= 100 && references.pageInfo?.hasNextPage === false, "Closing pull request metadata exceeded its safe bound");
  return references.nodes;
}

async function verifyResolvedIssue({ request, gh, sleep }) {
  const assertions = [];
  const detail = SCENARIO_DETAILS["issue-resolved-by-pr"];
  const run = await waitForRun({ repo: request.repo, runId: request.runId, expectedEvent: detail.event, expectedWorkflowName: detail.workflowName, expectedDisplayTitle: issueRunTitle(request.issue), gh, sleep, boundary: { dispatchedAt: request.runCreatedAfter } });
  await assertPinnedRelease({ repo: request.repo, scenario: "issue-resolved-by-pr", sourceSha: request.sourceSha, revision: run.headSha, gh });
  const [targetIssue, marker, references] = await Promise.all([
    issue({ repo: request.repo, number: request.issue, gh }),
    currentMarkerComment({ repo: request.repo, kind: "issue", number: request.issue, marker: ISSUE_TRIAGE_MARKER, app: request.app, expectedRunUrl: expectedRunUrl(request.repo, run.databaseId), gh }),
    mergedPullRequestsClosingIssue({ repo: request.repo, number: request.issue, gh })
  ]);
  const expectedUrl = `https://github.com/${request.repo}/pull/${request.pr}`;
  const resolution = references.filter((pull) => Number(pull?.number) === request.pr
    && pull?.url === expectedUrl
    && pull?.merged === true
    && validTimestamp(pull?.mergedAt)
    && normaliseLogin(pull?.repository?.nameWithOwner) === normaliseLogin(request.repo));
  expect(assertions, "resolved issue workflow title is bound to the requested issue", run.displayTitle === issueRunTitle(request.issue));
  expect(assertions, "resolved issue workflow completed successfully", run.conclusion === "success");
  expect(assertions, "resolved issue publication is bound to this run's exact App marker evidence", Boolean(marker));
  expect(assertions, "issue is closed after triage", targetIssue.state === "CLOSED");
  expect(assertions, "GitHub identifies the exact merged pull request as a closing reference", resolution.length === 1);
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("issue", targetIssue), passed: assertions.every((assertion) => assertion.passed) };
}

async function verifyFix({ request, preflightResult, gh, sleep, now, recordDispatchRef }) {
  const assertions = [];
  const prevalidated = await prevalidateDispatchSnapshot({ repo: request.repo, scenario: "controlled-fix", sourceSha: request.sourceSha, preflight: preflightResult, gh });
  const snapshot = await createImmutableDispatchSnapshot({ repo: request.repo, scenario: "controlled-fix", sourceSha: request.sourceSha, prevalidated, gh, onSnapshot: ({ dispatchRef }) => recordDispatchRef(dispatchRef) });
  const { prefix, defaultBranch } = await configuredFixPolicy({ repo: request.repo, snapshot, expectedSource: prevalidated.fixPolicy.source, gh });
  const existing = (await listOpenPulls({ repo: request.repo, gh })).filter((pull) => String(pull?.headRefName ?? "").startsWith(prefix));
  assert(existing.length === 0, "Target has an existing automation-prefix pull request; refusing an ambiguous fix scenario");
  const existingIds = new Set(existing.map((pull) => String(pull.number)));
  const run = await dispatchAndWait({ repo: request.repo, scenario: "controlled-fix", issue: request.issue, preflight: preflightResult, snapshot, gh, sleep, now });
  const candidates = (await listOpenPulls({ repo: request.repo, gh }))
    .filter((pull) => !existingIds.has(String(pull?.number)) && String(pull?.headRefName ?? "").startsWith(prefix) && happensOnOrAfter(pull?.createdAt, run.createdAt));
  assert(candidates.length === 1, "Expected exactly one newly created open Codekeeper fix pull request on the configured prefix");
  const candidate = candidates[0];
  const fingerprint = sha256(`issue|${request.repo}|${request.issue}`);
  const [pull, commit, paths, jobs, marker] = await Promise.all([
    fixedPullRequestMetadata({ repo: request.repo, number: Number(candidate.number), defaultBranch, gh }),
    fixedPullRequestCommits({ repo: request.repo, number: Number(candidate.number), gh }),
    changedPullRequestPaths({ repo: request.repo, number: Number(candidate.number), gh }),
    runJobs({ repo: request.repo, runId: run.databaseId, gh }),
    currentMarkerComment({ repo: request.repo, kind: "issue", number: request.issue, marker: repairNotificationMarker(fingerprint), app: request.app, notBefore: run.startedAt, notAfter: run.updatedAt, gh })
  ]);
  const expectedBranch = branchSlug(`${prefix}fix-${fingerprint}`);
  expect(assertions, "controlled fix workflow completed successfully", run.conclusion === "success");
  expect(assertions, "fix pull request is open, App-owned, and not auto-merged", pull.state === "OPEN" && !pull.mergedAt && pull.autoMergeRequest == null && canonicalAppBotLogin(pull?.author?.login) === request.app.login && String(pull?.author?.databaseId ?? "") === request.app.id);
  expect(assertions, "fix pull request is the canonical repair for the requested issue", pull.headRefName === expectedBranch && typeof pull.body === "string" && pull.body.includes(`Closes #${request.issue}`) && pull.body.endsWith(repairMarker(fingerprint)) && happensOnOrAfter(pull.createdAt, run.startedAt) && happensOnOrBefore(pull.createdAt, run.updatedAt) && happensOnOrAfter(marker.updatedAt, run.startedAt) && happensOnOrBefore(marker.updatedAt, run.updatedAt));
  expect(assertions, "fix pull request head is the single App-authored and App-committed publication within the selected run", isAppOwnedPublicationCommit({ commit, pull, app: request.app, run }));
  expect(assertions, "fix changed only bounded fixture paths", paths.length > 0 && paths.every((changedPath) => FIXTURE_ALLOWED_FIX_PATHS.includes(changedPath)));
  expect(assertions, "fixture tests passed in Codekeeper verification", jobs.some((job) => String(job?.name ?? "").toLowerCase().includes("implementation verification") && job?.conclusion === "success"));
  expect(assertions, `controlled fix dispatch retained immutable acceptance tag ${snapshot.dispatchRef}`, true);
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("pull_request", pull), dispatchRef: snapshot.dispatchRef, passed: assertions.every((assertion) => assertion.passed) };
}

async function verifyRecoveredFix({ request, preflightResult, gh, now }) {
  const assertions = [];
  const detail = SCENARIO_DETAILS["controlled-fix"];
  const run = await waitForRun({
    repo: request.repo,
    runId: request.runId,
    expectedEvent: detail.event,
    expectedWorkflowName: detail.workflowName,
    expectedDisplayTitle: dispatchRunTitle("controlled-fix"),
    gh,
    sleep: async () => {},
    now,
    attempts: 1
  });
  assert(run.conclusion === "success" && run.attempt === 1, "Controlled-fix recovery requires the original successful workflow attempt");
  assert(run.actorLogin === preflightResult.actorLogin, "Controlled-fix run actor did not match the currently authenticated dispatcher");
  const dispatchMatch = CONTROLLED_FIX_DISPATCH_REF.exec(request.dispatchRef);
  assert(dispatchMatch?.[1] === run.headSha.slice(0, 12).toLowerCase() && run.headBranch === request.dispatchRef, "Controlled-fix run did not use the supplied retained dispatch tag");
  assert(await acceptanceTagRef({ repo: request.repo, tag: request.dispatchRef, gh }) === run.headSha.toLowerCase(), "Retained controlled-fix acceptance tag does not resolve to the run head SHA");
  await uniquelyAttributedControlledFixRun({ repo: request.repo, dispatchRef: request.dispatchRef, run, expectedActorLogin: preflightResult.actorLogin, gh });

  const snapshot = { headSha: run.headSha.toLowerCase(), dispatchRef: request.dispatchRef };
  const [, policy] = await Promise.all([
    assertPinnedRelease({ repo: request.repo, scenario: "controlled-fix", sourceSha: request.sourceSha, snapshot, gh }),
    configuredFixPolicy({ repo: request.repo, snapshot, gh })
  ]);
  const fingerprint = sha256(`issue|${request.repo}|${request.issue}`);
  const expectedBranch = branchSlug(`${policy.prefix}fix-${fingerprint}`);
  const expectedRepairMarker = repairMarker(fingerprint);
  const expectedIssueMarker = repairNotificationMarker(fingerprint);
  const [pull, commit, paths, jobs, issueMarker] = await Promise.all([
    fixedPullRequestMetadata({ repo: request.repo, number: request.pr, defaultBranch: policy.defaultBranch, gh }),
    fixedPullRequestCommits({ repo: request.repo, number: request.pr, gh }),
    changedPullRequestPaths({ repo: request.repo, number: request.pr, gh }),
    runJobs({ repo: request.repo, runId: run.databaseId, gh }),
    currentMarkerComment({
      repo: request.repo,
      kind: "issue",
      number: request.issue,
      marker: expectedIssueMarker,
      app: request.app,
      expectedBody: `Codekeeper opened a repair pull request: https://github.com/${request.repo}/pull/${request.pr}\n${expectedIssueMarker}`,
      notBefore: run.startedAt,
      notAfter: run.updatedAt,
      gh
    })
  ]);
  const repairMarkerCount = typeof pull.body === "string" ? pull.body.split(expectedRepairMarker).length - 1 : 0;
  const appOwnedOpenPull = pull.state === "OPEN"
    && !pull.mergedAt
    && pull.autoMergeRequest == null
    && canonicalAppBotLogin(pull?.author?.login) === request.app.login
    && String(pull?.author?.databaseId ?? "") === request.app.id;
  const canonicalRepair = pull.headRefName === expectedBranch
    && typeof pull.body === "string"
    && pull.body.includes(`Closes #${request.issue}`)
    && pull.body.endsWith(expectedRepairMarker)
    && repairMarkerCount === 1
    && happensOnOrAfter(pull.createdAt, run.startedAt)
    && happensOnOrBefore(pull.createdAt, run.updatedAt);
  const implementationVerification = jobs.filter((job) => job?.name === "fix / Codekeeper implementation verification");

  expect(assertions, "explicit completed run has unique retained controlled-fix attribution", true);
  expect(assertions, `controlled fix retained exact immutable acceptance tag ${request.dispatchRef}`, true);
  expect(assertions, "caller package receipt, release provenance, and bounded fix policy match at the run SHA and retained tag", true);
  expect(assertions, "fix pull request is open, App-owned, unmerged, and has no auto-merge request", appOwnedOpenPull);
  expect(assertions, `explicit pull request is the single-marker canonical repair for issue #${request.issue}`, canonicalRepair);
  expect(assertions, "explicit pull request head is the single App-authored and App-committed publication within the selected run", isAppOwnedPublicationCommit({ commit, pull, app: request.app, run }));
  expect(assertions, `issue #${request.issue} has the exact current App-owned repair notification for the explicit pull request`, Boolean(issueMarker));
  expect(assertions, "fix changed only bounded fixture paths", paths.length > 0 && paths.every((changedPath) => FIXTURE_ALLOWED_FIX_PATHS.includes(changedPath)));
  expect(assertions, "fixture tests passed in exactly one Codekeeper implementation-verification job", implementationVerification.length === 1 && implementationVerification[0]?.conclusion === "success");
  return { assertions, workflow: workflowEvidence(run), resource: resourceEvidence("pull_request", pull), dispatchRef: request.dispatchRef, passed: assertions.every((assertion) => assertion.passed) };
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
    if (scenario === "issue-resolved-by-pr") result = await verifyResolvedIssue({ request, gh, sleep });
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

export async function recoverControlledFix({ options, gh, now = () => new Date() }) {
  const request = validateControlledFixRecoveryOptions(options);
  const destination = await prepareEvidenceDestination({ evidencePath: request.evidencePath, fixtureCheckout: request.fixtureCheckout });
  const startedAt = currentIso(now);
  let result = {
    assertions: [{ expectation: "controlled-fix evidence recovery completed without an unredacted operational error", passed: false }],
    workflow: null,
    resource: null,
    dispatchRef: request.dispatchRef,
    passed: false
  };
  try {
    const preflightResult = await preflight({ repo: request.repo, gh });
    result = await verifyRecoveredFix({ request, preflightResult, gh, now });
    result.passed = result.passed !== false;
  } catch {
    result.passed = false;
  }
  const evidence = {
    schemaVersion: 1,
    targetRepository: request.repo,
    scenario: "controlled-fix",
    sourceSha: request.sourceSha,
    dispatchRef: request.dispatchRef,
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
  assert(command === "preflight" || command === CONTROLLED_FIX_RECOVERY_COMMAND || MUTATING_SCENARIOS.has(command), `Unknown command: ${command}`);
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
  const permitted = new Set(["repo", "source-sha", "acknowledge-private-acceptance", "evidence", "fixture-checkout", "pr", "issue", "run-id", "run-created-after", "dispatch-ref", "app-login", "app-id"]);
  assert(Object.keys(options).every((option) => permitted.has(option)), "Scenario command received an unsupported option");
  return { command, options };
}

export function formatUsage() {
  const fixture = path.dirname(fileURLToPath(import.meta.url));
  return `Codekeeper private acceptance harness (Node >=22)\n\nRead-only GitHub verification:\n  node ${path.join(fixture, "../bin/codekeeper-acceptance.mjs")} preflight --repo OWNER/codekeeper-test-environment\n  node ${path.join(fixture, "../bin/codekeeper-acceptance.mjs")} recover-controlled-fix --repo OWNER/codekeeper-test-environment --source-sha SHA --acknowledge-private-acceptance --fixture-checkout PATH --evidence PATH --issue NUMBER --run-id NUMBER --pr NUMBER --dispatch-ref TAG --app-login 'APP[bot]' --app-id NUMBER\n\nScenario commands require --repo, --source-sha (40-character commit),\n--acknowledge-private-acceptance, --fixture-checkout, and --evidence PATH.\nReview, issue, and fix verification also require the configured App bot login\nand immutable numeric --app-id. Review and issue verification require the\nrecorded event trigger time as --run-created-after ISO-8601.\n\nMaintenance and fix dispatch create one retained unique acceptance tag at the\npreflight default-branch SHA; GitHub workflow_dispatch receives that tag, never\na raw SHA. The evidence records the tag and the harness never deletes it.\nRecovery only reads that retained tag and an explicit completed run and PR.\n\n  maintenance-dry-run\n  review-introduced-defect --pr NUMBER --run-id NUMBER --run-created-after ISO-8601 --app-login 'APP[bot]' --app-id NUMBER\n  issue-triage-related --issue NUMBER --run-id NUMBER --run-created-after ISO-8601 --app-login 'APP[bot]' --app-id NUMBER\n  issue-resolved-by-pr --issue NUMBER --pr NUMBER --run-id NUMBER --run-created-after ISO-8601 --app-login 'APP[bot]' --app-id NUMBER\n  controlled-fix --issue NUMBER --app-login 'APP[bot]' --app-id NUMBER`;
}
