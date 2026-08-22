import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveModePlan } from "../../../packages/codekeeper/src/mode-plan.mjs";
import {
  assertVerifiedModePlan,
  modeAdapter,
} from "../src/lib/orchestration/mode-adapters.mjs";
import {
  createArtifactHandoff,
  createValidationArtifactHandoff,
  verifyArtifactHandoff,
} from "../src/lib/orchestration/artifact-handoff.mjs";
import {
  createCommandArtifactHandoff,
  sealCommandArtifact,
} from "../src/lib/orchestration/command-artifact.mjs";
import { runCompute } from "../src/lib/orchestration/compute.mjs";
import { runPublish } from "../src/lib/orchestration/publish.mjs";
import { sha256 } from "../src/lib/markers.mjs";
import {
  assertCredentialBoundary,
  resolveAutomationBot,
  validateAppPermissionInputs,
} from "../src/lib/orchestration/credential-boundaries.mjs";
import {
  ancestorDirectories,
  environmentAssignments,
  runIsolatedWorkspaceAgent,
} from "../src/lib/orchestration/workspace-isolation.mjs";

const modeEvents = {
  review: { eventName: "pull_request" },
  issues: { eventName: "issues" },
  maintain: { eventName: "schedule" },
  fix: { eventName: "repository_dispatch" },
};

function packagePlan(mode, policy = {}) {
  return resolveModePlan({
    requestedMode: mode,
    event: modeEvents[mode],
    policy,
  });
}

test("mode adapters expose one trusted adapter for every workflow mode", () => {
  for (const mode of ["review", "issues", "maintain", "fix"]) {
    const plan = packagePlan(mode);
    assert.equal(assertVerifiedModePlan(plan, mode).resolvedMode, mode);
    assert.equal(typeof modeAdapter(mode).prepare, "function");
    assert.equal(typeof modeAdapter(mode).seal, "function");
    assert.equal(typeof modeAdapter(mode).publish, "function");
  }
});

test("verified plans reject adapter, permission, and unknown-field tampering", () => {
  const plan = packagePlan("review");
  assert.throws(
    () => assertVerifiedModePlan({ ...plan, unexpected: true }, "review"),
    /unknown properties/,
  );
  const { trigger: _trigger, ...missingTrigger } = plan;
  assert.throws(
    () => assertVerifiedModePlan(missingTrigger, "review"),
    /missing required properties/,
  );
  assert.throws(
    () =>
      assertVerifiedModePlan({ ...plan, publicationAdapter: "fix" }, "review"),
    /publication adapter/,
  );
  assert.throws(
    () =>
      assertVerifiedModePlan(
        {
          ...plan,
          appPermissions: { ...plan.appPermissions, issues: "admin" },
        },
        "review",
      ),
    /invalid permission/,
  );
  assert.throws(
    () =>
      assertVerifiedModePlan({ ...plan, workspaceAccess: "admin" }, "review"),
    /workspaceAccess/,
  );
  assert.throws(
    () =>
      assertVerifiedModePlan({ ...plan, workspaceAccess: "write" }, "review"),
    /workspaceAccess does not match/,
  );
  assert.throws(
    () =>
      assertVerifiedModePlan({ ...plan, validationRequired: true }, "review"),
    /validationRequired does not match/,
  );
  assert.throws(
    () =>
      assertVerifiedModePlan(
        { ...plan, appPermissions: { ...plan.appPermissions, issues: "read" } },
        "review",
      ),
    /issues permission does not match/,
  );
});

test("runtime consumes the package-produced plan without resolving routing", () => {
  const plan = packagePlan("review");
  assert.equal(plan.requiredGate, true);
  assert.equal(
    assertVerifiedModePlan(plan, "review").publicationAdapter,
    "review",
  );
});

test("runtime requires exact policy-derived permission escalation", () => {
  const reviewRepair = packagePlan("review", {
    review: { autoRepair: true },
  });
  assert.equal(
    assertVerifiedModePlan(reviewRepair, "review", {
      config: { review: { autoRepair: true } },
    }).appPermissions.contents,
    "write",
  );
  assert.throws(
    () =>
      assertVerifiedModePlan(
        {
          ...reviewRepair,
          appPermissions: { ...reviewRepair.appPermissions, contents: "read" },
        },
        "review",
        { config: { review: { autoRepair: true } } },
      ),
    /contents permission does not match/,
  );

  const maintainReport = packagePlan("maintain");
  assert.equal(
    assertVerifiedModePlan(maintainReport, "maintain", {
      config: { audit: { repair: { enabled: false } } },
    }).appPermissions.pullRequests,
    "read",
  );
  const maintainRepair = packagePlan("maintain", {
    audit: { repair: { enabled: true } },
  });
  assert.equal(
    assertVerifiedModePlan(maintainRepair, "maintain", {
      config: { audit: { repair: { enabled: true } } },
    }).appPermissions.pullRequests,
    "write",
  );
});

test("App permissions are checked against the trusted plan", () => {
  const plan = packagePlan("review");
  assert.deepEqual(
    validateAppPermissionInputs({
      expected: plan.appPermissions,
      contents: "read",
      issues: "write",
      pullRequests: "write",
    }),
    plan.appPermissions,
  );
  assert.throws(
    () =>
      validateAppPermissionInputs({
        expected: plan.appPermissions,
        contents: "write",
        issues: "write",
        pullRequests: "write",
      }),
    /does not match/,
  );
});

test("stage credential allowlists fail closed", () => {
  assert.equal(
    assertCredentialBoundary("workspace", { workspaceKey: "workspace" }),
    true,
  );
  assert.equal(
    assertCredentialBoundary("coordinator", {
      modelKey: "model",
      traceKey: "trace",
    }),
    true,
  );
  assert.equal(
    assertCredentialBoundary("publication", { token: "app-token" }),
    true,
  );
  assert.throws(
    () => assertCredentialBoundary("workspace", { modelKey: "model" }),
    /Workspace stage/,
  );
  assert.throws(
    () =>
      assertCredentialBoundary("coordinator", { workspaceKey: "workspace" }),
    /Coordinator stage/,
  );
  assert.throws(
    () => assertCredentialBoundary("validate", { token: "token" }),
    /must not receive an App token/,
  );
  assert.throws(
    () => assertCredentialBoundary("publication", { traceKey: "trace" }),
    /must not receive model/,
  );
});

test("automation bot identity is resolved from the immutable App slug", async () => {
  const identity = await resolveAutomationBot({
    token: "token",
    apiUrl: "https://api.github.test",
    appSlug: "codekeeper",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.github.test/users/codekeeper[bot]");
      assert.equal(options.headers.Authorization, "Bearer token");
      return {
        ok: true,
        json: async () => ({ login: "codekeeper[bot]", id: 42 }),
      };
    },
  });
  assert.deepEqual(identity, { login: "codekeeper[bot]", id: 42 });
});

test("publish stage requires the verified plan before adapter execution", async () => {
  await assert.rejects(
    runPublish({
      mode: "review",
      operation: "permissions",
      contentsPermission: "read",
      issuesPermission: "write",
      pullRequestsPermission: "write",
    }),
    /Mode plan must be a plain object/,
  );
});

test("workspace isolation grants world execute on ancestor directories of the installed CLI", () => {
  assert.deepEqual(
    ancestorDirectories(
      "/home/runner/work/repo/repo/tooling/codekeeper-runtime/src/cli.mjs",
    ),
    [
      "/home/runner/work/repo/repo/tooling/codekeeper-runtime/src",
      "/home/runner/work/repo/repo/tooling/codekeeper-runtime",
      "/home/runner/work/repo/repo/tooling",
      "/home/runner/work/repo/repo",
      "/home/runner/work/repo",
      "/home/runner/work",
      "/home/runner",
      "/home",
    ],
  );
  assert.doesNotMatch(
    ancestorDirectories("/home/runner/work/repo/repo").join("\n"),
    /^\/$/m,
  );
});

test("workspace isolation passes env -i KEY=VALUE assignments to the isolated user", () => {
  assert.deepEqual(
    environmentAssignments({
      CI: "true",
      HOME: "/home/runner/work/repo/repo/codekeeper-codex-home",
    }),
    [
      "CI=true",
      "HOME=/home/runner/work/repo/repo/codekeeper-codex-home",
    ],
  );
  assert.throws(
    () => environmentAssignments({ "CI true": "1" }),
    /Invalid environment name/,
  );
});

test("workspace isolation restores only quarantined skill surfaces", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-workspace-isolation-"),
  );
  const repository = path.join(root, "repository");
  const bundle = path.join(root, "bundle");
  const resultPath = path.join(bundle, "workspace-result.json");
  const skillPath = path.join(
    repository,
    ".agents",
    "skills",
    "example",
    "SKILL.md",
  );
  const instructionPath = path.join(repository, ".agents", "AGENTS.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(bundle, { recursive: true });
  await writeFile(skillPath, "skill\n");
  await writeFile(instructionPath, "instructions\n");
  try {
    await runIsolatedWorkspaceAgent({
      mode: "review",
      directory: bundle,
      resultPath,
      configPath: path.join(root, "config.json"),
      modePlanPath: path.join(root, "mode-plan.json"),
      cliPath: path.join(root, "cli.mjs"),
      workspaceApiKey: "workspace-key",
      codexHome: path.join(root, "codex-home"),
      quarantine: path.join(root, "quarantine"),
      workspaceTemp: path.join(root, "workspace-temp"),
      repositoryPath: repository,
      worker: async () => {
        await assert.rejects(readFile(skillPath), { code: "ENOENT" });
        assert.equal(await readFile(instructionPath, "utf8"), "instructions\n");
        await writeFile(resultPath, "{}\n");
        await writeFile(
          path.join(bundle, "workspace-runtime-metadata.json"),
          "{}\n",
        );
      },
    });
    assert.equal(await readFile(skillPath, "utf8"), "skill\n");
    assert.equal(await readFile(instructionPath, "utf8"), "instructions\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled workspaces preserve no-evidence coordinator semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-disabled-"));
  const agent = {
    provider: "openai",
    model: "test",
    effort: "low",
    maxTurns: 1,
    maximumAttempts: 1,
    workspace: { enabled: false },
  };
  const config = {
    review: { reasoningEscalation: { enabled: false } },
    ai: {
      agents: { review: agent, issue: agent },
      providers: { openai: { api: "responses" } },
      tracing: {},
    },
  };
  try {
    for (const mode of ["review", "issues"]) {
      const directory = path.join(root, mode);
      const resultPath = path.join(directory, "workspace-result.json");
      await mkdir(directory);
      assert.deepEqual(
        await runCompute({
          mode,
          operation: "workspace",
          plan: packagePlan(mode),
          config,
          directory,
          resultPath,
          workspaceApiKey: "workspace-key",
        }),
        { skipped: true, mode: mode === "issues" ? "issue" : mode },
      );
      await assert.rejects(readFile(resultPath), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact stages bind the PR3 handoff manifest to candidate and validation bytes", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-orchestration-"),
  );
  const candidateDirectory = path.join(root, "candidate");
  await mkdir(candidateDirectory);
  const sourceCommit = "b".repeat(40);
  const context = {
    mode: "issue",
    repository: "owner/repository",
    baseSha: "a".repeat(40),
    toolingSha: sourceCommit,
    requestedBy: "actor",
    issue: { number: 7 },
  };
  const config = {
    repository: { defaultBranch: "main" },
    ai: { agents: { review: { workspace: { enabled: false } } } },
  };
  const plan = packagePlan("review");
  const planPath = path.join(root, "mode-plan.json");
  const configPath = path.join(root, "policy.json");
  await writeFile(planPath, `${JSON.stringify(plan)}\n`);
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  for (const [name, value] of Object.entries({
    "agent-profile.md": "profile",
    "context.json": JSON.stringify(context),
    "result.json": "{}",
    "validation.json": "{}",
    "runtime-metadata.json": JSON.stringify({
      mode: "issue",
      attempt: 1,
      maxTurns: 1,
      durationMs: 0,
      promptBytes: 0,
      evidenceBytes: 0,
      outputBytes: 0,
      usage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
    }),
    "candidate.json": "{}",
  })) {
    await writeFile(path.join(candidateDirectory, name), value);
  }
  const previous = Object.fromEntries(
    [
      "CODEKEEPER_PACKAGE_VERSION",
      "CODEKEEPER_PACKAGE_INTEGRITY",
      "GITHUB_EVENT_NAME",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ID",
      "GITHUB_ACTOR",
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    CODEKEEPER_PACKAGE_VERSION: "0.4.0",
    CODEKEEPER_PACKAGE_INTEGRITY:
      "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    GITHUB_EVENT_NAME: "issues",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_RUN_ID: "123",
    GITHUB_ACTOR: "actor",
  });
  try {
    const compute = await createArtifactHandoff({
      sourceDirectory: candidateDirectory,
      modePlanPath: planPath,
      configPath,
      config,
      toolingSha: "",
      workspaceResultPath: path.join(root, "missing-workspace-result.json"),
    });
    assert.equal(
      await readFile(
        path.join(candidateDirectory, "workspace-result.json"),
        "utf8",
      ),
      '{"skipped":true}\n',
    );
    await verifyArtifactHandoff({
      sourceDirectory: candidateDirectory,
      expectedManifestSha256: compute.handoffManifestSha256,
      expectedModePlanPath: planPath,
      expectedPolicyPath: configPath,
      config,
      toolingSha: "",
    });
    await assert.rejects(
      verifyArtifactHandoff({
        sourceDirectory: candidateDirectory,
        expectedManifestSha256: compute.handoffManifestSha256,
        expectedModePlanPath: planPath,
        expectedPolicyPath: configPath,
        config,
        toolingSha: "c".repeat(40),
      }),
      /source commit does not match/,
    );
    await writeFile(
      planPath,
      `${JSON.stringify({ ...plan, targetNumber: 99 })}\n`,
    );
    await assert.rejects(
      verifyArtifactHandoff({
        sourceDirectory: candidateDirectory,
        expectedManifestSha256: compute.handoffManifestSha256,
        expectedModePlanPath: planPath,
        expectedPolicyPath: configPath,
        config,
        toolingSha: sourceCommit,
      }),
      /independently resolved plan/,
    );
    await writeFile(planPath, `${JSON.stringify(plan)}\n`);
    await writeFile(
      path.join(candidateDirectory, "validation-receipt.json"),
      "receipt\n",
    );
    const validation = await createValidationArtifactHandoff({
      sourceDirectory: candidateDirectory,
      config,
      toolingSha: sourceCommit,
    });
    await verifyArtifactHandoff({
      sourceDirectory: candidateDirectory,
      expectedManifestSha256: validation.handoffManifestSha256,
      expectedKind: "validation",
      config,
      toolingSha: sourceCommit,
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("deterministic owner commands are digest-bound and sealed without credentials", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-command-handoff-"),
  );
  const candidateDirectory = path.join(root, "candidate");
  const artifactDirectory = path.join(root, "sealed");
  const sourceCommit = "d".repeat(40);
  const plan = resolveModePlan({
    requestedMode: "auto",
    event: {
      eventName: "issue_comment",
      command: "status",
      surface: "issue",
      targetNumber: 42,
    },
  });
  const config = {
    repository: { defaultBranch: "main" },
    ai: { agents: { issue: { workspace: { enabled: false } } } },
  };
  const commandContext = {
    schemaVersion: 1,
    eventName: "issue_comment",
    repository: "owner/repository",
    actor: "owner",
    association: "OWNER",
    command: "status",
    canonicalCommand: "status",
    surface: "issue",
    targetNumber: 42,
    commentId: 99,
    commentSha256: "e".repeat(64),
    executionKind: "deterministic",
  };
  const planPath = path.join(root, "mode-plan.json");
  const configPath = path.join(root, "config.json");
  await writeFile(planPath, `${JSON.stringify(plan)}\n`);
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  const configSha256 = sha256(await readFile(configPath));
  const previous = Object.fromEntries(
    [
      "CODEKEEPER_PACKAGE_VERSION",
      "CODEKEEPER_PACKAGE_INTEGRITY",
      "GITHUB_EVENT_NAME",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ID",
      "GITHUB_ACTOR",
    ].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    CODEKEEPER_PACKAGE_VERSION: "0.4.0",
    CODEKEEPER_PACKAGE_INTEGRITY:
      "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    GITHUB_EVENT_NAME: "issue_comment",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_RUN_ID: "command-run",
    GITHUB_ACTOR: "owner",
  });
  try {
    const candidate = await createCommandArtifactHandoff({
      artifactDirectory: candidateDirectory,
      commandContext,
      modePlanPath: planPath,
      configPath,
      config,
      toolingSha: sourceCommit,
      configSha256,
    });
    assert.match(candidate.candidateSha256, /^[a-f0-9]{64}$/);
    assert.match(candidate.contextSha256, /^[a-f0-9]{64}$/);
    assert.match(candidate.handoffManifestSha256, /^[a-f0-9]{64}$/);
    const sealed = await sealCommandArtifact({
      candidateDirectory,
      artifactDirectory,
      expectedCandidateSha256: candidate.candidateSha256,
      expectedContextSha256: candidate.contextSha256,
      expectedHandoffManifestSha256: candidate.handoffManifestSha256,
      modePlanPath: planPath,
      configPath,
      config,
      toolingSha: sourceCommit,
      configSha256,
    });
    assert.equal(sealed.manifest.sealed, true);
    assert.equal(sealed.manifest.kind, "owner-command");
    await writeFile(path.join(candidateDirectory, "context.json"), "{}\n");
    await assert.rejects(
      sealCommandArtifact({
        candidateDirectory,
        artifactDirectory: path.join(root, "tampered-seal"),
        expectedCandidateSha256: candidate.candidateSha256,
        expectedContextSha256: candidate.contextSha256,
        expectedHandoffManifestSha256: candidate.handoffManifestSha256,
        modePlanPath: planPath,
        configPath,
        config,
        toolingSha: sourceCommit,
        configSha256,
      }),
      /baseSha|digest|inventory|stale|changed/i,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
