import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectInstalledApp,
  inspectInstalledAppRegistration,
  runAppCredentialProbe,
  runMaintenanceDryRun,
  verifyInstalledPackage,
} from "../src/verification-adapters.mjs";
import { createRecordingRunner, result } from "./helpers.mjs";

const ROOT = "/repo/widget";
const REPOSITORY = "acme/widget";
const CLIENT_ID = "Iv123456789012345678";
const INTEGRITY = `sha512-${Buffer.alloc(64, 0xab).toString("base64")}`;

test("package verification keeps the package build commit separate from the installer source checkpoint", async () => {
  const verified = [];
  const removed = [];
  const runner = createRecordingRunner(() => result());
  assert.equal(
    await verifyInstalledPackage(
      {
        packageRelease: {
          name: "@coryparry/codekeeper",
          version: "1.4.2",
          integrity: INTEGRITY,
        },
        installation: {
          releaseManifest: { source: { commit: "a".repeat(40) } },
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
          root: "/tmp/codekeeper-stage",
          executable:
            "/tmp/codekeeper-stage/install/node_modules/@coryparry/codekeeper/bin/codekeeper.mjs",
        }),
        verifyRelease: async (options) => verified.push(options),
        remove: async (...args) => removed.push(args),
      },
    ),
    true,
  );
  assert.deepEqual(verified, [
    {
      root: "/tmp/codekeeper-stage/install/node_modules/@coryparry/codekeeper",
      expectedName: "@coryparry/codekeeper",
      expectedVersion: "1.4.2",
      expectedIntegrity: INTEGRITY,
    },
  ]);
  assert.deepEqual(removed, [
    ["/tmp/codekeeper-stage", { recursive: true, force: true }],
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
  installationPermissions = permissions,
  events = [],
  repositorySelection = "selected",
  suspendedAt = null,
  repositories = [REPOSITORY],
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
    if (
      key ===
      "gh api --hostname github.com user/installations --paginate --slurp"
    ) {
      return result(
        JSON.stringify([
          {
            installations: [
              {
                id: 42,
                app_slug: "codekeeper-acme",
                repository_selection: repositorySelection,
                suspended_at: suspendedAt,
                permissions: installationPermissions,
              },
            ],
          },
        ]),
      );
    }
    if (
      key ===
      "gh api --hostname github.com user/installations/42/repositories?per_page=2"
    ) {
      return result(
        JSON.stringify({
          total_count: repositories.length,
          repositories: repositories.map((fullName) => ({
            full_name: fullName,
          })),
        }),
      );
    }
    throw new Error(`Unexpected command: ${key}`);
  });
}

test("App proof requires the exact identity, permission set, and one selected repository", async () => {
  const runner = appRunner();
  assert.equal(
    await inspectInstalledApp({ runner, root: ROOT, repository: REPOSITORY }),
    true,
  );
  assert.equal(
    runner.calls.some((call) => call.args.includes("secret")),
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

test("App proof rejects stale or excessive installed permissions and reports the exact delta", async () => {
  const stale = await inspectInstalledAppRegistration({
    runner: appRunner({
      installationPermissions: {
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
    registered: "write",
    installed: "read"
  }]);

  assert.equal(await inspectInstalledApp({
    runner: appRunner({
      installationPermissions: {
        contents: "write",
        issues: "write",
        metadata: "read",
        pull_requests: "write",
        actions: "read"
      }
    }),
    root: ROOT,
    repository: REPOSITORY
  }), false);
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
    if (key.startsWith("gh workflow run codekeeper-maintain.yml"))
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

test("App proof rejects broad, suspended, and multi-repository installations", async () => {
  const variants = [
    { repositorySelection: "all" },
    { suspendedAt: "2026-08-17T00:00:00Z" },
    { repositories: [REPOSITORY, "acme/another"] },
    { repositories: ["acme/another"] },
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

function credentialRunner({ matchingIds = [201], jobs = [{ name: "Codekeeper App credential verification", conclusion: "success" }] } = {}) {
  return createRecordingRunner(({ command, args, options }) => {
    const key = `${command} ${args.join(" ")}`;
    if (key.startsWith("gh workflow run codekeeper-assistant.yml")) return result();
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
