import { createHash, createSign } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const API = "https://api.github.com";
const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_PATCH_FILES = 25;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function fail(message) {
  throw new Error(`Rivet repair publication: ${message}`);
}

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createAppJwt({ clientId, privateKey, now = Date.now() }) {
  if (!/^Iv[0-9A-Za-z]{18}$/.test(clientId ?? ""))
    fail("invalid App client id");
  if (!privateKey?.includes("BEGIN RSA PRIVATE KEY"))
    fail("invalid App private key");
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: clientId,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

async function githubJson(
  pathname,
  token,
  { fetchImpl, method = "GET", body } = {},
) {
  const response = await fetchImpl(`${API}${pathname}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) fail(`GitHub API request failed (${response.status})`);
  return response.json();
}

function repairAuthorization(event) {
  const repository = event?.repository?.full_name;
  const pullRequest = event?.issue?.number;
  const comment = event?.comment;
  if (!REPOSITORY.test(repository ?? "")) fail("invalid repository event");
  if (
    !Number.isSafeInteger(pullRequest) ||
    pullRequest < 1 ||
    !event.issue.pull_request
  ) {
    fail("command did not target a pull request");
  }
  if (
    comment?.body !== "/rivet-repair" ||
    !Number.isSafeInteger(comment.id) ||
    comment.id < 1 ||
    !TRUSTED_ASSOCIATIONS.has(comment.author_association) ||
    typeof comment?.user?.login !== "string" ||
    !ISO_INSTANT.test(comment.created_at ?? "")
  ) {
    fail("invalid repair authorization comment");
  }
  return Object.freeze({
    repository,
    pullRequest,
    authorization: Object.freeze({
      actor: comment.user.login,
      commentId: comment.id,
      createdAt: comment.created_at,
    }),
  });
}

export function parseRepairRequest({ event, agentOutput, outputType }) {
  const request = repairAuthorization(event);
  const items =
    agentOutput?.items?.filter(({ type }) => type === outputType) ?? [];
  if (items.length !== 1 || typeof items[0].patch !== "string") {
    fail("requires exactly one repair patch");
  }
  return Object.freeze({
    ...request,
    patch: items[0].patch,
  });
}

export function parsePublicationRequest({ event, agentOutput }) {
  const request = repairAuthorization(event);
  const items =
    agentOutput?.items?.filter(({ type }) => type === "publish_repair") ?? [];
  if (
    items.length !== 1 ||
    items[0].confirmation !== "publish-validated-repair"
  ) {
    fail("requires one validated repair publication confirmation");
  }
  return request;
}

function safePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
  );
}

function protectedPath(value) {
  const basename = value.split("/").at(-1)?.toUpperCase();
  return (
    value.startsWith(".github/") ||
    value === ".gitmodules" ||
    basename === "AGENTS.MD" ||
    basename === "CODEOWNERS" ||
    basename === "SECURITY.MD"
  );
}

export function inspectRepairPatch(patch) {
  if (
    typeof patch !== "string" ||
    Buffer.byteLength(patch) < 1 ||
    Buffer.byteLength(patch) > MAX_PATCH_BYTES ||
    patch.includes("GIT binary patch") ||
    patch.includes("Binary files ")
  ) {
    fail("patch is empty, oversized, or binary");
  }
  const paths = [
    ...patch.matchAll(/^diff --git a\/([^\s]+) b\/([^\s]+)$/gm),
  ].map(([, before, after]) => {
    if (before !== after || !safePath(after) || protectedPath(after)) {
      fail("patch contains a renamed, unsafe, or protected path");
    }
    return after;
  });
  if (
    paths.length < 1 ||
    paths.length > MAX_PATCH_FILES ||
    new Set(paths).size !== paths.length ||
    /^(new file mode|deleted file mode|rename from|rename to) /m.test(patch)
  ) {
    fail("patch must modify 1 to 25 existing files exactly once");
  }
  return Object.freeze(paths);
}

export function normalizeRepairPatch(patch) {
  if (typeof patch !== "string" || patch.length < 1) {
    fail("patch is empty, oversized, or binary");
  }
  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

function reviewFingerprint(review, comments) {
  const input = {
    reviewId: review.id,
    body: review.body ?? "",
    comments: comments
      .map(({ id, path, line, body }) => ({ id, path, line, body }))
      .sort((left, right) => left.id - right.id),
  };
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function mintAppToken(request, env, fetchImpl) {
  const jwt = createAppJwt({
    clientId: env.RIVET_APP_CLIENT_ID,
    privateKey: env.RIVET_APP_PRIVATE_KEY,
  });
  const app = await githubJson("/app", jwt, { fetchImpl });
  const installation = await githubJson(
    `/repos/${request.repository}/installation`,
    jwt,
    {
      fetchImpl,
    },
  );
  const access = await githubJson(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    {
      fetchImpl,
      method: "POST",
      body: {
        repositories: [request.repository.split("/")[1]],
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
      },
    },
  );
  if (typeof app.slug !== "string" || typeof access.token !== "string") {
    fail("App token response was incomplete");
  }
  const login = `${app.slug}[bot]`;
  const bot = await githubJson(
    `/users/${encodeURIComponent(login)}`,
    access.token,
    {
      fetchImpl,
    },
  );
  if (!Number.isSafeInteger(bot.id) || bot.id < 1)
    fail("App bot identity was incomplete");
  return { appSlug: app.slug, botId: bot.id, token: access.token };
}

async function reviewedHead(request, expected, appSlug, token, fetchImpl) {
  const pull = await githubJson(
    `/repos/${request.repository}/pulls/${request.pullRequest}`,
    token,
    {
      fetchImpl,
    },
  );
  if (
    pull?.head?.repo?.full_name !== request.repository ||
    pull?.head?.sha !== expected.headSha ||
    pull?.head?.ref !== expected.headRef
  ) {
    fail("repair requires a same-repository pull request");
  }
  const reviews = await githubJson(
    `/repos/${request.repository}/pulls/${request.pullRequest}/reviews?per_page=100`,
    token,
    { fetchImpl },
  );
  const login = `${appSlug}[bot]`;
  const review = reviews
    .filter(
      (candidate) =>
        candidate?.user?.login === login &&
        candidate.commit_id === expected.headSha &&
        candidate.submitted_at <= request.authorization.createdAt,
    )
    .sort((left, right) => right.id - left.id)[0];
  if (!review)
    fail("current head has no App-authored review before authorization");
  const comments = await githubJson(
    `/repos/${request.repository}/pulls/${request.pullRequest}/reviews/${review.id}/comments?per_page=100`,
    token,
    { fetchImpl },
  );
  if (!Array.isArray(comments) || comments.length < 1) {
    fail("review has no concrete inline findings");
  }
  return {
    headSha: expected.headSha,
    headRef: expected.headRef,
    reviewId: review.id,
    findingsFingerprint: reviewFingerprint(review, comments),
  };
}

async function defaultRun(command, args, options = {}) {
  try {
    const { stdout = "" } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeout,
    });
    return stdout.trim();
  } catch (cause) {
    const detail = String(
      cause?.stderr || cause?.stdout || cause?.message || "command failed",
    ).trim();
    fail(`${options.label ?? command} failed${detail ? `: ${detail}` : ""}`);
  }
}

function gitAuthEnvironment(token, env) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export async function runPublishRepairAction({
  env = process.env,
  fetchImpl = fetch,
  run = defaultRun,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  appendFileImpl = appendFile,
} = {}) {
  const event = JSON.parse(await readFileImpl(env.GITHUB_EVENT_PATH, "utf8"));
  const agentOutput = JSON.parse(
    await readFileImpl(env.GH_AW_AGENT_OUTPUT, "utf8"),
  );
  const request = parsePublicationRequest({ event, agentOutput });
  const artifactRoot = env.RIVET_REPAIR_ARTIFACT;
  const validatedPatch = normalizeRepairPatch(
    await readFileImpl(`${artifactRoot}/patch.diff`, "utf8"),
  );
  const validationReceipt = JSON.parse(
    await readFileImpl(`${artifactRoot}/receipt.json`, "utf8"),
  );
  const paths = inspectRepairPatch(validatedPatch);
  if (
    validationReceipt?.schemaVersion !== 1 ||
    validationReceipt.repository !== request.repository ||
    validationReceipt.pullRequest !== request.pullRequest ||
    JSON.stringify(validationReceipt.authorization) !==
      JSON.stringify(request.authorization) ||
    !FULL_SHA.test(validationReceipt.headSha ?? "") ||
    typeof validationReceipt.headRef !== "string" ||
    validationReceipt.patchSha256 !==
      createHash("sha256").update(validatedPatch).digest("hex") ||
    JSON.stringify(validationReceipt.changedPaths) !==
      JSON.stringify([...paths].sort()) ||
    !Array.isArray(validationReceipt.validation) ||
    validationReceipt.validation.length < 1 ||
    validationReceipt.validation.length > 10 ||
    validationReceipt.validation.some(
      ({ command, exitCode }) =>
        typeof command !== "string" ||
        command.length < 1 ||
        command.length > 256 ||
        /[\0\r\n`]/.test(command) ||
        exitCode !== 0,
    )
  ) {
    fail("validation receipt is invalid");
  }
  const { appSlug, botId, token } = await mintAppToken(request, env, fetchImpl);
  const reviewed = await reviewedHead(
    request,
    validationReceipt,
    appSlug,
    token,
    fetchImpl,
  );
  const cwd = env.GITHUB_WORKSPACE;
  const authenticatedEnv = gitAuthEnvironment(token, env);

  await run("git", ["fetch", "--no-tags", "origin", reviewed.headSha], {
    cwd,
    env: authenticatedEnv,
    label: "fetch reviewed head",
  });
  await run("git", ["checkout", "--detach", reviewed.headSha], { cwd, env });
  const patchPath = `${env.RUNNER_TEMP}/rivet-repair.patch`;
  await writeFileImpl(patchPath, validatedPatch, { mode: 0o600 });
  await run("git", ["apply", "--check", "--whitespace=error-all", patchPath], {
    cwd,
    env,
  });
  await run("git", ["apply", "--whitespace=error-all", patchPath], {
    cwd,
    env,
  });
  const changed = (
    await run("git", ["diff", "--name-only", "-z"], { cwd, env })
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  if (JSON.stringify(changed) !== JSON.stringify([...paths].sort())) {
    fail("applied files do not match the proposed patch");
  }

  const live = await githubJson(
    `/repos/${request.repository}/pulls/${request.pullRequest}`,
    token,
    {
      fetchImpl,
    },
  );
  if (
    live?.head?.sha !== reviewed.headSha ||
    live?.head?.ref !== reviewed.headRef
  ) {
    fail("authorized pull request head changed before publication");
  }
  await run("git", ["config", "user.name", `${appSlug}[bot]`], { cwd, env });
  await run(
    "git",
    [
      "config",
      "user.email",
      `${botId}+${appSlug}[bot]@users.noreply.github.com`,
    ],
    {
      cwd,
      env,
    },
  );
  await run("git", ["add", "--", ...paths], { cwd, env });
  await run("git", ["commit", "-m", "fix: apply authorized Rivet repair"], {
    cwd,
    env,
  });
  const repairCommitSha = await run("git", ["rev-parse", "HEAD"], { cwd, env });
  if (!FULL_SHA.test(repairCommitSha) || repairCommitSha === reviewed.headSha) {
    fail("repair commit is invalid");
  }
  await run(
    "git",
    [
      "push",
      `--force-with-lease=refs/heads/${reviewed.headRef}:${reviewed.headSha}`,
      "origin",
      `HEAD:refs/heads/${reviewed.headRef}`,
    ],
    { cwd, env: authenticatedEnv, label: "publish repair commit" },
  );

  const receipt = Object.freeze({
    schemaVersion: 1,
    repository: request.repository,
    pullRequest: request.pullRequest,
    review: {
      id: reviewed.reviewId,
      headSha: reviewed.headSha,
      findingsFingerprint: reviewed.findingsFingerprint,
    },
    authorization: request.authorization,
    repair: {
      commitSha: repairCommitSha,
      validation: validationReceipt.validation,
    },
  });
  if (env.GITHUB_OUTPUT) {
    await appendFileImpl(
      env.GITHUB_OUTPUT,
      `receipt=${JSON.stringify(receipt)}\n`,
      "utf8",
    );
  }
  return receipt;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPublishRepairAction().catch((error) => {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  });
}
