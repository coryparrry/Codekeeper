import { appendFile, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_FILES = 50;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024;

function fail(message) {
  throw new Error(`Rivet review context: ${message}`);
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid`);
  return value;
}

function repositoryPath(value, name = "file path") {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${name} is invalid`);
  }
  return value;
}

function metadataFromEvent(event, expectedRepository) {
  const repository = event?.repository?.full_name;
  const pullRequest = event?.pull_request;
  if (!REPOSITORY.test(repository ?? "") || repository !== expectedRepository)
    fail("repository identity is invalid");
  const pullNumber = nonnegativeInteger(
    pullRequest?.number,
    "pull request number",
  );
  if (pullNumber < 1) fail("pull request number is invalid");
  const baseSha = pullRequest?.base?.sha;
  const headSha = pullRequest?.head?.sha;
  if (!FULL_SHA.test(baseSha ?? "") || !FULL_SHA.test(headSha ?? ""))
    fail("pull request SHAs are invalid");
  return Object.freeze({
    repository,
    pullNumber,
    baseSha,
    headSha,
    changedFiles: nonnegativeInteger(
      pullRequest?.changed_files,
      "changed file count",
    ),
  });
}

function incomplete(metadata, reason) {
  return Object.freeze({
    schemaVersion: 1,
    complete: false,
    repository: metadata.repository,
    pullNumber: metadata.pullNumber,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    reason,
    files: [],
  });
}

async function boundedResponseText(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    return null;
  if (!response.body?.getReader) fail("GitHub response body is unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function projectFile(file, index) {
  if (!file || typeof file !== "object" || Array.isArray(file))
    fail(`file ${index + 1} is invalid`);
  const status = file.status;
  if (!/^(?:added|copied|modified|removed|renamed)$/.test(status ?? ""))
    fail(`file ${index + 1} status is invalid`);
  const projected = {
    path: repositoryPath(file.filename, `file ${index + 1} path`),
    status,
    additions: nonnegativeInteger(
      file.additions,
      `file ${index + 1} additions`,
    ),
    deletions: nonnegativeInteger(
      file.deletions,
      `file ${index + 1} deletions`,
    ),
    changes: nonnegativeInteger(file.changes, `file ${index + 1} changes`),
    patch: file.patch ?? null,
  };
  if (projected.patch !== null && typeof projected.patch !== "string")
    fail(`file ${index + 1} patch is invalid`);
  if (file.previous_filename !== undefined)
    projected.previousPath = repositoryPath(
      file.previous_filename,
      `file ${index + 1} previous path`,
    );
  return projected;
}

function hasCompletePatch(file, filesByPath) {
  if (file.patch !== null) return true;
  if (file.status === "renamed" && file.changes === 0) return true;
  if (!file.path.endsWith(".lock.yml")) return false;
  const source = filesByPath.get(
    `${file.path.slice(0, -".lock.yml".length)}.md`,
  );
  return source?.changes > 0 && source.patch !== null;
}

export async function createReviewContext({
  event,
  expectedRepository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
  maxFiles = MAX_FILES,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  maxSnapshotBytes = MAX_SNAPSHOT_BYTES,
} = {}) {
  const metadata = metadataFromEvent(event, expectedRepository);
  if (typeof token !== "string" || token.length < 1 || token.length > 4096)
    fail("GitHub token is unavailable");
  let apiBase;
  try {
    apiBase = new URL(apiUrl);
  } catch {
    fail("GitHub API URL is invalid");
  }
  if (
    apiBase.protocol !== "https:" ||
    apiBase.username ||
    apiBase.password ||
    apiBase.search ||
    apiBase.hash
  ) {
    fail("GitHub API URL is invalid");
  }
  if (metadata.changedFiles > maxFiles) {
    return incomplete(
      metadata,
      `comparison exceeds the ${maxFiles}-file review budget`,
    );
  }
  if (metadata.changedFiles === 0) {
    return Object.freeze({
      schemaVersion: 1,
      complete: true,
      repository: metadata.repository,
      pullNumber: metadata.pullNumber,
      baseSha: metadata.baseSha,
      headSha: metadata.headSha,
      files: [],
    });
  }

  const [owner, repository] = metadata.repository.split("/");
  apiBase.pathname = `${apiBase.pathname.replace(/\/$/, "")}/`;
  const url = new URL(
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/compare/${metadata.baseSha}...${metadata.headSha}`,
    apiBase,
  );
  url.searchParams.set("per_page", "1");
  url.searchParams.set("page", "1");
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "rivet-review-context",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response || response.status !== 200)
    fail("GitHub changed-file request failed");
  const responseText = await boundedResponseText(response, maxResponseBytes);
  if (responseText === null)
    return incomplete(metadata, "GitHub comparison response is too large");
  let comparison;
  try {
    comparison = JSON.parse(responseText);
  } catch {
    fail("GitHub changed-file response is invalid");
  }
  const rawFiles = comparison?.files;
  if (!Array.isArray(rawFiles) || rawFiles.length !== metadata.changedFiles)
    return incomplete(metadata, "GitHub changed-file response is incomplete");
  const files = rawFiles.map(projectFile);
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  if (files.some((file) => !hasCompletePatch(file, filesByPath)))
    return incomplete(
      metadata,
      "GitHub comparison omits a complete changed-file patch",
    );
  const snapshot = {
    schemaVersion: 1,
    complete: true,
    repository: metadata.repository,
    pullNumber: metadata.pullNumber,
    baseSha: metadata.baseSha,
    headSha: metadata.headSha,
    files,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > maxSnapshotBytes)
    return incomplete(
      metadata,
      `comparison exceeds the ${maxSnapshotBytes}-byte review budget`,
    );
  return Object.freeze(snapshot);
}

export async function runPrepareReviewContextAction({
  env = process.env,
  statImpl = stat,
  readFileImpl = readFile,
  appendFileImpl = appendFile,
  fetchImpl = fetch,
} = {}) {
  if (!env.GITHUB_EVENT_PATH || !env.GITHUB_OUTPUT)
    fail("GitHub event and output paths are required");
  const eventMetadata = await statImpl(env.GITHUB_EVENT_PATH);
  if (!eventMetadata.isFile() || eventMetadata.size > MAX_EVENT_BYTES)
    fail("GitHub event is invalid");
  const event = JSON.parse(await readFileImpl(env.GITHUB_EVENT_PATH, "utf8"));
  const snapshot = await createReviewContext({
    event,
    expectedRepository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL,
    fetchImpl,
  });
  if (!snapshot.complete) fail(snapshot.reason);
  await appendFileImpl(
    env.GITHUB_OUTPUT,
    `snapshot=${JSON.stringify(snapshot)}\n`,
    "utf8",
  );
  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPrepareReviewContextAction().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
