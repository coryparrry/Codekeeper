import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../src/assets.mjs";
import { SOURCE_REPOSITORY } from "../src/constants.mjs";
import { buildInstallPlan } from "../src/plan.mjs";
import {
  assertNodeVersion,
  assertNoInstallationFiles,
  assertNoSetupBranch,
  doctorRepository,
  inspectInstallationFiles,
  inspectRepository,
  parseGitHubRemote
} from "../src/preflight.mjs";
import {
  assertInstallerCode,
  commandKey,
  createRecordingRunner,
  HEAD_SHA,
  loadVerifiedAssets,
  result,
  temporaryDirectory
} from "./helpers.mjs";
import {
  createReleaseManagedCatalog,
  REPOSITORY_ARTIFACTS,
} from "../src/repository-artifacts.mjs";

const OTHER_SHA = "b".repeat(40);

function installedWorkflow(source) {
  return source
    .replaceAll("OWNER/REPOSITORY", SOURCE_REPOSITORY)
    .replaceAll("FULL_COMMIT_SHA", HEAD_SHA);
}

function unifiedWorkflow(bundle, modes = ["review"]) {
  return installedWorkflow(bundle.contents["workflows/codekeeper.yml"])
    .replaceAll("OWNER_REQUESTS_ENABLED", "true")
    .replaceAll("AUTO_REVIEW_ENABLED", "true")
    .replaceAll("FEEDBACK_TRIAGE_ENABLED", "true")
    .replaceAll("AUTO_TRIAGE_ENABLED", "true")
    .replaceAll('installed_modes: "INSTALLED_MODES"', `installed_modes: ${modes.join(",")}`);
}

function legacyWorkflow(mode, {
  ownerRequests = true,
  autoReview = true,
  feedbackTriage = true,
  schedule = null,
} = {}) {
  return [
    "# Legacy Codekeeper caller fixture.",
    `# owner_requests: ${ownerRequests}`,
    `# auto_review: ${autoReview}`,
    `# feedback_triage: ${feedbackTriage}`,
    ...(schedule ? [`  - cron: "${schedule}"`] : []),
    "jobs:",
    "  codekeeper:",
    `    uses: ${SOURCE_REPOSITORY}/tools/codekeeper@${HEAD_SHA}`,
    "  runtime:",
    `    uses: ${SOURCE_REPOSITORY}/.github/workflows/codekeeper-${mode}.yml@${HEAD_SHA}`,
    "",
  ].join("\n");
}

function preflightRunner(root, options = {}) {
  const settings = {
    originUrl: "https://github.com/acme/widget.git",
    repositoryData: {
      full_name: "acme/widget",
      default_branch: "main",
      owner: { type: "Organization" },
      permissions: { admin: true },
      archived: false,
      disabled: false
    },
    actions: { enabled: true },
    currentBranch: "main",
    status: "",
    headSha: HEAD_SHA,
    remoteSha: HEAD_SHA,
    viewerLogin: "cory",
    localRefs: "",
    remoteRefs: "",
    pulls: [],
    membership: { state: "active", role: "admin" },
    bare: "false",
    sparseStatus: 1,
    sparseValue: "",
    userName: "Cory",
    userEmail: "cory@example.test",
    variables: {
      CODEKEEPER_ENABLED: "true",
      CODEKEEPER_APP_CLIENT_ID: "Iv123456789012345678",
      CODEKEEPER_AUTOMATION_BOT_LOGIN: "codekeeper-widget[bot]"
    },
    failures: new Map(),
    ...options
  };

  return createRecordingRunner((call) => {
    const key = commandKey(call.command, call.args);
    if (settings.failures.has(key)) return result("", { status: settings.failures.get(key), stderr: "simulated failure" });
    const { command, args } = call;
    if (command === "git" && args[0] === "--version") return result("git version 2.50.0\n");
    if (command === "gh" && args[0] === "--version") return result("gh version 2.76.0\n");
    if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") return result(`${root}\n`);
    if (command === "git" && args.join(" ") === "rev-parse --is-bare-repository") return result(`${settings.bare}\n`);
    if (command === "git" && args.join(" ") === "config --bool core.sparseCheckout") {
      return result(`${settings.sparseValue}\n`, { status: settings.sparseStatus });
    }
    if (command === "git" && args[0] === "rev-parse" && args[1] === "--git-path") return result(`.git/${args[2]}\n`);
    if (command === "git" && args.join(" ") === "symbolic-ref --quiet --short HEAD") return result(`${settings.currentBranch}\n`);
    if (command === "git" && args.join(" ") === "remote get-url origin") return result(`${settings.originUrl}\n`);
    if (command === "gh" && args.join(" ") === "auth status --hostname github.com") return result();
    if (command === "gh" && args[0] === "api" && args.at(-1) === "repos/acme/widget") {
      return result(JSON.stringify(settings.repositoryData));
    }
    if (command === "gh" && args[0] === "api" && args.at(-1) === "repos/acme/widget/actions/permissions") {
      return result(JSON.stringify(settings.actions));
    }
    if (command === "gh" && args[0] === "api" && args.at(-1) === "user/memberships/orgs/acme") {
      return result(JSON.stringify(settings.membership));
    }
    if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") return result(settings.status);
    if (command === "git" && args.join(" ") === "rev-parse HEAD") return result(`${settings.headSha}\n`);
    if (command === "git" && args.join(" ") === "ls-remote origin refs/heads/main") {
      return result(`${settings.remoteSha}\trefs/heads/main\n`);
    }
    if (command === "gh" && args.join(" ") === "api --hostname github.com user --jq .login") return result(`${settings.viewerLogin}\n`);
    if (command === "git" && args.join(" ") === "config --get user.name") return result(`${settings.userName}\n`, { status: settings.userName ? 0 : 1 });
    if (command === "git" && args.join(" ") === "config --get user.email") return result(`${settings.userEmail}\n`, { status: settings.userEmail ? 0 : 1 });
    if (command === "git" && args[0] === "for-each-ref") return result(settings.localRefs);
    if (command === "git" && args[0] === "ls-remote" && args[1] === "--heads") return result(settings.remoteRefs);
    if (command === "gh" && args[0] === "pr" && args[1] === "list") return result(JSON.stringify(settings.pulls));
    if (command === "gh" && args[0] === "variable" && args[1] === "get") return result(`${settings.variables[args[2]] ?? ""}\n`);
    if (command === "gh" && args.join(" ") === "variable list --repo acme/widget --json name,value") {
      return result(JSON.stringify(Object.entries(settings.variables).map(([name, value]) => ({ name, value }))));
    }
    throw new Error(`Unexpected preflight command: ${command} ${args.join(" ")}`);
  });
}

test("GitHub remote parsing accepts only credential-free GitHub.com HTTPS and SSH", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/Acme/Widget.git"), {
    host: "github.com",
    repository: "Acme/Widget",
    protocol: "https"
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/widget.git"), {
    host: "github.com",
    repository: "acme/widget",
    protocol: "ssh"
  });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/acme/widget.git"), {
    host: "github.com",
    repository: "acme/widget",
    protocol: "ssh"
  });
  for (const remote of [
    "https://github.example.com/acme/widget.git",
    "https://token@github.com/acme/widget.git",
    "https://github.com/acme/widget.git?token=secret",
    "ssh://root@github.com/acme/widget.git",
    "git://github.com/acme/widget.git",
    "git@git.example.com:acme/widget.git",
    "https://github.com/acme/nested/widget.git",
    ""
  ]) {
    assert.throws(() => parseGitHubRemote(remote), assertInstallerCode(assert, "UNSUPPORTED_ORIGIN"), remote);
  }
});

test("Node 22 is the minimum supported runtime", () => {
  assert.doesNotThrow(() => assertNodeVersion("22.0.0"));
  assert.doesNotThrow(() => assertNodeVersion("26.1.0"));
  assert.throws(() => assertNodeVersion("21.9.0"), assertInstallerCode(assert, "UNSUPPORTED_NODE"));
  assert.throws(() => assertNodeVersion("not-a-version"), assertInstallerCode(assert, "UNSUPPORTED_NODE"));
});

test("installation-file collision checks reject known, case-colliding, and disguised Codekeeper files", async (t) => {
  await t.test("empty repository passes", async (t) => {
    const root = await temporaryDirectory(t);
    await assertNoInstallationFiles(root);
  });
  await t.test("existing policy fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await writeFile(path.join(root, ".github", "codekeeper.json"), "{}\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "EXISTING_INSTALLATION"));
  });
  await t.test("case-colliding policy fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await writeFile(path.join(root, ".github", "CodeKeeper.JSON"), "{}\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("case-colliding GitHub directory fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".GitHub"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked workflows parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await symlink(outside, path.join(root, ".github", "workflows"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("existing agent profile fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper", "agents", "pr-reviewer.md"), "# Existing\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "EXISTING_INSTALLATION"));
  });
  await t.test("case-colliding agent profile fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper", "agents", "Issue-Triager.MD"), "# Existing\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("case-colliding optional agent profile fails during an update scan", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper", "agents", "PR-Reviewer.md"), "# Existing\n");
    await assert.rejects(
      assertNoInstallationFiles(root, { allowExisting: true }),
      assertInstallerCode(assert, "PATH_COLLISION")
    );
  });
  await t.test("case-colliding Codekeeper profile parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "CodeKeeper", "agents"), { recursive: true });
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked Codekeeper profile parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github"));
    await symlink(outside, path.join(root, ".github", "codekeeper"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked agents parent fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper"), { recursive: true });
    await symlink(outside, path.join(root, ".github", "codekeeper", "agents"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked agent profile fails", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(outside, "profile.md"), "# Outside\n");
    await symlink(path.join(outside, "profile.md"), path.join(root, ".github", "codekeeper", "agents", "fixer.md"));
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "PATH_COLLISION"));
  });
  await t.test("symlinked optional agent profile fails during an update scan", async (t) => {
    const root = await temporaryDirectory(t);
    const outside = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(outside, "profile.md"), "# Outside\n");
    await symlink(path.join(outside, "profile.md"), path.join(root, ".github", "codekeeper", "agents", "fixer.md"));
    await assert.rejects(
      assertNoInstallationFiles(root, { allowExisting: true }),
      assertInstallerCode(assert, "PATH_COLLISION")
    );
  });
  await t.test("renamed caller invoking Codekeeper fails", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "automation.yml"), "jobs:\n  call:\n    uses: example/Codekeeper/.github/workflows/codekeeper-review.yml@abc\n");
    await assert.rejects(assertNoInstallationFiles(root), assertInstallerCode(assert, "EXISTING_INSTALLATION"));
  });
  await t.test("unrelated workflow passes", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
    await assertNoInstallationFiles(root);
  });
  await t.test("unrelated workflow at the reserved unified caller path blocks a rerun", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper.json"), "{}\n");
    await writeFile(path.join(root, ".github", "workflows", "codekeeper.yml"), "name: Existing caller\n");
    await assert.rejects(
      assertNoInstallationFiles(root, { allowExisting: true }),
      assertInstallerCode(assert, "PATH_COLLISION")
    );
  });
  await t.test("unrelated profile file passes", async (t) => {
    const root = await temporaryDirectory(t);
    await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
    await writeFile(path.join(root, ".github", "codekeeper", "agents", "team-notes.md"), "# Notes\n");
    await assertNoInstallationFiles(root);
  });
});

test("release manifests admit only digest-bound retired Codekeeper workflows", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await loadVerifiedAssets();
  const retiredTarget = ".github/workflows/codekeeper-runtime-fix.yml";
  const retiredSource = "name: Retired Codekeeper runtime\n";
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ...retiredTarget.split("/")), retiredSource);
  const manifestPath = path.join(root, ".github", "codekeeper-release.json");
  const manifest = {
    version: 1,
    package: { name: "@coryparry/codekeeper", version: "0.2.0" },
    source: { repository: SOURCE_REPOSITORY, commit: HEAD_SHA },
    managedFiles: { [retiredTarget]: sha256(retiredSource) }
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assertNoInstallationFiles(root, { allowExisting: true });
  await writeFile(path.join(root, ...retiredTarget.split("/")), `${retiredSource}\n# edited\n`);
  await assert.rejects(
    assertNoInstallationFiles(root, { allowExisting: true }),
    assertInstallerCode(assert, "EXISTING_INSTALLATION_INVALID")
  );
  manifest.managedFiles = { "README.md": sha256("unsafe") };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    assertNoInstallationFiles(root, { allowExisting: true }),
    assertInstallerCode(assert, "EXISTING_INSTALLATION_INVALID")
  );
  manifest.managedFiles = { ".github/workflows/codekeeper-custom.yml": sha256("unsafe") };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    assertNoInstallationFiles(root, { allowExisting: true }),
    assertInstallerCode(assert, "EXISTING_INSTALLATION_INVALID")
  );
});

test("release-owned Markdown is accepted only at its exact digest-bound catalog path", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await loadVerifiedAssets();
  const target = ".github/codekeeper/README.md";
  const source = bundle.contents["repository/README.md"];
  const manifest = {
    version: 2,
    package: bundle.packageRelease,
    source: { repository: SOURCE_REPOSITORY, commit: HEAD_SHA },
    managedFiles: { [target]: sha256(source) },
  };
  await mkdir(path.join(root, ".github", "codekeeper"), { recursive: true });
  await writeFile(path.join(root, ...target.split("/")), source);
  await writeFile(
    path.join(root, ".github", "codekeeper-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await assertNoInstallationFiles(root, { allowExisting: true });

  await writeFile(
    path.join(root, ...target.split("/")),
    `${source}\nEdited.\n`,
  );
  await assert.rejects(
    assertNoInstallationFiles(root, { allowExisting: true }),
    assertInstallerCode(assert, "EXISTING_INSTALLATION_INVALID"),
  );

  await rm(path.join(root, ".github", "codekeeper-release.json"));
  await assert.rejects(
    assertNoInstallationFiles(root, { allowExisting: true }),
    assertInstallerCode(assert, "PATH_COLLISION"),
  );
});

test("edited caller workflows retain semantic validation across catalog renames and retirement", async (t) => {
  const bundle = await loadVerifiedAssets();
  const target = ".github/workflows/codekeeper-router.yml";
  const installedSource = legacyWorkflow("review");
  const source = `${installedSource.replace(
    "# owner_requests: true",
    "# owner_requests: false",
  )}\n# Repository setting retained.\n`;
  const activeArtifact = {
    id: "repository.workflow.caller-v2",
    target: ".github/workflows/codekeeper-caller-v2.yml",
    previousTargets: [target],
    asset: "workflows/codekeeper.yml",
    ownership: "release",
    activation: { kind: "always" },
    renderer: "unified-workflow",
    validation: "caller",
    callerModes: ["review"],
    purpose: "Repository unified caller workflow",
  };
  const retiredArtifact = {
    id: "repository.workflow.router-retired",
    target,
    ownership: "release",
    validation: "caller",
    callerModes: ["review"],
    purpose: "Retired repository caller workflow",
  };

  for (const [label, artifactCatalog] of [
    [
      "renamed",
      createReleaseManagedCatalog({
        artifacts: [activeArtifact],
        retiredArtifacts: [],
      }),
    ],
    [
      "retired",
      createReleaseManagedCatalog({
        artifacts: [],
        retiredArtifacts: [retiredArtifact],
      }),
    ],
  ]) {
    await t.test(label, async (t) => {
      const root = await temporaryDirectory(t);
      const legacySource = legacyWorkflow("review");
      const manifest = {
        version: 2,
        package: bundle.packageRelease,
        source: { repository: SOURCE_REPOSITORY, commit: HEAD_SHA },
        managedFiles: { [target]: sha256(label === "retired" ? legacySource : installedSource) },
      };
      await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
      await writeFile(path.join(root, ...target.split("/")), label === "retired" ? legacySource : source);
      await writeFile(
        path.join(root, ".github", "codekeeper-release.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await assertNoInstallationFiles(root, {
        allowExisting: true,
        artifactCatalog,
      });

      await writeFile(
        path.join(root, ...target.split("/")),
        "name: Not Codekeeper\n",
      );
      await assert.rejects(
        assertNoInstallationFiles(root, {
          allowExisting: true,
          artifactCatalog,
        }),
        assertInstallerCode(assert, "EXISTING_INSTALLATION_INVALID"),
      );
    });
  }
});

test("unified callers retain semantic validation at the pinned runtime boundary", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await loadVerifiedAssets();
  const source = unifiedWorkflow(bundle, ["review"]);
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(
    path.join(root, ".github", "workflows", "codekeeper.yml"),
    source,
  );

  await assertNoInstallationFiles(root, { allowExisting: true });

  await writeFile(
    path.join(root, ".github", "workflows", "codekeeper.yml"),
    source.replace(
      "uses: ./.github/workflows/codekeeper-runtime.yml",
      "uses: ./.github/workflows/codekeeper-runtime-missing.yml",
    ),
  );
  await assert.rejects(
    assertNoInstallationFiles(root, { allowExisting: true }),
    assertInstallerCode(assert, "PATH_COLLISION"),
  );
});

test("installation inspection retains edited legacy callers while blocking their migration deletion", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await loadVerifiedAssets();
  const previousTarget = ".github/workflows/codekeeper-review-v1.yml";
  const currentArtifact = REPOSITORY_ARTIFACTS.find(
    ({ validation }) => validation === "caller",
  );
  const artifactCatalog = createReleaseManagedCatalog({
    artifacts: REPOSITORY_ARTIFACTS.map((artifact) =>
      artifact === currentArtifact
        ? { ...artifact, previousTargets: [previousTarget], callerModes: ["assistant", "review"] }
        : artifact,
    ),
    retiredArtifacts: [],
  });
  const installedSource = unifiedWorkflow(bundle, ["review"]);
  const editedSource = installedSource
    .replace("# auto_review: true", "# auto_review: false")
    .replace("# feedback_triage: true", "# feedback_triage: false");
  const manifest = {
    version: 2,
    package: bundle.packageRelease,
    source: { repository: SOURCE_REPOSITORY, commit: HEAD_SHA },
    managedFiles: { [previousTarget]: sha256(installedSource) },
  };
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(
    path.join(root, ".github", "codekeeper.json"),
    bundle.contents["policies/openai.json"],
  );
  await writeFile(path.join(root, ...previousTarget.split("/")), editedSource);
  await writeFile(
    path.join(root, ".github", "codekeeper-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const installation = await inspectInstallationFiles(root, { artifactCatalog });
  assert.deepEqual(installation.modes, ["review"]);
  assert.equal(installation.policy.automation.automaticPrReview, false);
  assert.equal(installation.contents[previousTarget], editedSource);

  assert.throws(
    () => buildInstallPlan({
      bundle,
      snapshot: {
        root,
        repository: "acme/widget",
        defaultBranch: "main",
        headSha: HEAD_SHA,
        viewerLogin: "cory",
        installation,
        existingSettings: {
          enabled: true,
          appClientId: "Iv123456789012345678",
          automationBotLogin: "codekeeper-widget[bot]",
        },
      },
      answers: {
        modes: ["review"],
        preset: "openai",
        displayName: "Widget",
        ownerLogins: ["cory"],
        appClientId: "Iv123456789012345678",
        automationBotLogin: "codekeeper-widget[bot]",
        enabled: true,
        capabilities: [],
        tracing: true,
        releaseUpdate: true,
      },
    }),
    (error) => {
      assert.equal(error.code, "MANAGED_FILE_CHANGED");
      assert.match(error.message, /codekeeper-review-v1\.yml/);
      return true;
    },
  );
});

test("existing generated files with every optional profile missing are recognized as a rerunnable installation", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await loadVerifiedAssets();
  await mkdir(path.join(root, ".github", "codekeeper", "agents"), { recursive: true });
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  const legacyPolicy = JSON.parse(bundle.contents["policies/openai.json"]);
  legacyPolicy.ai.agents.plan = structuredClone(legacyPolicy.ai.agents.fix);
  for (const agent of Object.values(legacyPolicy.ai.agents)) agent.maxTurns = 2;
  await writeFile(path.join(root, ".github", "codekeeper.json"), `${JSON.stringify(legacyPolicy, null, 2)}\n`);
  await writeFile(path.join(root, ".github", "codekeeper", "agents", "maintenance-planner.md"), "# Legacy planner\n");
  await writeFile(path.join(root, ".github", "workflows", "codekeeper.yml"), unifiedWorkflow(bundle, ["review", "maintain"])
    .replace("# owner_requests: true", "# owner_requests: false")
    .replace("# auto_review: true", "# auto_review: false")
    .replace("# feedback_triage: true", "# feedback_triage: false")
    .replace('cron: "17 7 * * *"', 'cron: "23 4 * * 2"'));
  const unifiedSource = await readFile(path.join(root, ".github", "workflows", "codekeeper.yml"), "utf8");
  await writeFile(
    path.join(root, ".github", "codekeeper-release.json"),
    `${JSON.stringify({
      version: 2,
      package: bundle.packageRelease,
      source: { repository: SOURCE_REPOSITORY, commit: HEAD_SHA },
      managedFiles: { ".github/workflows/codekeeper.yml": sha256(unifiedSource) },
    }, null, 2)}\n`,
  );

  const installation = await inspectInstallationFiles(root);
  assert.deepEqual(installation.modes, ["review", "maintain"]);
  assert.equal(installation.policy.version, 3);
  assert.deepEqual(installation.policy.automation, {
    automaticPrReview: false,
    reviewFeedbackTriage: false,
    issueTriage: true,
    ownerRequests: false,
    maintenanceSchedule: "23 4 * * 2"
  });
  assert.equal(installation.policy.review.createDeferredIssues, true);
  assert.deepEqual(installation.policy.ai.providers.openrouter, {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "chat_completions",
    structuredOutputs: false,
    supportsReasoningEffort: false
  });
  assert.equal(
    installation.policy.labels["codekeeper:deferred"].color,
    "C5DEF5",
  );
  assert.equal(installation.policy.ai.agents.review.model, "gpt-5.6-luna");
  assert.equal(installation.policy.ai.agents.plan, undefined);
  for (const agent of ["review", "audit", "issue", "fix"]) {
    assert.equal(installation.policy.ai.agents[agent].maxTurns, 1);
  }
  assert.deepEqual(installation.legacyFiles, [".github/codekeeper/agents/maintenance-planner.md"]);
  for (const profile of ["pr-reviewer", "repository-auditor", "issue-triager", "fixer"]) {
    assert.equal(installation.contents[`.github/codekeeper/agents/${profile}.md`], undefined);
  }
  const inspected = await inspectRepository({ runner: preflightRunner(root), cwd: root });
  assert.equal(inspected.updateBranch, `codekeeper/update-${HEAD_SHA.slice(0, 12)}`);
  assert.equal(inspected.existingSettings.enabled, true);
  assert.equal(inspected.existingSettings.appClientId, "Iv123456789012345678");
  assert.equal(inspected.existingSettings.automationBotLogin, "codekeeper-widget[bot]");
  const legacy = await inspectRepository({
    runner: preflightRunner(root, {
      variables: {
        CODEKEEPER_ENABLED: "true",
        CODEKEEPER_APP_CLIENT_ID: "Iv123456789012345678"
      }
    }),
    cwd: root
  });
  assert.equal(legacy.existingSettings.automationBotLogin, null);

  const issuesRoot = await temporaryDirectory(t);
  await mkdir(path.join(issuesRoot, ".github", "codekeeper", "agents"), { recursive: true });
  await mkdir(path.join(issuesRoot, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(issuesRoot, ".github", "codekeeper.json"), bundle.contents["policies/openai.json"]);
  for (const [name, asset] of [
    ["pr-reviewer.md", "agents/pr-reviewer.md"],
    ["repository-auditor.md", "agents/repository-auditor.md"],
    ["issue-triager.md", "agents/issue-triager.md"]
  ]) await writeFile(path.join(issuesRoot, ".github", "codekeeper", "agents", name), bundle.contents[asset]);
  const issuesSource = unifiedWorkflow(bundle, ["issues"]);
  await writeFile(path.join(issuesRoot, ".github", "workflows", "codekeeper.yml"), issuesSource);
  await writeFile(
    path.join(issuesRoot, ".github", "codekeeper-release.json"),
    `${JSON.stringify({
      version: 2,
      package: bundle.packageRelease,
      source: { repository: SOURCE_REPOSITORY, commit: HEAD_SHA },
      managedFiles: { ".github/workflows/codekeeper.yml": sha256(issuesSource) },
    }, null, 2)}\n`,
  );
  const issuesOnly = await inspectRepository({ runner: preflightRunner(issuesRoot), cwd: issuesRoot });
  assert.deepEqual(issuesOnly.installation.modes, ["issues"]);
  assert.equal(issuesOnly.installation.policy.automation.ownerRequests, true);
  assert.equal(issuesOnly.existingSettings.automationBotLogin, "codekeeper-widget[bot]");

  await writeFile(
    path.join(issuesRoot, ".github", "workflows", "codekeeper.yml"),
    issuesSource.replace("# owner_requests: true", "# owner_requests: false"),
  );
  const legacyIssuesOnly = await inspectRepository({ runner: preflightRunner(issuesRoot), cwd: issuesRoot });
  assert.equal(legacyIssuesOnly.installation.policy.automation.ownerRequests, false);
  assert.equal(legacyIssuesOnly.existingSettings.automationBotLogin, "codekeeper-widget[bot]");
});

test("legacy callers remain inspectable when their retired targets are recorded in the release ledger", async (t) => {
  const root = await temporaryDirectory(t);
  const bundle = await loadVerifiedAssets();
  await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(root, ".github", "codekeeper.json"), bundle.contents["policies/openai.json"]);
  const legacyFiles = {
    ".github/workflows/codekeeper-review.yml": legacyWorkflow("review", {
      autoReview: false,
      feedbackTriage: false,
    }),
    ".github/workflows/codekeeper-maintain.yml": legacyWorkflow("maintain", {
      schedule: "23 4 * * 2",
    }),
    ".github/workflows/codekeeper-runtime-review.yml": "name: Legacy review runtime\n",
    ".github/workflows/codekeeper-runtime-maintain.yml": "name: Legacy maintain runtime\n",
  };
  for (const [target, source] of Object.entries(legacyFiles)) {
    await writeFile(path.join(root, ...target.split("/")), source);
  }
  await writeFile(
    path.join(root, ".github", "codekeeper-release.json"),
    `${JSON.stringify({
      version: 2,
      package: bundle.packageRelease,
      source: { repository: SOURCE_REPOSITORY, commit: HEAD_SHA },
      managedFiles: Object.fromEntries(Object.entries(legacyFiles).map(([target, source]) => [target, sha256(source)])),
    }, null, 2)}\n`,
  );

  const installation = await inspectInstallationFiles(root);
  assert.deepEqual(installation.modes, ["review", "maintain"]);
  assert.equal(installation.policy.automation.automaticPrReview, false);
  assert.equal(installation.policy.automation.reviewFeedbackTriage, false);
  assert.equal(installation.policy.automation.maintenanceSchedule, "23 4 * * 2");
});

test("setup branch collision detection covers local refs, remote refs, and open pull requests", async () => {
  for (const [name, options] of [
    ["local", { localRefs: "refs/heads/codekeeper/setup\n" }],
    ["local namespace", { localRefs: "refs/heads/codekeeper/setup/child\n" }],
    ["remote", { remoteRefs: `${HEAD_SHA}\trefs/heads/codekeeper/setup\n` }],
    ["pull request", { pulls: [{ number: 7, url: "https://github.com/acme/widget/pull/7" }] }]
  ]) {
    const runner = preflightRunner("/tmp/widget", options);
    await assert.rejects(
      assertNoSetupBranch({ runner, root: "/tmp/widget", repository: "acme/widget" }),
      assertInstallerCode(assert, "SETUP_BRANCH_EXISTS"),
      name
    );
  }
});

test("setup branch collision detection ignores closed pull requests", async () => {
  const runner = preflightRunner("/tmp/widget");
  await assertNoSetupBranch({ runner, root: "/tmp/widget", repository: "acme/widget" });
  const pullRequestQuery = runner.calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "list");
  assert.deepEqual(pullRequestQuery?.args, [
    "pr",
    "list",
    "--repo",
    "acme/widget",
    "--state",
    "open",
    "--head",
    "codekeeper/setup",
    "--json",
    "number,url"
  ]);
});

test("repository preflight returns a frozen snapshot only after every local and GitHub check passes", async (t) => {
  const root = await temporaryDirectory(t);
  const resolvedRoot = await realpath(root);
  const runner = preflightRunner(root);
  const inspected = await inspectRepository({ runner, cwd: root, nodeVersion: "22.0.0", interactive: true });
  assert.deepEqual(inspected, {
    root: resolvedRoot,
    originUrl: "https://github.com/acme/widget.git",
    repository: "acme/widget",
    ownerType: "Organization",
    defaultBranch: "main",
    currentBranch: "main",
    headSha: HEAD_SHA,
    remoteDefaultSha: HEAD_SHA,
    viewerLogin: "cory",
    displayName: "widget",
    validationCommandCandidate: null
  });
  assert.ok(Object.isFrozen(inspected));
  assert.ok(runner.calls.every((call) => !call.options.env));
  const ghCalls = runner.calls.filter((call) => call.command === "gh");
  assert.ok(ghCalls.some((call) => call.args.includes("--hostname") && call.args.includes("github.com")));
});

test("repository preflight rejects the v1 negative matrix before installation mutation", async (t) => {
  const root = await temporaryDirectory(t);
  const authKey = commandKey("gh", ["auth", "status", "--hostname", "github.com"]);
  const ghVersionKey = commandKey("gh", ["--version"]);
  const detachedKey = commandKey("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const cases = [
    ["non-interactive", { interactive: false }, {}, "NON_INTERACTIVE"],
    ["missing gh", {}, { failures: new Map([[ghVersionKey, 127]]) }, "COMMAND_FAILED"],
    ["failed authentication", {}, { failures: new Map([[authKey, 1]]) }, "COMMAND_FAILED"],
    ["GHES", {}, { originUrl: "https://github.acme.test/acme/widget.git" }, "UNSUPPORTED_ORIGIN"],
    ["detached HEAD", {}, { failures: new Map([[detachedKey, 1]]) }, "COMMAND_FAILED"],
    ["dirty checkout", {}, { status: "?? notes.txt\n" }, "DIRTY_CHECKOUT"],
    ["stale checkout", {}, { remoteSha: OTHER_SHA }, "STALE_CHECKOUT"],
    ["not admin", {}, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "Organization" }, permissions: { admin: false } } }, "ADMIN_REQUIRED"],
    ["origin/API mismatch", {}, { repositoryData: { full_name: "other/widget", default_branch: "main", owner: { type: "Organization" }, permissions: { admin: true } } }, "REPOSITORY_MISMATCH"],
    ["actions disabled", {}, { actions: { enabled: false } }, "ACTIONS_DISABLED"],
    ["wrong branch", {}, { currentBranch: "feature" }, "WRONG_BRANCH"],
    ["archived repository", {}, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "Organization" }, permissions: { admin: true }, archived: true } }, "UNSUPPORTED_REPOSITORY"],
    ["sparse checkout", {}, { sparseStatus: 0, sparseValue: "true" }, "UNSUPPORTED_CHECKOUT"],
    ["missing git identity", {}, { userEmail: "" }, "GIT_IDENTITY_REQUIRED"],
    ["setup branch exists", {}, { localRefs: "refs/heads/codekeeper/setup\n" }, "SETUP_BRANCH_EXISTS"]
  ];
  for (const [name, inspectOptions, runnerOptions, code] of cases) {
    await t.test(name, async () => {
      const runner = preflightRunner(root, runnerOptions);
      await assert.rejects(
        inspectRepository({ runner, cwd: root, nodeVersion: "22.0.0", interactive: true, ...inspectOptions }),
        assertInstallerCode(assert, code)
      );
      assert.ok(runner.calls.every((call) => !["push", "commit", "secret", "variable"].some((token) => call.args.includes(token))));
    });
  }
});

test("repository preflight accepts personal and organization owners and fails closed for an unknown owner type", async (t) => {
  const root = await temporaryDirectory(t);
  const personal = await inspectRepository({
    runner: preflightRunner(root, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "User" }, permissions: { admin: true } } }),
    cwd: root,
    nodeVersion: "22.0.0",
    interactive: true
  });
  assert.equal(personal.ownerType, "User");

  await assert.rejects(
    inspectRepository({
      runner: preflightRunner(root, { repositoryData: { full_name: "acme/widget", default_branch: "main", owner: { type: "Bot" }, permissions: { admin: true } } }),
      cwd: root,
      nodeVersion: "22.0.0",
      interactive: true
    }),
    assertInstallerCode(assert, "PREFLIGHT_INVALID_RESPONSE")
  );
});

test("repository doctor aggregates independent failures and keeps mutation disabled", async (t) => {
  const root = await temporaryDirectory(t);
  const report = await doctorRepository({
    runner: preflightRunner(root, {
      bare: "true",
      status: " M notes.txt\n",
      remoteSha: OTHER_SHA,
      userName: "",
      repositoryData: {
        full_name: "acme/widget",
        default_branch: "main",
        owner: { type: "Organization" },
        permissions: { admin: false },
        archived: false,
        disabled: false,
      },
      actions: { enabled: false },
      membership: { state: "active", role: "member" },
      localRefs: "refs/heads/codekeeper/setup\n",
    }),
    cwd: root,
    nodeVersion: "22.0.0",
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  for (const id of ["checkout", "repository-admin", "actions", "clean-state", "remote-freshness", "git-identity", "setup-branch"]) {
    assert.equal(byId.get(id)?.status, "fail", id);
    assert.equal(byId.get(id)?.blocking, true, id);
  }
  assert.equal(byId.get("app-authority")?.status, "warning");
  assert.match(byId.get("app-authority")?.detail, /App Manager cannot install/);
  assert.ok(report.counts.fail >= 7);
  assert.ok(report.counts.warning >= 1);
  assert.equal(report.mutationAllowed, false);
  assert.ok(report.checks.length >= 14);
});

test("repository doctor reports an archived repository with the other readiness checks", async (t) => {
  const root = await temporaryDirectory(t);
  const report = await doctorRepository({
    runner: preflightRunner(root, {
      repositoryData: {
        full_name: "acme/widget",
        default_branch: "main",
        owner: { type: "Organization" },
        permissions: { admin: true },
        archived: true,
        disabled: false,
      },
    }),
    cwd: root,
    nodeVersion: "22.0.0",
  });
  const repositoryState = report.checks.find((check) => check.id === "repository-state");
  assert.equal(repositoryState?.status, "fail");
  assert.equal(repositoryState?.blocking, true);
  assert.equal(report.mutationAllowed, false);
});

test("repository doctor skips dependent checks when GitHub CLI and Git are unavailable", async (t) => {
  const root = await temporaryDirectory(t);
  const report = await doctorRepository({
    runner: preflightRunner(root, {
      failures: new Map([
        [commandKey("git", ["--version"]), 127],
        [commandKey("gh", ["--version"]), 127],
      ]),
    }),
    cwd: root,
    nodeVersion: "22.0.0",
  });
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("git")?.status, "fail");
  assert.equal(byId.get("gh")?.status, "fail");
  for (const id of ["checkout", "repository-identity", "auth", "clean-state", "remote-freshness", "git-identity", "installation", "setup-branch"]) {
    assert.equal(byId.get(id)?.status, "skipped", id);
  }
  assert.equal(report.mutationAllowed, false);
});

test("repository doctor reports organization membership authority without exposing response data", async (t) => {
  const root = await temporaryDirectory(t);
  for (const [name, membership, expectedStatus] of [
    ["owner", { state: "active", role: "admin" }, "pass"],
    ["member", { state: "active", role: "member" }, "warning"],
    ["unknown role", { state: "active", role: "triage" }, "warning"],
    ["malformed", { state: "active", role: "unexpected", token: "super-secret-membership-value" }, "warning"],
  ]) {
    await t.test(name, async () => {
      const report = await doctorRepository({
        runner: preflightRunner(root, { membership }),
        cwd: root,
        nodeVersion: "22.0.0",
      });
      const check = report.checks.find((candidate) => candidate.id === "app-authority");
      assert.equal(check?.status, expectedStatus);
      assert.doesNotMatch(check?.detail ?? "", /super-secret-membership-value/);
      assert.doesNotMatch(JSON.stringify(report), /stderr|token|pem|secret/i);
    });
  }
});

test("repository doctor accepts personal repository owners and returns a deeply frozen report", async (t) => {
  const root = await temporaryDirectory(t);
  const runner = preflightRunner(root, {
    repositoryData: {
      full_name: "acme/widget",
      default_branch: "main",
      owner: { type: "User" },
      permissions: { admin: true },
    },
  });
  const report = await doctorRepository({ runner, cwd: root, nodeVersion: "22.0.0" });
  const appAuthority = report.checks.find((check) => check.id === "app-authority");
  assert.equal(appAuthority?.status, "pass");
  assert.equal(runner.calls.some((call) => call.args.at(-1)?.startsWith("user/memberships/orgs/")), false);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.checks));
  assert.ok(report.checks.every((check) => Object.isFrozen(check)));
  assert.ok(Object.isFrozen(report.counts));
  assert.equal(report.mutationAllowed, true);
  assert.ok(report.checks.every((check) => !/(stderr|token|pem|secret)/i.test(JSON.stringify(check))));
  assert.ok(runner.calls.every((call) => !["push", "commit", "secret", "variable"].some((token) => call.args.includes(token))));
});
