import { createPrivateKey, createSign } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  reviewAppAuthority,
  RIVET_APP_CLIENT_ID_VARIABLE,
  RIVET_APP_PRIVATE_KEY_SECRET,
} from "./app-authority.mjs";

const CLIENT_ID = /^Iv[A-Za-z0-9]{18}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const GITHUB_API = "https://api.github.com";

function required(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Rivet App setup: invalid ${label}`);
  }
  return value;
}

function validRepository(repository) {
  return (
    REPOSITORY.test(repository ?? "") &&
    repository
      .split("/")
      .every((segment) => segment !== "." && segment !== "..")
  );
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function readPrivateKeyFile(privateKeyPath) {
  if (typeof privateKeyPath !== "string" || !privateKeyPath) {
    throw new Error("Rivet App setup: private-key file is required");
  }
  let handle;
  try {
    handle = await open(
      privateKeyPath,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("Rivet App setup: private-key file could not be read safely");
  }
  let privateKey;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_PRIVATE_KEY_BYTES
    ) {
      throw new Error(
        "Rivet App setup: private-key file must be a bounded regular file",
      );
    }
    const buffer = Buffer.alloc(metadata.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== metadata.size) {
      throw new Error(
        "Rivet App setup: private-key file changed while it was read",
      );
    }
    privateKey = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  try {
    createPrivateKey(privateKey);
  } catch {
    privateKey.fill(0);
    throw new Error("Rivet App setup: private-key file is not a valid key");
  }
  return privateKey;
}

export function createAppJwt({ clientId, privateKey, now = Date.now }) {
  required(clientId, CLIENT_ID, "client ID");
  const issuedAt = Math.floor(now() / 1000) - 30;
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: issuedAt, exp: issuedAt + 540, iss: clientId });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

async function githubJson(pathname, jwt, fetchImpl) {
  const response = await fetchImpl(`${GITHUB_API}${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Rivet App setup: GitHub verification failed (${response.status})`,
    );
  }
  return response.json();
}

async function runGh(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (destination) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        reject(new Error("Rivet App setup: GitHub CLI output exceeded the limit"));
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => reject(new Error("Rivet App setup: GitHub CLI failed")));
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error("Rivet App setup: GitHub CLI failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.end(input);
  });
}

async function appIdentity({ clientId, privateKey, fetchImpl, now }) {
  const jwt = createAppJwt({ clientId, privateKey, now });
  const app = await githubJson("/app", jwt, fetchImpl);
  if (
    app?.client_id !== clientId ||
    !Number.isSafeInteger(app?.id) ||
    typeof app?.slug !== "string" ||
    !app.slug
  ) {
    throw new Error("Rivet App setup: GitHub returned an unexpected App identity");
  }
  return { app, jwt };
}

export async function configureReviewApp({
  repository,
  clientId,
  privateKeyPath,
  run = runGh,
  fetchImpl = fetch,
  now,
}) {
  if (!validRepository(repository)) {
    throw new Error("Rivet App setup: invalid repository");
  }
  required(clientId, CLIENT_ID, "client ID");
  const privateKey = await readPrivateKeyFile(privateKeyPath);
  try {
    const { app } = await appIdentity({ clientId, privateKey, fetchImpl, now });
    await run([
      "variable",
      "set",
      RIVET_APP_CLIENT_ID_VARIABLE,
      "--repo",
      repository,
      "--body",
      clientId,
    ]);
    await run(
      ["secret", "set", RIVET_APP_PRIVATE_KEY_SECRET, "--repo", repository],
      { input: privateKey },
    );
    return Object.freeze({
      repository,
      appId: app.id,
      appSlug: app.slug,
      clientIdVariable: RIVET_APP_CLIENT_ID_VARIABLE,
      privateKeySecret: RIVET_APP_PRIVATE_KEY_SECRET,
      installationUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
    });
  } finally {
    privateKey.fill(0);
  }
}

export async function verifyReviewApp({
  repository,
  clientId,
  privateKeyPath,
  run = runGh,
  fetchImpl = fetch,
  now,
}) {
  if (!validRepository(repository)) {
    throw new Error("Rivet App setup: invalid repository");
  }
  required(clientId, CLIENT_ID, "client ID");
  const privateKey = await readPrivateKeyFile(privateKeyPath);
  let app;
  let installation;
  try {
    const identity = await appIdentity({
      clientId,
      privateKey,
      fetchImpl,
      now,
    });
    app = identity.app;
    installation = await githubJson(
      `/repos/${repository}/installation`,
      identity.jwt,
      fetchImpl,
    );
  } finally {
    privateKey.fill(0);
  }
  const variables = JSON.parse(
    await run(["variable", "list", "--repo", repository, "--json", "name,value"]),
  );
  const secrets = JSON.parse(
    await run(["secret", "list", "--repo", repository, "--json", "name"]),
  );
  const configuredClientId = variables.find(
    ({ name }) => name === RIVET_APP_CLIENT_ID_VARIABLE,
  )?.value;
  const hasPrivateKey = secrets.some(
    ({ name }) => name === RIVET_APP_PRIVATE_KEY_SECRET,
  );
  const expected = reviewAppAuthority();
  const actualPermissions = {
    contents: installation?.permissions?.contents,
    metadata: installation?.permissions?.metadata,
    pullRequests: installation?.permissions?.pull_requests,
  };
  const extraPermissions = Object.entries(installation?.permissions ?? {})
    .filter(
      ([name, value]) =>
        !["contents", "metadata", "pull_requests"].includes(name) &&
        value !== "none",
    )
    .map(([name]) => name);
  if (
    installation?.app_id !== app.id ||
    installation?.app_slug !== app.slug ||
    installation?.repository_selection !== "selected" ||
    (installation?.events ?? []).length !== 0 ||
    JSON.stringify(actualPermissions) !== JSON.stringify(expected.permissions) ||
    extraPermissions.length > 0 ||
    configuredClientId !== clientId ||
    !hasPrivateKey
  ) {
    throw new Error(
      "Rivet App setup: effective installation authority does not match the review plan",
    );
  }
  return Object.freeze({
    repository,
    appId: app.id,
    appSlug: app.slug,
    repositorySelection: installation.repository_selection,
    permissions: expected.permissions,
    credentialsConfigured: true,
  });
}
