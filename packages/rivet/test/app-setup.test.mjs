import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureReviewApp,
  createAppJwt,
  readPrivateKeyFile,
  verifyRepairApp,
  verifyReviewApp,
} from "../src/app-setup.mjs";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";

const CLIENT_ID = "Iv123456789012345678";
const REPOSITORY = "acme/example";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function keyFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-app-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyBytes = Buffer.from(
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  const privateKeyPath = path.join(root, "rivet.pem");
  await writeFile(privateKeyPath, privateKeyBytes, { mode: 0o600 });
  return { root, privateKeyBytes, privateKeyPath, publicKey };
}

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function app() {
  return { id: 42, client_id: CLIENT_ID, slug: "rivet-review" };
}

function installation(overrides = {}) {
  return {
    app_id: 42,
    app_slug: "rivet-review",
    repository_selection: "selected",
    events: [],
    permissions: {
      contents: "read",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
    },
    ...overrides,
  };
}

test("creates a bounded signed GitHub App JWT", async (t) => {
  const { privateKeyBytes, publicKey } = await keyFixture(t);
  const now = () => 1_800_000_000_000;
  const jwt = createAppJwt({
    clientId: CLIENT_ID,
    privateKey: privateKeyBytes,
    now,
  });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "RS256",
    typ: "JWT",
  });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, CLIENT_ID);
  assert.equal(claims.exp - claims.iat, 540);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
});

test("reads only bounded regular private keys", async (t) => {
  const { root, privateKeyBytes, privateKeyPath } = await keyFixture(t);
  const loaded = await readPrivateKeyFile(privateKeyPath);
  assert.equal(loaded.length, privateKeyBytes.length);
  assert.equal(digest(loaded), digest(privateKeyBytes));
  const linked = path.join(root, "linked.pem");
  await symlink(privateKeyPath, linked);
  await assert.rejects(readPrivateKeyFile(linked), /could not be read safely/);
  const invalid = path.join(root, "invalid.pem");
  await writeFile(invalid, "not a key");
  await assert.rejects(readPrivateKeyFile(invalid), /not a valid key/);
  await assert.rejects(
    readPrivateKeyFile(path.join(root, "missing-private-key-name.pem")),
    (error) =>
      !error.message.includes("missing-private-key-name") &&
      /could not be read safely/.test(error.message),
  );
});

test("configures Rivet credentials without putting the private key in arguments", async (t) => {
  const { privateKeyBytes, privateKeyPath } = await keyFixture(t);
  const calls = [];
  const result = await configureReviewApp({
    repository: REPOSITORY,
    clientId: CLIENT_ID,
    privateKeyPath,
    fetchImpl: async (url) => {
      assert.equal(url, "https://api.github.com/app");
      return response(app());
    },
    run: async (args, options = {}) => {
      calls.push({
        args,
        inputLength: options.input?.length,
        inputDigest: options.input ? digest(options.input) : undefined,
      });
      return "";
    },
  });
  assert.equal(
    result.installationUrl,
    "https://github.com/apps/rivet-review/installations/new",
  );
  assert.deepEqual(calls[0].args, [
    "variable",
    "set",
    "RIVET_APP_CLIENT_ID",
    "--repo",
    REPOSITORY,
    "--body",
    CLIENT_ID,
  ]);
  assert.deepEqual(calls[1].args, [
    "variable",
    "set",
    "RIVET_APP_BOT_LOGIN",
    "--repo",
    REPOSITORY,
    "--body",
    "rivet-review",
  ]);
  assert.deepEqual(calls[2].args, [
    "secret",
    "set",
    "RIVET_APP_PRIVATE_KEY",
    "--repo",
    REPOSITORY,
  ]);
  assert.equal(calls[2].inputLength, privateKeyBytes.length);
  assert.equal(calls[2].inputDigest, digest(privateKeyBytes));
  assert.doesNotMatch(
    JSON.stringify(calls.map(({ args }) => args)),
    /PRIVATE KEY/,
  );
});

test("does not expose a GitHub error response", async (t) => {
  const { privateKeyPath } = await keyFixture(t);
  const responseSecret = "private-response-detail";
  await assert.rejects(
    configureReviewApp({
      repository: REPOSITORY,
      clientId: CLIENT_ID,
      privateKeyPath,
      fetchImpl: async () => response({ message: responseSecret }, 401),
    }),
    (error) =>
      /GitHub verification failed \(401\)/.test(error.message) &&
      !error.message.includes(responseSecret),
  );
});

test("verifies exact selected-repository App authority and credential metadata", async (t) => {
  const { privateKeyPath } = await keyFixture(t);
  const result = await verifyReviewApp({
    repository: REPOSITORY,
    clientId: CLIENT_ID,
    privateKeyPath,
    fetchImpl: async (url) =>
      url.endsWith("/app") ? response(app()) : response(installation()),
    run: async (args) =>
      args[0] === "variable"
        ? JSON.stringify([
            { name: "RIVET_APP_CLIENT_ID", value: CLIENT_ID },
            { name: "RIVET_APP_BOT_LOGIN", value: "rivet-review" },
          ])
        : JSON.stringify([{ name: "RIVET_APP_PRIVATE_KEY" }]),
  });
  assert.deepEqual(result, {
    repository: REPOSITORY,
    appId: 42,
    appSlug: "rivet-review",
    botLoginVariable: "RIVET_APP_BOT_LOGIN",
    repositorySelection: "selected",
    permissions: {
      contents: "read",
      issues: "write",
      metadata: "read",
      pullRequests: "write",
    },
    credentialsConfigured: true,
  });
});

test("accepts an issue-free App when review triage is disabled", async (t) => {
  const { privateKeyPath } = await keyFixture(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.issues.triage = "disabled";
  const result = await verifyReviewApp({
    repository: REPOSITORY,
    clientId: CLIENT_ID,
    privateKeyPath,
    configuration,
    fetchImpl: async (url) =>
      url.endsWith("/app")
        ? response(app())
        : response(
            installation({
              permissions: {
                contents: "read",
                issues: "none",
                metadata: "read",
                pull_requests: "write",
              },
            }),
          ),
    run: async (args) =>
      args[0] === "variable"
        ? JSON.stringify([
            { name: "RIVET_APP_CLIENT_ID", value: CLIENT_ID },
            { name: "RIVET_APP_BOT_LOGIN", value: "rivet-review" },
          ])
        : JSON.stringify([{ name: "RIVET_APP_PRIVATE_KEY" }]),
  });
  assert.deepEqual(result.permissions, {
    contents: "read",
    metadata: "read",
    pullRequests: "write",
  });
});

test("reports malformed installation permissions as an authority mismatch", async (t) => {
  const { privateKeyPath } = await keyFixture(t);
  await assert.rejects(
    verifyReviewApp({
      repository: REPOSITORY,
      clientId: CLIENT_ID,
      privateKeyPath,
      fetchImpl: async (url) =>
        url.endsWith("/app")
          ? response(app())
          : response(installation({ permissions: null })),
      run: async (args) =>
        args[0] === "variable"
          ? JSON.stringify([
              { name: "RIVET_APP_CLIENT_ID", value: CLIENT_ID },
              { name: "RIVET_APP_BOT_LOGIN", value: "rivet-review" },
            ])
          : JSON.stringify([{ name: "RIVET_APP_PRIVATE_KEY" }]),
    }),
    /effective installation authority does not match the review plan/,
  );
});

test("verifies exact repair App authority after an explicit widening", async (t) => {
  const { privateKeyPath } = await keyFixture(t);
  const result = await verifyRepairApp({
    repository: REPOSITORY,
    clientId: CLIENT_ID,
    privateKeyPath,
    fetchImpl: async (url) =>
      url.endsWith("/app")
        ? response(app())
        : response(
            installation({
              permissions: {
                contents: "write",
                metadata: "read",
                pull_requests: "write",
              },
            }),
          ),
    run: async (args) =>
      args[0] === "variable"
        ? JSON.stringify([
            { name: "RIVET_APP_CLIENT_ID", value: CLIENT_ID },
            { name: "RIVET_APP_BOT_LOGIN", value: "rivet-review" },
          ])
        : JSON.stringify([{ name: "RIVET_APP_PRIVATE_KEY" }]),
  });
  assert.deepEqual(result.permissions, {
    contents: "write",
    metadata: "read",
    pullRequests: "write",
  });
});

test("rejects missing, wider, or all-repository App authority", async (t) => {
  const { privateKeyPath } = await keyFixture(t);
  await assert.rejects(
    verifyReviewApp({
      repository: REPOSITORY,
      clientId: CLIENT_ID,
      privateKeyPath,
      fetchImpl: async (url) =>
        url.endsWith("/app") ? response(app()) : response(installation()),
      run: async (args) =>
        args[0] === "variable"
          ? JSON.stringify([{ name: "RIVET_APP_CLIENT_ID", value: CLIENT_ID }])
          : JSON.stringify([{ name: "RIVET_APP_PRIVATE_KEY" }]),
    }),
    /does not match the review plan/,
  );
  for (const installed of [
    installation({ repository_selection: "all" }),
    installation({ events: ["pull_request"] }),
    installation({
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
    }),
    installation({
      permissions: {
        contents: "read",
        metadata: "read",
        pull_requests: "write",
      },
    }),
    installation({
      permissions: {
        contents: "read",
        issues: "read",
        metadata: "read",
        pull_requests: "write",
      },
    }),
  ]) {
    await assert.rejects(
      verifyReviewApp({
        repository: REPOSITORY,
        clientId: CLIENT_ID,
        privateKeyPath,
        fetchImpl: async (url) =>
          url.endsWith("/app") ? response(app()) : response(installed),
        run: async (args) =>
          args[0] === "variable"
            ? JSON.stringify([
                { name: "RIVET_APP_CLIENT_ID", value: CLIENT_ID },
                { name: "RIVET_APP_BOT_LOGIN", value: "rivet-review" },
              ])
            : JSON.stringify([{ name: "RIVET_APP_PRIVATE_KEY" }]),
      }),
      /does not match the review plan/,
    );
  }
});
