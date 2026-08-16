import test from "node:test";
import assert from "node:assert/strict";
import { verifyCodekeeperReadiness } from "../src/verify.mjs";
import {
  createRecordingRunner,
  result,
  TEST_PACKAGE_INTEGRITY,
} from "./helpers.mjs";

const HEAD = "a".repeat(40);
const ROOT = "/repo/widget";
const fakeFs = Object.freeze({});

function installation() {
  return {
    modes: ["review"],
    policy: {
      capabilities: {},
      automation: { ownerRequests: true },
      ai: {
        tracing: { enabled: false },
        agents: {
          review: { provider: "openai", workspace: { enabled: false } },
        },
      },
    },
    releaseManifest: {
      package: {
        name: "codekeeper",
        version: "0.2.0",
        integrity: TEST_PACKAGE_INTEGRITY,
      },
    },
  };
}

function runnerFor({
  repository = "acme/widget",
  branch = "main",
  defaultBranch = "main",
  status = "",
  head = HEAD,
  remote = HEAD,
  variableNames = [
    "CODEKEEPER_ENABLED",
    "CODEKEEPER_APP_CLIENT_ID",
    "CODEKEEPER_AUTOMATION_BOT_LOGIN",
  ],
  secretNames = ["OPENAI_API_KEY", "CODEKEEPER_APP_PRIVATE_KEY"],
  appResult = result("[]\n"),
} = {}) {
  return createRecordingRunner(({ command, args }) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "git rev-parse --show-toplevel") return result(`${ROOT}\n`);
    if (key === "git remote get-url origin")
      return result(`https://github.com/${repository}.git\n`);
    if (
      command === "gh" &&
      args[0] === "api" &&
      args.includes(`repos/${repository}`)
    ) {
      return result(
        JSON.stringify({
          full_name: repository,
          default_branch: defaultBranch,
        }),
      );
    }
    if (key === "git symbolic-ref --quiet --short HEAD")
      return result(`${branch}\n`);
    if (key === "git status --porcelain=v1 --untracked-files=all")
      return result(status);
    if (key === "git rev-parse HEAD") return result(`${head}\n`);
    if (key === `git ls-remote origin refs/heads/${defaultBranch}`) return result(`${remote}\trefs/heads/${defaultBranch}\n`);
    if (key === `gh variable list --repo ${repository} --json name,value`) return result(JSON.stringify(variableNames.map((name) => ({ name, value: "configured" }))));
    if (key === `gh secret list --repo ${repository} --json name`) return result(JSON.stringify(secretNames.map((name) => ({ name }))));
    if (command === "gh" && args[0] === "api" && args.includes("user/installations")) return appResult;
    throw new Error(`Unexpected command: ${key}`);
  });
}

function baseOptions(options = {}) {
  const inspected = options.inspected ?? installation();
  return {
    runner: options.runner ?? runnerFor(),
    cwd: ROOT,
    fsImpl: fakeFs,
    inspectInstallation: async (root, { fsImpl } = {}) => {
      assert.equal(root, ROOT);
      assert.equal(fsImpl, fakeFs);
      return inspected;
    },
    validateInstalledPolicy: () => {},
    ...options,
  };
}

function check(report, id) {
  return report.checks.find((item) => item.id === id);
}

test("verify supports personal and organization GitHub repositories without changing the checkout", async () => {
  for (const repository of ["cory/widget", "acme/widget"]) {
    const runner = runnerFor({ repository });
    const report = await verifyCodekeeperReadiness(
      baseOptions({
        runner,
        inspectApp: async () => true,
        verifyPackage: async () => true,
      }),
    );
    assert.equal(report.repository, repository);
    assert.equal(report.ready, true);
    assert.equal(check(report, "checkout").status, "pass");
    assert.equal(check(report, "controlled-check").status, "skipped");
    assert.equal(
      runner.calls.some(
        (call) => call.command === "git" && call.args[0] === "fetch",
      ),
      false,
    );
  }
});

test("verify fails stale and non-default local checkout evidence", async () => {
  const stale = await verifyCodekeeperReadiness(
    baseOptions({
      runner: runnerFor({ remote: "b".repeat(40) }),
      inspectApp: async () => true,
      verifyPackage: async () => true,
    }),
  );
  assert.equal(stale.ready, false);
  assert.equal(check(stale, "checkout").status, "fail");
  assert.match(check(stale, "checkout").detail, /does not equal/);

  const wrongBranch = await verifyCodekeeperReadiness(
    baseOptions({
      runner: runnerFor({ branch: "feature/verify" }),
      inspectApp: async () => true,
      verifyPackage: async () => true,
    }),
  );
  assert.equal(check(wrongBranch, "checkout").status, "fail");
  assert.match(check(wrongBranch, "checkout").remediation, /default branch/);

  const malformedRemote = await verifyCodekeeperReadiness(
    baseOptions({
      runner: runnerFor({
        remote: `${HEAD}\trefs/heads/main\n${"b".repeat(40)}`
      }),
      inspectApp: async () => true,
      verifyPackage: async () => true
    })
  );
  assert.equal(check(malformedRemote, "checkout").status, "not-provable");
});

test("verify reports a missing managed file without attempting settings or package evidence", async () => {
  const report = await verifyCodekeeperReadiness(
    baseOptions({
      inspectInstallation: async () => {
        throw new Error("missing .github/workflows/codekeeper-review.yml");
      },
    }),
  );
  assert.equal(report.ready, false);
  assert.equal(check(report, "managed-files").status, "fail");
  assert.equal(check(report, "repository-settings").status, "skipped");
  assert.equal(check(report, "package-acquisition").status, "skipped");
});

test("verify checks only repository variable and secret names", async () => {
  const runner = runnerFor({
    variableNames: ["CODEKEEPER_ENABLED"],
    secretNames: ["OPENAI_API_KEY"],
  });
  const report = await verifyCodekeeperReadiness(
    baseOptions({
      runner,
      inspectApp: async () => true,
      verifyPackage: async () => true,
    }),
  );
  const settings = check(report, "repository-settings");
  assert.equal(settings.status, "fail");
  assert.match(settings.detail, /CODEKEEPER_APP_CLIENT_ID/);
  assert.match(settings.detail, /CODEKEEPER_APP_PRIVATE_KEY/);
  const settingCalls = runner.calls.filter((call) =>
    ["variable", "secret"].includes(call.args[0]),
  );
  assert.deepEqual(
    settingCalls.map((call) => call.args.slice(-2)),
    [
      ["--json", "name,value"],
      ["--json", "name"]
    ]
  );
});

test("package acquisition uses the injected exact receipt verifier and controls readiness", async () => {
  let received;
  const pass = await verifyCodekeeperReadiness(
    baseOptions({
      inspectApp: async () => true,
      verifyPackage: async (input) => {
        received = input.packageRelease;
        return true;
      },
    }),
  );
  assert.deepEqual(received, {
    name: "codekeeper",
    version: "0.2.0",
    integrity: TEST_PACKAGE_INTEGRITY,
  });
  assert.equal(check(pass, "package-acquisition").status, "pass");
  assert.equal(pass.ready, true);

  const fail = await verifyCodekeeperReadiness(
    baseOptions({
      inspectApp: async () => true,
      verifyPackage: async () => false,
    }),
  );
  assert.equal(check(fail, "package-acquisition").status, "fail");
  assert.equal(fail.ready, false);
});

test("GitHub App proof is explicitly not-provable when only token-visible installations are available", async () => {
  const report = await verifyCodekeeperReadiness(
    baseOptions({ verifyPackage: async () => true }),
  );
  const app = check(report, "github-app");
  assert.equal(app.status, "not-provable");
  assert.match(app.remediation, /After merge/);
  assert.equal(report.ready, false);
});

test("controlled checks stay skipped unless explicitly requested and supplied", async () => {
  let runs = 0;
  const skipped = await verifyCodekeeperReadiness(
    baseOptions({
      inspectApp: async () => true,
      verifyPackage: async () => true,
      runControlledCheck: async () => {
        runs += 1;
        return true;
      },
    }),
  );
  assert.equal(check(skipped, "controlled-check").status, "skipped");
  assert.equal(runs, 0);

  const optedIn = await verifyCodekeeperReadiness(
    baseOptions({
      controlledCheck: true,
      inspectApp: async () => true,
      verifyPackage: async () => true,
      runControlledCheck: async () => {
        runs += 1;
        return true;
      },
    }),
  );
  assert.equal(check(optedIn, "controlled-check").status, "pass");
  assert.equal(runs, 1);

  const failed = await verifyCodekeeperReadiness(
    baseOptions({
      controlledCheck: true,
      inspectApp: async () => true,
      verifyPackage: async () => true,
      runControlledCheck: async () => false
    })
  );
  assert.equal(check(failed, "controlled-check").status, "fail");
  assert.equal(failed.ready, false);
});

test("controlled checks do not dispatch until every required readiness check passes", async () => {
  let runs = 0;
  const report = await verifyCodekeeperReadiness(
    baseOptions({
      runner: runnerFor({ branch: "feature/verify" }),
      controlledCheck: true,
      inspectApp: async () => true,
      verifyPackage: async () => true,
      runControlledCheck: async () => {
        runs += 1;
        return true;
      }
    })
  );
  assert.equal(runs, 0);
  assert.equal(check(report, "controlled-check").status, "skipped");
  assert.match(check(report, "controlled-check").detail, /not dispatched/);
});

test("reports are deeply frozen and redact command stderr, secrets, PEM paths, and model content", async () => {
  const secret = "super-secret-value";
  const pem = "/private/tmp/codekeeper-private.pem";
  const runner = runnerFor({
    appResult: result("", {
      status: 1,
      stderr: `${secret} ${pem} model-prompt`,
    }),
  });
  const report = await verifyCodekeeperReadiness(
    baseOptions({ runner, verifyPackage: async () => true }),
  );
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.checks), true);
  assert.equal(Object.isFrozen(report.checks[0]), true);
  const rendered = JSON.stringify(report);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes(pem), false);
  assert.equal(rendered.includes("model-prompt"), false);
  assert.equal(check(report, "github-app").status, "not-provable");
});

test("ready has stable exit semantics: every required check must pass", async () => {
  const options = baseOptions({
    inspectApp: async () => true,
    verifyPackage: async () => true,
  });
  const first = await verifyCodekeeperReadiness(options);
  const second = await verifyCodekeeperReadiness(
    baseOptions({
      inspectApp: async () => true,
      verifyPackage: async () => true,
    }),
  );
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.deepEqual(
    first.checks.map((item) => [item.id, item.status]),
    second.checks.map((item) => [item.id, item.status]),
  );
});
