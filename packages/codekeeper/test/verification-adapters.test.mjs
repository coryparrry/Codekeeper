import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectInstalledApp,
  inspectInstalledAppRegistration,
  runAppCredentialProbe,
  runMaintenanceDryRun,
  verifyInstalledPackage,
} from "../src/verification-adapters.mjs";
import { createRecordingRunner, result, temporaryDirectory } from "./helpers.mjs";

const ROOT = "/repo/widget";
const REPOSITORY = "acme/widget";
const CLIENT_ID = "Iv123456789012345678";
const INTEGRITY = `sha512-${Buffer.alloc(64, 0xab).toString("base64")}`;

test("package verification keeps the package build commit separate from the installer source checkpoint", async (t) => {
  const verified = [];
  const removed = [];
  const runner = createRecordingRunner(() => result());
  const stageRoot = await temporaryDirectory(t, "codekeeper-stage-");
  const packageRoot = path.join(
    stageRoot,
    "install",
    "node_modules",
    "@coryparry",
    "codekeeper",
  );
  const source = {
    repository: "coryparrry/Codekeeper",
    commit: "a".repeat(40),
  };
  await mkdir(path.join(packageRoot, "assets"), { recursive: true });
  await mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await mkdir(path.join(packageRoot, "release"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "assets", "metadata.json"),
    `${JSON.stringify({ version: 1, source })}\n`,
  );
  assert.equal(
    await verifyInstalledPackage(
      {
        packageRelease: {
          name: "@coryparry/codekeeper",
          version: "1.4.2",
          integrity: INTEGRITY,
        },
        installation: {
          releaseManifest: { source },
        },
        root: ROOT,
      },
      {
        runner,
        environment: { PATH: "/trusted/bin" },
        platform: "linux",
        resolveNpm: async () => "/trusted/lib/node_modules/npm/bin/npm-cli.js",
        resolveRelease: async () => ({
          npmCli: "/trusted/lib/node_modules/npm/bin/npm-cli.js",
          version: "1.4.2",
          integrity: INTEGRITY,
        }),
        stagePackage: async () => ({
          root: stageRoot,
          executable: path.join(packageRoot, "bin", "codekeeper.mjs"),
        }),
        verifyRelease: async (options) => verified.push(options),
        remove: async (...args) => removed.push(args),
      },
    ),
    true,
  );
  assert.deepEqual(verified, [
    {
      root: packageRoot,
      expectedName: "@coryparry/codekeeper",
      expectedVersion: "1.4.2",
      expectedIntegrity: INTEGRITY,
    },
  ]);
  assert.deepEqual(removed, [
    [stageRoot, { recursive: true, force: true }],
  ]);
});

function appRunner({
  clientId = CLIENT_ID,
  permissions = {
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  },
  events = [],
} = {}) {
  return createRecordingRunner(({ command, args }) => {
    const key = `${command} ${args.join(" ")}`;
    if (key.startsWith("gh variable get CODEKEEPER_APP_CLIENT_ID ")) {
      return result(`${CLIENT_ID}\n`);
    }
    if (key.startsWith("gh variable get CODEKEEPER_AUTOMATION_BOT_LOGIN ")) {
      return result("codekeeper-acme[bot]\n");
    }
    if (key === "gh api --hostname github.com apps/codekeeper-acme") {
      return result(
        JSON.stringify({ client_id: clientId, permissions, events, owner: { login: "acme", type: "Organization" } }),
      );
    }
    throw new Error(`Unexpected command: ${key}`);
  });
}

test("App proof requires the exact public registration without querying user installations", async () => {
  const runner = appRunner();
  assert.equal(
    await inspectInstalledApp({ runner, root: ROOT, repository: REPOSITORY }),
    true,
  );
  assert.equal(
    runner.calls.some((call) => call.args.includes("secret")),
    false,
  );
  assert.equal(
    runner.calls.some((call) => call.args.includes("user/installations")),
    false,
  );
});

test("App proof derives least privilege from the installed capabilities", async () => {
  const installation = {
    modes: ["review"],
    policy: {
      automation: { ownerRequests: false },
      review: { autoRepair: false },
      audit: { repair: { enabled: false } },
      issues: { allowAiImplementation: false },
      merge: { enabled: false }
    }
  };
  assert.equal(
    await inspectInstalledApp({
      runner: appRunner({
        permissions: {
          contents: "read",
          issues: "write",
          metadata: "read",
          pull_requests: "write"
        }
      }),
      root: ROOT,
      repository: REPOSITORY,
      installation
    }),
    true
  );
  assert.equal(
    await inspectInstalledApp({
      runner: appRunner(),
      root: ROOT,
      repository: REPOSITORY,
      installation
    }),
    false
  );
});

test("App proof reuses a safe variable snapshot without extra GitHub setting reads", async () => {
  const runner = appRunner();
  const variables = new Map([
    ["CODEKEEPER_APP_CLIENT_ID", CLIENT_ID],
    ["CODEKEEPER_AUTOMATION_BOT_LOGIN", "codekeeper-acme[bot]"],
  ]);
  assert.equal(
    await inspectInstalledApp({
      runner,
      root: ROOT,
      repository: REPOSITORY,
      variables,
    }),
    true,
  );
  assert.equal(
    runner.calls.some((call) => call.args[0] === "variable"),
    false,
  );
});

test("App proof rejects extra permissions, subscribed events, and a mismatched client ID", async () => {
  const variants = [
    {
      permissions: {
        contents: "write",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        actions: "read",
      },
    },
    { events: ["pull_request"] },
    { clientId: "Iv000000000000000000" },
  ];
  for (const variant of variants) {
    assert.equal(
      await inspectInstalledApp({
        runner: appRunner(variant),
        root: ROOT,
        repository: REPOSITORY,
      }),
      false,
    );
  }
});

test("App proof rejects stale registration permissions and reports the exact delta", async () => {
  const stale = await inspectInstalledAppRegistration({
    runner: appRunner({
      permissions: {
        contents: "read",
        issues: "write",
        metadata: "read",
        pull_requests: "write"
      }
    }),
    root: ROOT,
    repository: REPOSITORY
  });
  assert.equal(stale.status, "mismatch");
  assert.equal(stale.reason, "permissions");
  assert.match(stale.settingsUrl, /organizations\/acme\/settings\/apps\/codekeeper-acme\/permissions$/);
  assert.deepEqual(stale.permissionDelta, [{
    permission: "contents",
    required: "write",
    registered: "read"
  }]);
});

const VERIFICATION_ID = "123e4567-e89b-12d3-a456-426614174000";

function dryRunRunner({ matchingIds = [101], jobs = [] } = {}) {
  return createRecordingRunner(({ command, args, options }) => {
    const key = `${command} ${args.join(" ")}`;
    if (key.includes("gh run list")) {
      return result(JSON.stringify([
        { databaseId: 100, displayTitle: "Codekeeper maintenance verification another-run" },
        ...matchingIds.map((databaseId) => ({
          databaseId,
          displayTitle: `Codekeeper maintenance verification ${VERIFICATION_ID}`,
        })),
      ]));
    }
    if (key.startsWith("gh workflow run codekeeper.yml"))
      return result();
    if (key === `gh run watch 101 --repo ${REPOSITORY} --exit-status`) {
      assert.equal(options.stdio, "ignore");
      return result();
    }
    if (key === `gh run view 101 --repo ${REPOSITORY} --json jobs`) {
      return result(JSON.stringify({ jobs }));
    }
    throw new Error(`Unexpected command: ${key}`);
  });
}

const successfulJobs = [
  "Codekeeper maintenance workspace specialist",
  "Codekeeper maintenance analysis",
  "Codekeeper maintenance verification",
].map((name) => ({ name, conclusion: "success" }));

test("controlled maintenance correlates one new dispatch and proves required jobs", async () => {
  const runner = dryRunRunner({ jobs: successfulJobs });
  const passed = await runMaintenanceDryRun(
    {
      runner,
      root: ROOT,
      repository: REPOSITORY,
      installation: {
        modes: ["maintain"],
        policy: { repository: { defaultBranch: "main" } },
      },
    },
    { wait: async () => {}, verificationId: VERIFICATION_ID },
  );
  assert.equal(passed, true);
});

test("controlled maintenance rejects ambiguous dispatches and skipped model jobs", async () => {
  const installation = {
    modes: ["maintain"],
    policy: { repository: { defaultBranch: "main" } },
  };
  assert.equal(
    await runMaintenanceDryRun(
      {
        runner: dryRunRunner({
          matchingIds: [101, 102],
          jobs: successfulJobs,
        }),
        root: ROOT,
        repository: REPOSITORY,
        installation,
      },
      { wait: async () => {}, verificationId: VERIFICATION_ID },
    ),
    false,
  );
  assert.equal(
    await runMaintenanceDryRun(
      {
        runner: dryRunRunner({ jobs: successfulJobs.slice(0, 2) }),
        root: ROOT,
        repository: REPOSITORY,
        installation,
      },
      { wait: async () => {}, verificationId: VERIFICATION_ID },
    ),
    false,
  );
});

function credentialRunner({ matchingIds = [201], jobs = [{ name: "Codekeeper App credential verification", conclusion: "success" }] } = {}) {
  return createRecordingRunner(({ command, args, options }) => {
    const key = `${command} ${args.join(" ")}`;
    if (key.startsWith("gh workflow run codekeeper.yml")) {
      assert.match(key, /--field verify_app_credentials=true/);
      assert.match(key, new RegExp(`--field verification_id=${VERIFICATION_ID}`));
      return result();
    }
    if (key.includes("gh run list")) {
      return result(JSON.stringify([
        { databaseId: 200, displayTitle: "Codekeeper App credential verification another-run" },
        ...matchingIds.map((databaseId) => ({
          databaseId,
          displayTitle: `Codekeeper App credential verification ${VERIFICATION_ID}`
        }))
      ]));
    }
    if (key === `gh run watch 201 --repo ${REPOSITORY} --exit-status`) {
      assert.equal(options.stdio, "ignore");
      return result();
    }
    if (key === `gh run view 201 --repo ${REPOSITORY} --json jobs`) {
      return result(JSON.stringify({ jobs }));
    }
    throw new Error(`Unexpected command: ${key}`);
  });
}

test("App credential probe correlates one no-mutation assistant dispatch and exact job", async () => {
  const input = {
    runner: credentialRunner(),
    root: ROOT,
    repository: REPOSITORY,
    installation: { policy: { repository: { defaultBranch: "main" } } }
  };
  assert.equal(await runAppCredentialProbe(input, { wait: async () => {}, verificationId: VERIFICATION_ID }), true);
  assert.equal(await runAppCredentialProbe({ ...input, runner: credentialRunner({ matchingIds: [201, 202] }) }, { wait: async () => {}, verificationId: VERIFICATION_ID }), false);
  assert.equal(await runAppCredentialProbe({ ...input, runner: credentialRunner({ jobs: [] }) }, { wait: async () => {}, verificationId: VERIFICATION_ID }), false);
});
