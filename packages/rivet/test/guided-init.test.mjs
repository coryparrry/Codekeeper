import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGuidedInit } from "../src/guided-init.mjs";

const ROOT = "/work/example";
const REPOSITORY = "acme/widget";
const PEM_PATH = "/keys/rivet.pem";
const CLIENT_ID = "Iv123456789012345678";
const MODEL_SECRET = "model-secret-value-that-must-not-leak";

function output() {
  let value = "";
  return {
    stream: { write: (chunk) => (value += chunk) },
    read: () => value,
  };
}

function prompt({
  confirmations = [true, true, true],
  inputs = [CLIENT_ID, PEM_PATH],
} = {}) {
  return {
    async confirm() {
      return confirmations.shift() ?? false;
    },
    async input() {
      return inputs.shift() ?? "";
    },
    async selectModelSecret() {
      return "CODEX_API_KEY";
    },
  };
}

function runner({
  ownerType = "User",
  existingSecrets = [],
  status = "",
  repositoryUrl = `https://github.com/${REPOSITORY}`,
  viewerPermission = "ADMIN",
} = {}) {
  const calls = [];
  let currentStatus = status;
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (
      command === "git" &&
      args[0] === "rev-parse" &&
      args[1] === "--show-toplevel"
    ) {
      return ROOT;
    }
    if (command === "git" && args[0] === "status") return currentStatus;
    if (command === "git" && args[0] === "remote") {
      return `https://github.com/${REPOSITORY}.git`;
    }
    if (command === "git" && args[0] === "rev-parse") return "a".repeat(40);
    if (command === "git" && args[0] === "branch") return "";
    if (command === "git" && args[0] === "ls-remote") return "";
    if (command === "git" && args[0] === "fetch") return "";
    if (command === "gh" && args[0] === "auth") return "";
    if (command === "gh" && args[0] === "repo") {
      return JSON.stringify({
        nameWithOwner: REPOSITORY,
        defaultBranchRef: { name: "main" },
        url: repositoryUrl,
        viewerPermission,
      });
    }
    if (command === "gh" && args[0] === "api") return ownerType;
    if (command === "gh" && args[0] === "secret" && args[1] === "list") {
      return JSON.stringify(existingSecrets.map((name) => ({ name })));
    }
    if (command === "gh" && args[0] === "secret" && args[1] === "set")
      return "";
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  return {
    calls,
    run,
    setStatus(value) {
      currentStatus = value;
    },
  };
}

function dependencies(overrides = {}) {
  const configured = [];
  const verified = [];
  const setup = [];
  return {
    configured,
    verified,
    setup,
    prepareReviewInstallationImpl: async () => ({
      files: [
        { path: ".github/workflows/rivet-review.lock.yml", status: "create" },
      ],
    }),
    configureReviewAppImpl: async (options) => {
      configured.push(options);
      return {
        appId: 42,
        appSlug: "rivet-review",
        installationUrl:
          "https://github.com/apps/rivet-review/installations/new",
      };
    },
    verifyReviewAppImpl: async (options) => {
      verified.push(options);
      return {
        appId: 42,
        appSlug: "rivet-review",
        repositorySelection: "selected",
        permissions: {
          contents: "read",
          metadata: "read",
          pullRequests: "write",
        },
      };
    },
    createReviewSetupPullRequestImpl: async (options) => {
      setup.push(options);
      return {
        branch: "rivet/setup-review",
        pullRequestUrl: "https://github.com/acme/widget/pull/7",
      };
    },
    ...overrides,
  };
}

test("guides the ordered review-only setup without exposing credentials", async () => {
  const stdout = output();
  const fakeRunner = runner();
  const calls = [];
  const deps = dependencies({
    configureReviewAppImpl: async (options) => {
      calls.push("configure");
      return dependencies().configureReviewAppImpl(options);
    },
    verifyReviewAppImpl: async (options) => {
      calls.push("verify");
      return dependencies().verifyReviewAppImpl(options);
    },
    createReviewSetupPullRequestImpl: async (options) => {
      calls.push("setup-pr");
      return dependencies().createReviewSetupPullRequestImpl(options);
    },
  });
  const result = await runGuidedInit({
    cwd: `${ROOT}/nested/path`,
    runner: fakeRunner.run,
    prompt: prompt(),
    secretInput: MODEL_SECRET,
    openUrl: async (url) => calls.push(url),
    stdout: stdout.stream,
    ...deps,
  });

  assert.ok(calls.indexOf("configure") < calls.indexOf("verify"));
  assert.ok(calls.indexOf("verify") < calls.indexOf("setup-pr"));
  assert.equal(result.status, "configured");
  assert.equal(result.repositoryRoot, ROOT);
  assert.equal(result.modelSecret.name, "CODEX_API_KEY");
  assert.equal(result.modelSecret.action, "stored");
  assert.match(
    result.registrationUrl,
    /^https:\/\/github\.com\/settings\/apps\/new\?/,
  );
  assert.match(stdout.read(), /Create the Rivet GitHub App:/);
  assert.match(stdout.read(), /Created verified draft setup pull request:/);
  const secretCommand = fakeRunner.calls.find(
    ({ command, args }) =>
      command === "gh" && args[0] === "secret" && args[1] === "set",
  );
  assert.deepEqual(secretCommand.args, [
    "secret",
    "set",
    "CODEX_API_KEY",
    "--app",
    "actions",
    "--repo",
    REPOSITORY,
  ]);
  assert.equal(secretCommand.options.input, MODEL_SECRET);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(MODEL_SECRET));
  assert.doesNotMatch(stdout.read(), new RegExp(MODEL_SECRET));
  assert.doesNotMatch(
    JSON.stringify(fakeRunner.calls.map(({ args }) => args)),
    new RegExp(MODEL_SECRET),
  );
  assert.doesNotMatch(JSON.stringify(result), /rivet\.pem/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(CLIENT_ID));
});

test("prints an organization registration URL when opening the browser fails", async () => {
  const stdout = output();
  const fakeRunner = runner({ ownerType: "Organization" });
  const result = await runGuidedInit({
    runner: fakeRunner.run,
    prompt: prompt({ confirmations: [false] }),
    stdout: stdout.stream,
    openUrl: async () => {
      throw new Error("browser unavailable");
    },
    ...dependencies(),
  });
  assert.equal(result.status, "cancelled");
  assert.match(
    result.registrationUrl,
    /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?/,
  );
  assert.match(
    stdout.read(),
    /Create the Rivet GitHub App: https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new/,
  );
  assert.match(stdout.read(), /Could not open a browser/);
});

test("opens browsers through the native macOS executable", async () => {
  const calls = [];
  const spawnBrowser = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const result = await runGuidedInit({
    platform: "darwin",
    env: { PATH: "/tmp/untrusted" },
    runner: runner().run,
    prompt: prompt({ confirmations: [false] }),
    stdout: output().stream,
    spawnBrowser,
    ...dependencies(),
  });

  assert.equal(result.status, "cancelled");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/open");
  assert.deepEqual(calls[0].args, [result.registrationUrl]);
  assert.equal(calls[0].options.detached, true);
});

test("prints the URL without spawning a PATH-resolved opener elsewhere", async () => {
  for (const platform of ["linux", "win32"]) {
    const stdout = output();
    let spawned = false;
    const result = await runGuidedInit({
      platform,
      env: { PATH: "/tmp/untrusted" },
      runner: runner().run,
      prompt: prompt({ confirmations: [false] }),
      stdout: stdout.stream,
      spawnBrowser: () => {
        spawned = true;
      },
      ...dependencies(),
    });

    assert.equal(result.status, "cancelled");
    assert.equal(spawned, false);
    assert.match(stdout.read(), /Could not open a browser/);
    assert.ok(stdout.read().includes(result.registrationUrl));
  }
});

test("stops before App mutation when the repository preflight fails", async () => {
  const fakeRunner = runner({ status: "?? preserve-me" });
  const deps = dependencies();
  await assert.rejects(
    runGuidedInit({
      runner: fakeRunner.run,
      prompt: prompt(),
      stdout: output().stream,
      ...deps,
    }),
    /working tree must be clean/,
  );
  assert.equal(deps.configured.length, 0);
  assert.equal(deps.verified.length, 0);
  assert.equal(deps.setup.length, 0);
  assert.equal(
    fakeRunner.calls.some(
      ({ command, args }) =>
        command === "gh" && args[0] === "secret" && args[1] === "set",
    ),
    false,
  );
});

test("requires github.com and repository-admin access before App mutation", async () => {
  for (const [fakeRunner, message] of [
    [
      runner({ repositoryUrl: "https://github.example/acme/widget" }),
      /github\.com repository/,
    ],
    [runner({ viewerPermission: "WRITE" }), /repository admin permission/],
  ]) {
    const deps = dependencies();
    await assert.rejects(
      runGuidedInit({
        runner: fakeRunner.run,
        prompt: prompt(),
        stdout: output().stream,
        ...deps,
      }),
      message,
    );
    assert.equal(deps.configured.length, 0);
    assert.equal(deps.setup.length, 0);
  }
});

test("binds GitHub discovery to origin and ignores ambient GH_REPO", async () => {
  const fakeRunner = runner();
  await runGuidedInit({
    runner: fakeRunner.run,
    prompt: prompt({ confirmations: [false] }),
    env: {
      PATH: process.env.PATH,
      GH_REPO: "attacker/other",
      GH_HOST: "github.example",
    },
    stdout: output().stream,
    ...dependencies(),
  });

  const repoView = fakeRunner.calls.find(
    ({ command, args }) =>
      command === "gh" && args[0] === "repo" && args[1] === "view",
  );
  assert.equal(repoView.args[2], `github.com/${REPOSITORY}`);
  assert.equal(repoView.options.env.GH_REPO, undefined);
  assert.equal(repoView.options.env.GH_HOST, "github.com");
});

test("does not execute repository-local tools prepended by npx", async (t) => {
  if (process.platform === "win32") t.skip("POSIX executable fixture");
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-local-bin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localBin = path.join(root, "node_modules", ".bin");
  const marker = path.join(root, "local-git-ran");
  await mkdir(localBin, { recursive: true });
  const fakeGit = path.join(localBin, "git");
  await writeFile(
    fakeGit,
    `#!/bin/sh\nprintf used > "${marker}"\nprintf '%s\\n' "$PWD"\n`,
  );
  await chmod(fakeGit, 0o700);

  await assert.rejects(
    runGuidedInit({
      cwd: root,
      env: {
        ...process.env,
        PATH: `${localBin}${path.delimiter}${process.env.PATH}`,
        CODEX_API_KEY: MODEL_SECRET,
      },
      prompt: prompt(),
      stdout: output().stream,
      ...dependencies(),
    }),
    /run this command from inside a Git repository/,
  );
  await assert.rejects(access(marker), /ENOENT/);
});

test("rechecks the repository snapshot before configuring the App", async () => {
  const fakeRunner = runner();
  const deps = dependencies();
  const answers = [CLIENT_ID, PEM_PATH];
  await assert.rejects(
    runGuidedInit({
      runner: fakeRunner.run,
      prompt: {
        confirm: async () => true,
        input: async () => {
          const answer = answers.shift();
          if (answers.length === 0)
            fakeRunner.setStatus("?? concurrent-change");
          return answer;
        },
        selectModelSecret: async () => "CODEX_API_KEY",
      },
      stdout: output().stream,
      ...deps,
    }),
    /working tree changed during setup/,
  );
  assert.equal(deps.configured.length, 0);
  assert.equal(deps.verified.length, 0);
  assert.equal(deps.setup.length, 0);
});

test("cancellation returns concise rerun guidance without mutation", async () => {
  const fakeRunner = runner();
  const deps = dependencies();
  const stdout = output();
  const result = await runGuidedInit({
    runner: fakeRunner.run,
    prompt: prompt({ confirmations: [false] }),
    stdout: stdout.stream,
    ...deps,
  });
  assert.deepEqual(
    { status: result.status, stage: result.stage },
    { status: "cancelled", stage: "app-registration" },
  );
  assert.match(result.guidance, /Run rivet init again/);
  assert.match(stdout.read(), /Run rivet init again/);
  assert.equal(deps.configured.length, 0);
});

test("explains saved App credentials when installation is paused", async () => {
  const fakeRunner = runner();
  const deps = dependencies();
  const stdout = output();
  const result = await runGuidedInit({
    runner: fakeRunner.run,
    prompt: prompt({ confirmations: [true, false] }),
    stdout: stdout.stream,
    ...deps,
  });

  assert.deepEqual(
    { status: result.status, stage: result.stage },
    { status: "cancelled", stage: "app-installation" },
  );
  assert.match(
    result.guidance,
    /already saved this App's repository credentials/,
  );
  assert.match(result.guidance, /reuse the same client ID and PEM/);
  assert.match(
    stdout.read(),
    /already saved this App's repository credentials/,
  );
  assert.equal(deps.configured.length, 1);
  assert.equal(deps.verified.length, 0);
  assert.equal(deps.setup.length, 0);
});

test("App verification failure prevents model-secret and setup-PR mutation", async () => {
  const fakeRunner = runner();
  const deps = dependencies({
    verifyReviewAppImpl: async () => {
      throw new Error("authority mismatch");
    },
  });
  await assert.rejects(
    runGuidedInit({
      runner: fakeRunner.run,
      prompt: prompt(),
      secretInput: MODEL_SECRET,
      stdout: output().stream,
      ...deps,
    }),
    /authority mismatch/,
  );
  assert.equal(deps.setup.length, 0);
  assert.equal(
    fakeRunner.calls.some(
      ({ command, args }) =>
        command === "gh" && args[0] === "secret" && args[1] === "set",
    ),
    false,
  );
});

test("an existing model secret skips upload and only creates the setup PR", async () => {
  const fakeRunner = runner({ existingSecrets: ["OPENAI_API_KEY"] });
  const deps = dependencies();
  const result = await runGuidedInit({
    runner: fakeRunner.run,
    prompt: prompt(),
    stdout: output().stream,
    ...deps,
  });
  assert.deepEqual(result.modelSecret, {
    name: "OPENAI_API_KEY",
    action: "already-configured",
  });
  assert.equal(deps.setup.length, 1);
  assert.equal(
    fakeRunner.calls.some(
      ({ command, args }) =>
        command === "gh" && args[0] === "secret" && args[1] === "set",
    ),
    false,
  );
});

test("aborts if model-secret metadata changes during the walkthrough", async () => {
  const existingSecrets = ["CODEX_API_KEY"];
  const fakeRunner = runner({ existingSecrets });
  const baseDependencies = dependencies();
  const deps = dependencies({
    verifyReviewAppImpl: async (options) => {
      const app = await baseDependencies.verifyReviewAppImpl(options);
      existingSecrets.length = 0;
      return app;
    },
  });

  await assert.rejects(
    runGuidedInit({
      runner: fakeRunner.run,
      prompt: prompt(),
      stdout: output().stream,
      ...deps,
    }),
    /Actions secret metadata changed during setup/,
  );
  assert.equal(deps.setup.length, 0);
  assert.equal(
    fakeRunner.calls.some(
      ({ command, args }) =>
        command === "gh" && args[0] === "secret" && args[1] === "set",
    ),
    false,
  );
});

test("passes the prepared installation plan to setup PR creation", async () => {
  const fakeRunner = runner();
  const preparedPlan = {
    files: [
      { path: ".github/workflows/rivet-review.lock.yml", status: "create" },
    ],
  };
  let prepareCalls = 0;
  const deps = dependencies({
    prepareReviewInstallationImpl: async () => {
      prepareCalls += 1;
      return preparedPlan;
    },
  });

  await runGuidedInit({
    runner: fakeRunner.run,
    prompt: prompt(),
    secretInput: MODEL_SECRET,
    stdout: output().stream,
    ...deps,
  });

  assert.equal(prepareCalls, 1);
  assert.equal(deps.setup.length, 1);
  assert.equal(deps.setup[0].preparedPlan, preparedPlan);
});

test("passes an exported model secret only through bounded standard input", async () => {
  const fakeRunner = runner();
  let preparedEnvironment;
  const browserEnvironments = [];
  const deps = dependencies({
    prepareReviewInstallationImpl: async (options) => {
      preparedEnvironment = options.env;
      return {
        files: [
          {
            path: ".github/workflows/rivet-review.lock.yml",
            status: "create",
          },
        ],
      };
    },
  });
  let uploadedSecret;
  const run = async (command, args, options) => {
    assert.equal(options.env?.CODEX_API_KEY, undefined);
    if (command === "gh" && args[0] === "secret" && args[1] === "set") {
      uploadedSecret = Buffer.from(options.input);
    }
    return fakeRunner.run(command, args, options);
  };
  const stdout = output();
  const result = await runGuidedInit({
    runner: run,
    prompt: prompt(),
    env: { CODEX_API_KEY: MODEL_SECRET, KEEP_ME: "visible" },
    openUrl: async (_url, options) => browserEnvironments.push(options.env),
    stdout: stdout.stream,
    ...deps,
  });

  assert.equal(uploadedSecret.toString("utf8"), MODEL_SECRET);
  assert.doesNotMatch(stdout.read(), new RegExp(MODEL_SECRET));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(MODEL_SECRET));
  assert.equal(
    fakeRunner.calls.every(({ options }) => options.env?.KEEP_ME === "visible"),
    true,
  );
  assert.equal(preparedEnvironment.CODEX_API_KEY, undefined);
  assert.equal(preparedEnvironment.KEEP_ME, "visible");
  assert.equal(
    browserEnvironments.every(
      (environment) =>
        environment.CODEX_API_KEY === undefined &&
        environment.KEEP_ME === "visible",
    ),
    true,
  );
});

test("final cancellation does not say the verified App still needs installation", async () => {
  const fakeRunner = runner({ existingSecrets: ["CODEX_API_KEY"] });
  const result = await runGuidedInit({
    runner: fakeRunner.run,
    prompt: prompt({ confirmations: [true, true, false] }),
    stdout: output().stream,
    ...dependencies(),
  });

  assert.equal(result.stage, "setup-pull-request");
  assert.match(result.guidance, /already saved and verified/);
  assert.doesNotMatch(result.guidance, /Finish installing/);
});

test("hands secret entry to GitHub CLI stdin without another prompt", async () => {
  const fakeRunner = runner();
  const deps = dependencies();
  let secretSet = false;
  const interactivePrompt = {
    confirm: async () => {
      assert.equal(secretSet, false);
      return true;
    },
    input: async () => {
      assert.equal(secretSet, false);
      return CLIENT_ID;
    },
    selectModelSecret: async () => {
      assert.equal(secretSet, false);
      return "CODEX_API_KEY";
    },
  };
  const run = async (command, args, options) => {
    if (command === "gh" && args[0] === "secret" && args[1] === "set") {
      secretSet = true;
    }
    return fakeRunner.run(command, args, options);
  };
  await runGuidedInit({
    runner: run,
    prompt: interactivePrompt,
    stdout: output().stream,
    ...deps,
  });
  const secretCommand = fakeRunner.calls.find(
    ({ command, args }) =>
      command === "gh" && args[0] === "secret" && args[1] === "set",
  );
  assert.equal(secretCommand.options.inheritStdin, true);
  assert.equal(secretCommand.options.input, undefined);
  assert.equal(secretSet, true);
});

test("does not start an interactive prompt without a TTY", async () => {
  await assert.rejects(
    runGuidedInit({
      stdin: { isTTY: false },
      stdout: output().stream,
      ...dependencies(),
    }),
    /requires a TTY; use explicit CLI flags/,
  );
});
