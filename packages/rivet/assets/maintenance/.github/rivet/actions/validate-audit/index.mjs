import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024;
const MAX_FINDINGS = 20;
const MAX_FINDING_ID_LENGTH = 70;
const MAX_STRING = 2_000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
const SENSITIVE_CONTENT =
  /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:api[ _-]?key\w*|access[ _-]?token\w*|client[ _-]?secret\w*|password\w*|passwd\w*|private[ _-]?key\w*|credential\w*)\b|authorization\s*:\s*bearer|(?:gh[pousr]_?|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}/i;
const SECURITY_CONTENT =
  /\b(?:secur\w*|vulnerab\w*|credential\w*|secret\w*|private[ _-]?key\w*|exploit\w*|cve-\d{4}-\d+)\b/i;

function fail(message) {
  throw new Error(`Rivet audit validation: ${message}`);
}
function boundedString(value, name, maximum = MAX_STRING) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    fail(`${name} must be a bounded string`);
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(value))
    fail(`${name} contains unsupported characters`);
  if (SENSITIVE_CONTENT.test(value)) fail(`${name} contains sensitive content`);
  return value;
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${name} has unsupported or missing fields`);
}

function parseAgentOutput(raw) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES
  )
    fail("agent output is too large");
  let output;
  try {
    output = JSON.parse(raw);
  } catch {
    fail("agent output is not valid JSON");
  }
  exactKeys(output, ["items", "errors"], "agent output");
  if (
    !Array.isArray(output.items) ||
    output.items.length !== 1 ||
    !Array.isArray(output.errors) ||
    output.errors.length !== 0
  )
    fail("agent output must contain exactly one item");
  const [item] = output.items;
  exactKeys(item, ["type", "audit"], "audit item");
  if (item.type !== "validate_audit") fail("unexpected output type");
  if (
    typeof item.audit !== "string" ||
    Buffer.byteLength(item.audit, "utf8") > MAX_INPUT_BYTES
  ) {
    fail("audit item must contain bounded JSON");
  }
  try {
    return JSON.parse(item.audit);
  } catch {
    fail("audit item is not valid JSON");
  }
}

function validateFinding(finding, index) {
  const name = `finding ${index + 1}`;
  exactKeys(
    finding,
    [
      "id",
      "path",
      "problemKey",
      "title",
      "category",
      "priority",
      "evidence",
      "recommendation",
    ],
    name,
  );
  const id = boundedString(finding.id, `${name}.id`, MAX_FINDING_ID_LENGTH);
  const owningPath = boundedString(finding.path, `${name}.path`, 512);
  const problemKey = boundedString(
    finding.problemKey,
    `${name}.problemKey`,
    128,
  );
  const title = boundedString(finding.title, `${name}.title`, 256);
  const category = boundedString(finding.category, `${name}.category`, 64);
  const priority = boundedString(finding.priority, `${name}.priority`, 2);
  const evidence = boundedString(finding.evidence, `${name}.evidence`);
  const recommendation = boundedString(
    finding.recommendation,
    `${name}.recommendation`,
  );
  if (!/^audit-[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    fail(`${name}.id is invalid`);
  if (
    owningPath.startsWith("/") ||
    owningPath.includes("\\") ||
    owningPath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${name}.path is invalid`);
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(problemKey))
    fail(`${name}.problemKey is invalid`);
  if (!/^P[0-3]$/.test(priority)) fail(`${name}.priority is invalid`);
  if (
    [title, category, evidence, recommendation].some((value) =>
      SECURITY_CONTENT.test(value),
    )
  ) {
    fail(`${name} is security-sensitive`);
  }
  return {
    id,
    path: owningPath,
    problemKey,
    title,
    category,
    priority,
    evidence,
    recommendation,
  };
}

export function validateAuditOutput({
  event,
  agentOutput,
  expectedHeadSha,
  expectedRef,
  now = new Date(),
} = {}) {
  if (!FULL_SHA.test(expectedHeadSha ?? ""))
    fail("expected head SHA is invalid");
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(expectedRef ?? ""))
    fail("expected source ref is invalid");
  const defaultBranch = event?.repository?.default_branch;
  if (
    typeof defaultBranch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(defaultBranch)
  )
    fail("repository default branch is invalid");
  if (expectedRef !== `refs/heads/${defaultBranch}`)
    fail("source ref is not the default branch");
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      event?.repository?.full_name ?? "",
    )
  )
    fail("repository identity is invalid");
  const audit = parseAgentOutput(agentOutput);
  exactKeys(audit, ["headSha", "sourceRef", "summary", "findings"], "audit");
  if (audit.headSha !== expectedHeadSha) fail("audit head SHA does not match");
  if (audit.sourceRef !== expectedRef) fail("audit source ref does not match");
  const summary = boundedString(audit.summary, "audit.summary");
  if (SECURITY_CONTENT.test(summary))
    fail("audit.summary is security-sensitive");
  if (!Array.isArray(audit.findings) || audit.findings.length > MAX_FINDINGS)
    fail("audit findings are unbounded or malformed");
  const findings = audit.findings.map(validateFinding);
  if (new Set(findings.map(({ id }) => id)).size !== findings.length)
    fail("audit finding IDs must be unique");
  const validatedAt = new Date(now);
  if (Number.isNaN(validatedAt.valueOf())) fail("validation time is invalid");
  const expiresAt = new Date(validatedAt.valueOf() + SEVEN_DAYS);
  const result = {
    schemaVersion: 1,
    headSha: expectedHeadSha,
    sourceRef: expectedRef,
    summary,
    findings,
    validatedAt: validatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ARTIFACT_BYTES)
    fail("validated audit artifact is too large");
  return Object.freeze(result);
}

export async function runValidateAuditAction({
  env = process.env,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  now = new Date(),
} = {}) {
  if (!env.GITHUB_EVENT_PATH || !env.GH_AW_AGENT_OUTPUT)
    fail("event and agent output paths are required");
  const event = JSON.parse(await readFileImpl(env.GITHUB_EVENT_PATH, "utf8"));
  const defaultBranch = event?.repository?.default_branch;
  const expectedRef = `refs/heads/${defaultBranch}`;
  if (env.GITHUB_REF !== expectedRef)
    fail("workflow did not run on the default branch");
  const agentOutput = await readFileImpl(env.GH_AW_AGENT_OUTPUT, "utf8");
  const audit = validateAuditOutput({
    event,
    agentOutput,
    expectedHeadSha: env.GITHUB_SHA,
    expectedRef,
    now,
  });
  const root = path.resolve(
    env.RIVET_AUDIT_ARTIFACT ??
      path.join(env.RUNNER_TEMP ?? ".", "rivet-audit"),
  );
  await mkdirImpl(root, { recursive: true, mode: 0o700 });
  const artifact = `${JSON.stringify(audit)}\n`;
  const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
  const receipt = {
    schemaVersion: 1,
    repository: event.repository.full_name,
    headSha: audit.headSha,
    sourceRef: audit.sourceRef,
    validatedAt: audit.validatedAt,
    expiresAt: audit.expiresAt,
    artifactSha256,
  };
  const receiptText = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(artifact) > MAX_ARTIFACT_BYTES)
    fail("artifact is too large");
  if (Buffer.byteLength(receiptText) > MAX_RECEIPT_BYTES)
    fail("receipt is too large");
  await writeFileImpl(path.join(root, "audit.json"), artifact, { mode: 0o600 });
  await writeFileImpl(path.join(root, "receipt.json"), receiptText, {
    mode: 0o600,
  });
  return Object.freeze(receipt);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runValidateAuditAction().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
