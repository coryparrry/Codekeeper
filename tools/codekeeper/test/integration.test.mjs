import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROFILE_BUNDLE_FILE, agentProfilePathForMode } from "../src/lib/agent-profiles.mjs";
import { runAgentFromBundle } from "../src/lib/agents-runtime.mjs";
import { issueDispatchReceipt } from "../src/lib/commands.mjs";
import { boundedChangedFilesBetween, boundedDiffBetween, changedLineHunksBetween, collectWorkingTreeChanges, runValidationCommands, validationEnvironment } from "../src/lib/git.mjs";
import { prepareAudit as prepareAuditBundle, prepareFix, prepareIssue, prepareReview } from "../src/lib/prepare.mjs";
import { normalizeLivePolicy } from "../src/lib/policy-normalization.mjs";
import { validateFrozenReviewFeedback } from "../src/lib/validate.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "../../..");
const cli = path.join(projectRoot, "tools/codekeeper/src/cli.mjs");
const configSource = path.join(projectRoot, ".github/codekeeper.json");
const templateConfig = normalizeLivePolicy(JSON.parse(await readFile(configSource, "utf8")));

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bundle(root, name = "bundle") {
  return `${root}-${name}`;
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function closingPullRequestsResponse(nodes = []) {
  return {
    data: {
      repository: {
        issue: {
          closedByPullRequestsReferences: {
            nodes,
            pageInfo: { hasNextPage: false }
          }
        }
      }
    }
  };
}

function assertWorkspaceOutputSchema(schema, mode) {
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties?.mode, { type: "string", enum: [mode] });
  assert.doesNotMatch(JSON.stringify(schema), /"const"/);
}

async function installAgentProfiles(root) {
  for (const mode of ["review", "audit", "issue", "fix"]) {
    const destination = path.join(root, agentProfilePathForMode(mode));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(
      path.join(projectRoot, "tools/codekeeper/agents", path.basename(destination)),
      destination
    );
  }
}

function agentProfileOptions(root, mode, sourceSha = run("git", ["rev-parse", "HEAD"], root).trim()) {
  return {
    agentProfilePath: path.join(root, agentProfilePathForMode(mode)),
    agentProfileSourceSha: sourceSha
  };
}

function agentProfileCliArgs(root, mode, sourceSha = run("git", ["rev-parse", "HEAD"], root).trim()) {
  const options = agentProfileOptions(root, mode, sourceSha);
  return ["--agent-profile", options.agentProfilePath, "--agent-profile-source-sha", options.agentProfileSourceSha];
}

function auditResult({ repair = false } = {}) {
  return {
    mode: "audit",
    summary: repair ? "README drift was repaired." : "No repository drift was found.",
    findings: repair
      ? [{
        title: "README drift",
        evidence: "The README omitted current guidance.",
        category: "docs",
        priority: "p3",
        owningPath: "README.md",
        problemKey: "readme-guidance-drift",
        proposedAction: "Add current guidance.",
        labels: []
      }]
      : [],
    repair: repair
      ? {
        requested: true,
        findingIndex: 0,
        title: "docs: repair README drift",
        body: "Adds current repository guidance.",
        risk: "low",
        validationSummary: "git diff --check passed"
      }
      : {
        requested: false,
        findingIndex: null,
        title: "",
        body: "",
        risk: "low",
        validationSummary: ""
      },
    noActionReason: repair ? null : "The repository is internally consistent."
  };
}

async function createRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-test-"));
  await mkdir(path.join(root, ".github"), { recursive: true });
  await copyFile(configSource, path.join(root, ".github/codekeeper.json"));
  await installAgentProfiles(root);
  await writeFile(path.join(root, "README.md"), "# Example\n", "utf8");
  run("git", ["init", "-q"], root);
  run("git", ["config", "user.name", "Test"], root);
  run("git", ["config", "user.email", "test@example.com"], root);
  run("git", ["add", "."], root);
  run("git", ["commit", "-qm", "initial"], root);
  return root;
}

test("validation commands receive a disposable home and a credential-free direct parent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-validation-boundary-test-"));
  const homeRecord = path.join(root, "validation-home");
  const rustupHome = path.join(root, "rustup");
  const savedEnvironment = Object.fromEntries(
    ["HOME", "RUSTUP_HOME"].map((name) => [name, process.env[name]])
  );
  await mkdir(rustupHome);
  process.env.RUSTUP_HOME = rustupHome;
  try {
    const command = [
      'test -n "$HOME"',
      `test "$HOME" != ${shellLiteral(savedEnvironment.HOME ?? "")}`,
      `test "$RUSTUP_HOME" = ${shellLiteral(await realpath(rustupHome))}`,
      `if test -r "/proc/$PPID/environ"; then ! tr '\\0' '\\n' < "/proc/$PPID/environ" | cut -d= -f1 | grep -E '(^|_)(TOKEN|API_KEY|PRIVATE_KEY|PAT|SECRET)($|_)'; fi`,
      `printf '%s' "$HOME" > ${shellLiteral(homeRecord)}`
    ].join(" && ");
    const results = await runValidationCommands([command], root);
    assert.equal(results[0].success, true);
    const disposableHome = await readFile(homeRecord, "utf8");
    assert.notEqual(disposableHome, savedEnvironment.HOME);
    await assert.rejects(lstat(disposableHome), { code: "ENOENT" });
  } finally {
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("validation environment admits only verified Rust toolchain state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-validation-rustup-test-"));
  const rustupHome = path.join(root, "rustup");
  const link = path.join(root, "rustup-link");
  await mkdir(rustupHome);
  await symlink(rustupHome, link);
  try {
    const valid = await validationEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      RUSTUP_HOME: rustupHome,
      OPENAI_API_KEY: "must-not-pass"
    });
    assert.deepEqual(valid, { PATH: "/usr/bin:/bin", RUSTUP_HOME: await realpath(rustupHome) });

    const missing = await validationEnvironment({ PATH: "/usr/bin:/bin", RUSTUP_HOME: path.join(root, "missing") });
    assert.deepEqual(missing, { PATH: "/usr/bin:/bin" });

    const symlinked = await validationEnvironment({ PATH: "/usr/bin:/bin", RUSTUP_HOME: link });
    assert.deepEqual(symlinked, { PATH: "/usr/bin:/bin" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("working-tree metadata preserves rename and executable-file policy inputs", async () => {
  const root = await createRepository();
  run("git", ["mv", "README.md", "RENAMED.md"], root);
  await writeFile(path.join(root, "script.sh"), "#!/bin/sh\necho safe\n", "utf8");
  run("chmod", ["755", "script.sh"], root);
  run("git", ["add", "script.sh"], root);

  const changes = await collectWorkingTreeChanges(root);
  const renamed = changes.files.find((file) => file.path === "RENAMED.md");
  const executable = changes.files.find((file) => file.path === "script.sh");
  assert.equal(renamed.status.startsWith("R"), true);
  assert.equal(renamed.sourcePath, "README.md");
  assert.equal(executable.newMode, "100755");
});

test("review context terminates a large bounded diff and rejects excessive changed-file context", async () => {
  const root = await createRepository();
  const base = run("git", ["rev-parse", "HEAD"], root).trim();
  await writeFile(path.join(root, "large.md"), `${"x".repeat(2 * 1024 * 1024)}\n`, "utf8");
  await writeFile(path.join(root, "second.md"), "second changed file\n", "utf8");
  run("git", ["add", "large.md", "second.md"], root);
  run("git", ["commit", "-qm", "large review context"], root);
  const head = run("git", ["rev-parse", "HEAD"], root).trim();

  const diff = await boundedDiffBetween(base, head, 512, root);
  assert.equal(diff.includedBytes, 512);
  assert.equal(Buffer.byteLength(diff.patch), 512);
  assert.ok(diff.bytes > diff.includedBytes);
  assert.ok(diff.bytes < 2 * 1024 * 1024);
  assert.equal(diff.bytesExact, false);
  assert.equal(diff.truncated, true);
  const complete = await boundedDiffBetween(base, head, 3 * 1024 * 1024, root);
  assert.equal(complete.bytesExact, true);
  assert.equal(complete.truncated, false);
  assert.equal(complete.bytes, complete.includedBytes);
  assert.equal(complete.bytes, Buffer.byteLength(complete.patch));
  await assert.rejects(
    boundedChangedFilesBetween(base, head, 1, root),
    /changed-file context exceeds configured maximum/
  );
});

test("feedback-triggered review preparation freezes the complete current review surface", async () => {
  const root = await createRepository();
  await writeFile(path.join(root, "README.md"), "# Example\n\nFeedback target.\n");
  run("git", ["add", "README.md"], root);
  run("git", ["commit", "-qm", "feedback target"], root);
  const revision = run("git", ["rev-parse", "HEAD"], root).trim();
  const comparisonHead = run("git", ["rev-parse", "HEAD"], projectRoot).trim();
  const comparisonBase = comparisonHead;
  const eventPath = bundle(root, "review-feedback-event.json");
  await writeFile(eventPath, JSON.stringify({
    action: "created",
    repository: { full_name: "acme/example" },
    comment: { id: 42, pull_request_review_id: 7, body: "Please add a timeout test." },
    pull_request: {
      number: 7,
      title: "Feedback inventory",
      body: "",
      draft: false,
      html_url: "https://github.com/acme/example/pull/7",
      user: { login: "contributor" },
      base: { ref: "main", sha: comparisonBase },
      head: { ref: "feature", sha: comparisonHead, repo: { full_name: "acme/example" } }
    }
  }));
  const originalFetch = globalThis.fetch;
  const originalAutomationLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = "codekeeper-app[bot]";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/pulls/7/reviews")) {
      return new Response(JSON.stringify([
        { id: 7, body: "General review note", state: "CHANGES_REQUESTED", html_url: "https://github.test/review/7", user: { login: "reviewer" } },
        { id: 8, body: "Codekeeper automation review", state: "COMMENTED", html_url: "https://github.test/review/8", user: { login: "codekeeper-app[bot]" } }
      ]), { status: 200 });
    }
    if (String(url).endsWith("/graphql")) {
      const reviewThreads = {
        nodes: [{
          id: "PRRT_thread",
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              { id: "PRRC_node_41", databaseId: 41, body: "Root timeout concern", url: "https://github.test/comment/41", path: "README.md", line: 1, originalLine: 1, author: { login: "reviewer" } },
              { id: "PRRC_node_42", databaseId: 42, body: "Please add a timeout test", url: "https://github.test/comment/42", path: "README.md", line: 1, originalLine: 1, author: { login: "owner" } },
              { id: "PRRC_node_44", databaseId: 44, body: "/codekeeper fix", url: "https://github.test/comment/44", path: "README.md", line: 1, originalLine: 1, author: { login: "repository-owner" } },
              { id: "PRRC_node_45", databaseId: 45, body: "/codekeeper fix", url: "https://github.test/comment/45", path: "README.md", line: 1, originalLine: 1, author: { login: "reviewer" } },
              { id: "PRRC_node_43", databaseId: 43, body: "Handled.\n\n<!-- codekeeper:review-feedback-reply=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->", url: "https://github.test/comment/43", path: "README.md", line: 1, originalLine: 1, author: { login: "codekeeper-app[bot]" } }
            ],
            pageInfo: { hasNextPage: false }
          }
        }],
        pageInfo: { hasNextPage: false, endCursor: null }
      };
      return new Response(JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads } } }
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const context = await prepareReview({
      eventPath,
      directory: bundle(root, "review-feedback"),
      config: templateConfig,
      token: "read-token",
      ...agentProfileOptions(root, "review", revision)
    });
    assert.deepEqual(context.pullRequest.reviewFeedback.map((item) => item.sourceKey), [
      "review_comment:41",
      "review_comment:42",
      "review_comment:45",
      "review:7"
    ]);
    assert.equal(context.pullRequest.reviewFeedback[0].threadId, "PRRT_thread");

    const config = structuredClone(templateConfig);
    config.ai.agents.review.workspace.enabled = false;
    config.ai.tracing.enabled = false;
    const resultPath = bundle(root, "review-feedback-result.json");
    const metadata = await runAgentFromBundle({
      mode: "review",
      directory: bundle(root, "review-feedback"),
      config,
      resultPath,
      apiKey: "",
      sdkLoader: async () => { throw new Error("provider must not load"); }
    });
    assert.equal(metadata.provider, "deterministic");
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.deepEqual(result.reviewFeedback.flatMap((item) => item.sourceKeys), [
      "review_comment:41",
      "review_comment:42",
      "review_comment:45",
      "review:7"
    ]);
    assert.ok(result.reviewFeedback.every((item) => item.disposition === "ignore"));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAutomationLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = originalAutomationLogin;
  }
});

test("inactive frozen review feedback cannot trigger repairs or deferred work", () => {
  const sources = [
    { sourceKey: "review_comment:1", kind: "review_comment", threadId: "resolved", resolved: true, outdated: false, state: "commented" },
    { sourceKey: "review_comment:2", kind: "review_comment", threadId: "outdated", resolved: false, outdated: true, state: "commented" },
    { sourceKey: "review:3", kind: "review", threadId: null, resolved: false, outdated: false, state: "DISMISSED" }
  ];
  const feedback = sources.map((source, index) => ({
    problemKey: `inactive-${index}`,
    disposition: ["fix_now", "fix_if_cheap", "defer"][index],
    sourceKeys: [source.sourceKey],
    threadIds: source.threadId ? [source.threadId] : []
  }));

  assert.throws(
    () => validateFrozenReviewFeedback(sources, feedback),
    /must ignore resolved, outdated, or dismissed frozen sources/
  );
  validateFrozenReviewFeedback(
    sources,
    feedback.map((item) => ({ ...item, disposition: "ignore" }))
  );
  assert.throws(
    () => validateFrozenReviewFeedback(
      [...sources, { sourceKey: "review:4", kind: "review", threadId: null, resolved: false, outdated: false, state: "CHANGES_REQUESTED" }],
      [{ problemKey: "mixed", disposition: "ignore", sourceKeys: [...sources.map((item) => item.sourceKey), "review:4"], threadIds: ["resolved", "outdated"] }]
    ),
    /mixes active and inactive frozen sources/
  );
});

function prepareAudit(root, directory, env = {}, repairAuthorized = false) {
  run(
    "node",
    [
      cli, "prepare-audit", "--config", ".github/codekeeper.json", "--directory", directory,
      "--actor", "repository-owner", "--repair-authorized", String(repairAuthorized),
      ...agentProfileCliArgs(root, "audit")
    ],
    root,
    { GITHUB_REPOSITORY: "acme/example", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", ...env }
  );
  writeRuntimeMetadataFixture(directory, "audit");
}

function writeRuntimeMetadataFixture(directory, mode) {
  writeFileSync(path.join(directory, "runtime-metadata.json"), `${JSON.stringify({
    mode,
    provider: "offline",
    model: "offline-fixture",
    attempt: 1,
    structuredOutputs: true,
    workspaceSpecialistUsed: true,
    maxTurns: 1,
    durationMs: 1,
    promptBytes: 1,
    evidenceBytes: 1,
    outputBytes: 1,
    cacheKey: "offline-fixture",
    cacheMode: "unsupported",
    usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
  }, null, 2)}\n`);
}

test("prepare requires an external runner-owned directory and cannot follow checkout symlinks", async () => {
  const root = await createRepository();
  const victim = `${root}-victim`;
  const checkoutDirectory = path.join(root, ".codekeeper");
  const checkoutSink = path.join(root, ".codekeeper-sink");
  const externalFinalSymlink = `${root}-final-symlink`;
  const externalParentSymlink = `${root}-parent-symlink`;
  await writeFile(victim, "safe\n", "utf8");
  await symlink(victim, checkoutDirectory);

  assert.throws(
    () => run("node", [cli, "prepare-audit", "--config", ".github/codekeeper.json", "--directory", checkoutDirectory], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );
  assert.equal(await readFile(victim, "utf8"), "safe\n");
  assert.equal((await lstat(checkoutDirectory)).isSymbolicLink(), true);

  await mkdir(checkoutSink);
  await symlink(checkoutSink, externalFinalSymlink);
  assert.throws(
    () => run("node", [cli, "prepare-audit", "--config", ".github/codekeeper.json", "--directory", externalFinalSymlink], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );
  assert.equal((await lstat(externalFinalSymlink)).isSymbolicLink(), true);
  await assert.rejects(lstat(path.join(checkoutSink, "context.json")), { code: "ENOENT" });

  await symlink(root, externalParentSymlink);
  const parentBundle = path.join(externalParentSymlink, "bundle");
  assert.throws(
    () => run("node", [cli, "prepare-audit", "--config", ".github/codekeeper.json", "--directory", parentBundle], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );
  await assert.rejects(lstat(path.join(root, "bundle")), { code: "ENOENT" });

  const externalDirectory = bundle(root, "trusted-input");
  prepareAudit(root, externalDirectory);
  assert.equal((await lstat(path.join(externalDirectory, "context.json"))).isFile(), true);
  assert.equal(await readFile(victim, "utf8"), "safe\n");
});

test("prepare accepts runner files through the macOS /var alias", async (context) => {
  const canonicalVar = await realpath("/var");
  if (canonicalVar === "/var") return context.skip("this platform does not canonicalize /var");
  const root = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = bundle(root, "var-alias");
  if (!directory.startsWith("/var/")) return context.skip("the temporary directory does not use the /var alias");

  prepareAudit(root, directory);
  assert.equal((await lstat(path.join(directory, "context.json"))).isFile(), true);
});

test("preparation freezes one trusted profile for workspace and the coordinator cache prefix", async (context) => {
  const root = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = bundle(root, "profile-proof");
  const profilePath = path.join(root, agentProfilePathForMode("audit"));
  const profile = "# Repository behavior — owner controlled\n\nReport drift, but never invent work.\n";
  await writeFile(profilePath, profile, "utf8");
  run("git", ["add", agentProfilePathForMode("audit")], root);
  run("git", ["commit", "-qm", "customize audit behavior"], root);
  const sourceSha = run("git", ["rev-parse", "HEAD"], root).trim();
  const config = structuredClone(templateConfig);
  config.ai.tracing.enabled = false;
  await prepareAuditBundle({
    directory,
    config,
    ...agentProfileOptions(root, "audit", sourceSha)
  });

  const frozenBytes = await readFile(path.join(directory, "agent-profile.md"));
  const frozenContext = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));
  const workspacePrompt = await readFile(path.join(directory, "workspace-prompt.md"), "utf8");
  assert.deepEqual(frozenBytes, Buffer.from(profile));
  assert.deepEqual(frozenContext.agentProfile, {
    source: "repository",
    path: agentProfilePathForMode("audit"),
    sha256: digest(frozenBytes),
    sourceSha
  });
  assert.ok(workspacePrompt.includes(profile));
  assert.ok(workspacePrompt.indexOf("IMMUTABLE CODEKEEPER SAFETY") < workspacePrompt.indexOf(profile));

  const calls = {};
  class FakeProvider { async close() {} }
  class FakeAgent { constructor(options) { calls.instructions = options.instructions; } }
  class FakeRunner {
    async run(_agent, input) {
      calls.input = input;
      return { finalOutput: auditResult() };
    }
  }
  await Promise.all([
    writeFile(path.join(directory, "workspace-result.json"), JSON.stringify(auditResult()), "utf8"),
    writeFile(path.join(directory, "workspace-runtime-metadata.json"), JSON.stringify({
      version: 1,
      mode: "audit",
      passes: [{ tier: "configured", model: "gpt-5.6-sol", effort: "high", durationMs: 25 }],
      postReviewEscalation: null,
      totalDurationMs: 25
    }), "utf8")
  ]);
  await runAgentFromBundle({
    mode: "audit",
    directory,
    config,
    resultPath: path.join(directory, "result.json"),
    apiKey: "provider-secret",
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });
  assert.match(calls.instructions, /first input text block contains trusted Codekeeper instructions/);
  assert.ok(calls.input[0].content[0].text.includes(profile));
  assert.ok(!calls.input[0].content[1].text.includes(profile));
});

test("preparation freezes the packaged default when the repository override is absent", async (context) => {
  const root = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const repositoryProfile = path.join(root, agentProfilePathForMode("audit"));
  await rm(repositoryProfile);
  run("git", ["add", "--update"], root);
  run("git", ["commit", "-qm", "use packaged audit profile"], root);
  const directory = bundle(root, "package-profile");
  const toolingSha = "b".repeat(40);
  await prepareAuditBundle({
    directory,
    config: templateConfig,
    toolingSha,
    agentProfileSource: "package",
    agentProfileSourceSha: toolingSha
  });

  const frozen = await readFile(path.join(directory, AGENT_PROFILE_BUNDLE_FILE));
  const canonical = await readFile(path.join(projectRoot, "tools/codekeeper/agents/repository-auditor.md"));
  const frozenContext = JSON.parse(await readFile(path.join(directory, "context.json"), "utf8"));
  assert.deepEqual(frozen, canonical);
  assert.deepEqual(frozenContext.agentProfile, {
    source: "package",
    path: "runtime/agents/repository-auditor.md",
    sha256: digest(canonical),
    sourceSha: toolingSha
  });
});

test("failed-job reruns produce the same frozen context across run attempts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-rerun-context-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await installAgentProfiles(root);
  const revision = run("git", ["rev-parse", "HEAD"], projectRoot).trim();
  const savedEnvironment = Object.fromEntries(["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"].map((name) => [name, process.env[name]]));
  process.env.GITHUB_REPOSITORY = "acme/example";
  process.env.GITHUB_RUN_ID = "123";
  try {
    process.env.GITHUB_RUN_ATTEMPT = "1";
    await prepareAuditBundle({
      directory: path.join(root, "attempt-1"),
      config: templateConfig,
      ...agentProfileOptions(root, "audit", revision)
    });
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await prepareAuditBundle({
      directory: path.join(root, "attempt-2"),
      config: templateConfig,
      ...agentProfileOptions(root, "audit", revision)
    });

    const attemptOneContext = await readFile(path.join(root, "attempt-1/context.json"));
    const attemptTwoContext = await readFile(path.join(root, "attempt-2/context.json"));
    const frozenContext = JSON.parse(attemptOneContext);
    assert.equal(digest(attemptOneContext), digest(attemptTwoContext));
    assert.equal(frozenContext.runId, "123");
    assert.equal(frozenContext.runUrl, "https://github.com/acme/example/actions/runs/123");
    assert.deepEqual(frozenContext, JSON.parse(attemptTwoContext));
  } finally {
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("workspace-disabled audit returns deterministic no-action without loading a provider", async (context) => {
  const root = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = bundle(root, "workspace-disabled-audit");
  const config = structuredClone(templateConfig);
  config.ai.agents.audit.workspace.enabled = false;
  config.ai.tracing.enabled = false;
  await prepareAuditBundle({
    directory,
    config,
    ...agentProfileOptions(root, "audit")
  });
  const resultPath = path.join(directory, "result.json");
  const metadata = await runAgentFromBundle({
    mode: "audit",
    directory,
    config,
    resultPath,
    apiKey: "",
    sdkLoader: async () => { throw new Error("provider must not load"); }
  });
  assert.equal(metadata.provider, "deterministic");
  assert.equal(metadata.usage.requests, 0);
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.findings.length, 0);
  assert.equal(result.repair.requested, false);
  assert.match(result.noActionReason, /did not inspect/);
});

test("workspace patch handoff applies captured regular-file bytes in a fresh checkout", async () => {
  const root = await createRepository();
  const directory = bundle(root, "workspace");
  const patch = path.join(directory, "workspace.patch");
  const coordinator = bundle(root, "coordinator");
  prepareAudit(root, directory);
  await writeFile(path.join(root, "README.md"), "# Example\n\nWorkspace evidence.\n", "utf8");
  run(
    "node",
    [cli, "capture-workspace-patch", "--config", ".github/codekeeper.json", "--directory", directory, "--patch", patch],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  run("git", ["clone", "-q", root, coordinator], root);
  run(
    "node",
    [cli, "apply-workspace-patch", "--config", ".github/codekeeper.json", "--patch", patch],
    coordinator,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  assert.equal(await readFile(path.join(coordinator, "README.md"), "utf8"), "# Example\n\nWorkspace evidence.\n");
});

test("workspace patch handoff accepts an empty specialist patch", async () => {
  const root = await createRepository();
  const directory = bundle(root, "empty-workspace");
  const patch = path.join(directory, "workspace.patch");
  const coordinator = bundle(root, "empty-coordinator");
  prepareAudit(root, directory);
  run(
    "node",
    [cli, "capture-workspace-patch", "--config", ".github/codekeeper.json", "--directory", directory, "--patch", patch],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  run("git", ["clone", "-q", root, coordinator], root);
  run(
    "node",
    [cli, "apply-workspace-patch", "--config", ".github/codekeeper.json", "--patch", patch],
    coordinator,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  assert.equal(await readFile(path.join(coordinator, "README.md"), "utf8"), "# Example\n");
  const link = path.join(directory, "workspace-link.patch");
  await symlink(patch, link);
  let error;
  try {
    run(
      "node",
      [cli, "apply-workspace-patch", "--config", ".github/codekeeper.json", "--patch", link],
      coordinator,
      { GITHUB_REPOSITORY: "acme/example" }
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.stderr.toString("utf8"), /Expected a regular file/);
});

test("workspace patch capture rejects a checkout whose frozen base commit moved", async () => {
  const root = await createRepository();
  const directory = bundle(root, "moved-workspace");
  prepareAudit(root, directory);
  await writeFile(path.join(root, "README.md"), "# Example\n\nMoved checkout.\n", "utf8");
  run("git", ["add", "README.md"], root);
  run("git", ["commit", "-qm", "move checkout"], root);
  let error;
  try {
    run(
      "node",
      [cli, "capture-workspace-patch", "--config", ".github/codekeeper.json", "--directory", directory, "--patch", path.join(directory, "workspace.patch")],
      root,
      { GITHUB_REPOSITORY: "acme/example" }
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.stderr.toString("utf8"), /Workspace checkout HEAD .* does not match frozen context\.baseSha/);
});

test("manual issue preparation requires an explicitly authorised actor", async () => {
  const root = await createRepository();
  const directory = bundle(root, "issue-input");
  const event = bundle(root, "issue-event.json");
  await writeFile(event, JSON.stringify({
    repository: { full_name: "acme/example" },
    issue: { number: 5, title: "Example", body: "Details", html_url: "https://github.com/acme/example/issues/5", user: { login: "reporter" } }
  }), "utf8");

  assert.throws(
    () => run("node", [cli, "prepare-issue", "--config", ".github/codekeeper.json", "--event", event, "--triage-mode", "manual", "--directory", directory, ...agentProfileCliArgs(root, "issue")], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );
  assert.throws(
    () => run("node", [cli, "prepare-issue", "--config", ".github/codekeeper.json", "--event", event, "--actor", "untrusted-user", "--triage-mode", "manual", "--directory", directory, ...agentProfileCliArgs(root, "issue")], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );

  const dispatchEvent = bundle(root, "issue-dispatch-event.json");
  const dispatchDirectory = bundle(root, "issue-dispatch-input");
  const expectedReceipt = issueDispatchReceipt({
    repository: "acme/example",
    number: 5,
    command: "triage",
    actor: "repository-owner",
    commentId: 70
  });
  await writeFile(dispatchEvent, JSON.stringify({
    action: "codekeeper_issue",
    repository: { full_name: "acme/example" },
    client_payload: {
      number: 5,
      requested_by: "repository-owner",
      command_name: "triage",
      command_request_id: expectedReceipt.requestId,
      command_comment_id: 70,
      command_receipt_comment_id: 71,
      command_receipt_sha256: expectedReceipt.sha256
    },
    sender: { login: "codekeeper[bot]", id: 123, type: "Bot" }
  }), "utf8");
  const originalFetch = globalThis.fetch;
  const originalBotLogin = process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
  process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = "codekeeper[bot]";
  globalThis.fetch = async (url) => new Response(JSON.stringify(
    String(url).endsWith("/graphql")
      ? closingPullRequestsResponse()
      : String(url).endsWith("/issues/comments/71")
        ? {
          id: 71,
          issue_url: "https://api.github.com/repos/acme/example/issues/5",
          body: expectedReceipt.content,
          created_at: "2026-08-17T10:00:00Z",
          updated_at: "2026-08-17T10:00:00Z",
          user: { login: "codekeeper[bot]", id: 123, type: "Bot" }
        }
      : String(url).includes("/issues/5")
        ? { number: 5, title: "Example", body: "Details", html_url: "https://github.com/acme/example/issues/5", user: { login: "reporter" } }
        : []
  ), { status: 200 });
  try {
    const prepared = await prepareIssue({
      eventPath: dispatchEvent,
      actor: "repository-owner",
      triageMode: "manual",
      directory: dispatchDirectory,
      config: templateConfig,
      token: "read-token",
      configSha256: digest(await readFile(path.join(root, ".github/codekeeper.json"))),
      ...agentProfileOptions(root, "issue")
    });
    assert.equal(prepared.issue.number, 5);
    assert.equal(prepared.triageMode, "manual");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBotLogin === undefined) delete process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN;
    else process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = originalBotLogin;
  }
});

test("maintenance repair authorization requires enabled policy but not a second owner approval", async (context) => {
  const root = await createRepository();
  context.after(() => rm(root, { recursive: true, force: true }));
  const revision = run("git", ["rev-parse", "HEAD"], root).trim();
  const disabled = structuredClone(templateConfig);

  await assert.rejects(
    prepareAuditBundle({
      directory: bundle(root, "disabled-repair"),
      config: disabled,
      actor: "repository-owner",
      repairAuthorized: true,
      ...agentProfileOptions(root, "audit", revision)
    }),
    /audit\.repair\.enabled=false/
  );

  const enabled = structuredClone(disabled);
  enabled.audit.repair.enabled = true;
  const prepared = await prepareAuditBundle({
    directory: bundle(root, "enabled-repair"),
    config: enabled,
    actor: "github-actions[bot]",
    repairAuthorized: true,
    ...agentProfileOptions(root, "audit", revision)
  });
  assert.equal(prepared.repairAuthorized, true);
  assert.equal(prepared.repairAuthorizedBy, "github-actions[bot]");
});

test("an explicit owner implementation request is sufficient when automatic issue implementation is off", async () => {
  const root = await createRepository();
  const issueDirectory = bundle(root, "case-insensitive-issue-input");
  const fixDirectory = bundle(root, "case-insensitive-fix-input");
  const event = bundle(root, "case-insensitive-issue-event.json");
  await writeFile(event, JSON.stringify({
    repository: { full_name: "acme/example" },
    issue: { number: 5, title: "Example", body: "Details", html_url: "https://github.com/acme/example/issues/5", user: { login: "reporter" } }
  }), "utf8");
  const config = structuredClone(templateConfig);
  config.repository.ownerLogins = ["Repository-Owner"];
  config.issues.allowAiImplementation = false;
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "acme/example";
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/graphql")) return new Response(JSON.stringify(closingPullRequestsResponse()), { status: 200 });
    if (String(url).includes("/comments")) return new Response(JSON.stringify([]), { status: 200 });
    if (String(url).includes("/issues/5")) {
      return new Response(JSON.stringify({
        number: 5,
        title: "Example",
        body: "Details",
        html_url: "https://github.com/acme/example/issues/5",
        user: { login: "reporter" },
        state: "open",
        labels: []
      }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  try {
    const issueContext = await prepareIssue({
      eventPath: event,
      actor: "REPOSITORY-OWNER",
      triageMode: "manual",
      directory: issueDirectory,
      config,
      token: "read-token",
      ...agentProfileOptions(root, "issue")
    });
    const fixContext = await prepareFix({
      targetNumber: 5,
      actor: "repository-owner",
      directory: fixDirectory,
      config,
      token: "read-token",
      ...agentProfileOptions(root, "fix")
    });
    assert.equal(issueContext.triageMode, "manual");
    assert.equal(fixContext.requestedBy, "repository-owner");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  }
});

test("automatic issue preparation freezes a GitHub-linked merged resolving pull request", async () => {
  const root = await createRepository();
  const directory = bundle(root, "automatic-issue-input");
  const event = bundle(root, "automatic-issue-event.json");
  await writeFile(event, JSON.stringify({
    repository: { full_name: "acme/example" },
    issue: { number: 5, title: "Example", body: "Details", html_url: "https://github.com/acme/example/issues/5", user: { login: "reporter" } }
  }), "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(
    String(url).endsWith("/graphql")
      ? closingPullRequestsResponse([{
        number: 12,
        url: "https://github.com/acme/example/pull/12",
        merged: true,
        mergedAt: "2026-08-13T10:00:00Z",
        repository: { nameWithOwner: "acme/example" }
      }])
      : []
  ), { status: 200 });
  try {
    const context = await prepareIssue({
      eventPath: event,
      actor: "reporter",
      triageMode: "automatic",
      directory,
      config: templateConfig,
      token: "read-token",
      configSha256: digest(await readFile(path.join(root, ".github/codekeeper.json"))),
      ...agentProfileOptions(root, "issue")
    });
    assert.equal(context.triageMode, "automatic");
    assert.equal(context.issue.number, 5);
    assert.deepEqual(context.resolvedByPullRequest, {
      number: 12,
      url: "https://github.com/acme/example/pull/12",
      mergedAt: "2026-08-13T10:00:00Z",
      repository: "acme/example"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("issue preparation reduces repository history to five deterministic duplicate candidates", async () => {
  const root = await createRepository();
  const directory = bundle(root, "duplicate-shortlist-input");
  const event = bundle(root, "duplicate-shortlist-event.json");
  await writeFile(event, JSON.stringify({
    repository: { full_name: "acme/example" },
    issue: {
      number: 50,
      title: "CSV export shifts timezone by one hour",
      body: "Exported calendar rows use UTC instead of Europe/London.",
      html_url: "https://github.com/acme/example/issues/50",
      user: { login: "reporter" }
    }
  }), "utf8");
  const issues = [
    { number: 50, title: "Current issue", body: "Must be excluded." },
    { number: 11, title: "CSV export shifts timezone", body: "Calendar export uses UTC instead of Europe/London." },
    { number: 12, title: "Timezone missing from export", body: "CSV calendar rows omit the selected timezone." },
    { number: 13, title: "Calendar export formatting", body: "CSV output has an unrelated delimiter defect." },
    { number: 14, title: "Settings typo", body: "Unrelated documentation issue." },
    { number: 15, title: "Window layout", body: "Unrelated display issue." },
    { number: 999, title: "OMITTED DISTRACTOR", body: "No overlapping terms and must not reach the model." }
  ];
  const pulls = [{ number: 21, title: "Export timezone correction", body: "Correct CSV timezone conversion." }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    JSON.stringify(String(url).endsWith("/graphql")
      ? closingPullRequestsResponse()
      : String(url).includes("/pulls?") ? pulls : issues),
    { status: 200 }
  );
  try {
    const context = await prepareIssue({
      eventPath: event,
      actor: "reporter",
      triageMode: "automatic",
      directory,
      config: templateConfig,
      token: "read-token",
      configSha256: digest(await readFile(path.join(root, ".github/codekeeper.json"))),
      ...agentProfileOptions(root, "issue")
    });
    assert.equal(context.duplicateCandidates.length, 5);
    assert.equal(context.duplicateCandidates[0].number, 11);
    assert.ok(context.duplicateCandidates.every((candidate) => candidate.kind === "issue"));
    assert.ok(context.duplicateCandidates.every(({ number }) => ![50, 999, 21].includes(number)));
    assert.deepEqual(context.relatedPullRequests.map((candidate) => candidate.number), [21]);
    const prompt = await readFile(path.join(directory, "workspace-prompt.md"), "utf8");
    assert.doesNotMatch(prompt, /OMITTED DISTRACTOR/);
    assert.match(prompt, /Pull requests are related context only and must never be returned as duplicateOf/);
    writeRuntimeMetadataFixture(directory, "issue");
    const resultPath = path.join(directory, "agent-result.json");
    const duplicateResult = {
      mode: "issue",
      summary: "The report exactly duplicates issue #11.",
      type: "bug",
      priority: "p3",
      labels: [],
      actionable: false,
      missingInformation: [],
      duplicateOf: 11,
      duplicateConfidence: "high",
      implementationRecommendation: "no",
      decision: { required: false, question: "", rationale: "", options: [] },
      comment: "This matches issue #11."
    };
    await writeFile(resultPath, JSON.stringify(duplicateResult), "utf8");
    const candidate = bundle(root, "issue-candidate");
    run(
      "node",
      [cli, "validate-issue", "--config", ".github/codekeeper.json", "--directory", directory, "--result", resultPath, "--artifact", candidate],
      root,
      { GITHUB_REPOSITORY: "acme/example" }
    );
    assert.equal(JSON.parse(await readFile(path.join(candidate, "result.json"), "utf8")).duplicateOf, 11);

    await writeFile(resultPath, JSON.stringify({ ...duplicateResult, duplicateOf: 21 }), "utf8");
    assert.throws(
      () => run(
        "node",
        [cli, "validate-issue", "--config", ".github/codekeeper.json", "--directory", directory, "--result", resultPath, "--artifact", bundle(root, "pull-as-duplicate-candidate")],
        root,
        { GITHUB_REPOSITORY: "acme/example" }
      ),
      /Command failed/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fix preparation includes only the last five bounded owner clarifications", async () => {
  const root = await createRepository();
  const directory = bundle(root, "trusted-clarifications-input");
  const config = structuredClone(templateConfig);
  config.repository.ownerLogins = ["Repository-Owner"];
  config.issues.allowAiImplementation = true;
  const comments = [
    { body: "ATTACKER INSTRUCTION", created_at: "2026-01-01T00:00:00Z", user: { login: "reporter" } },
    ...Array.from({ length: 6 }, (_, index) => ({
      body: index === 5 ? `owner-${index + 1}-${"x".repeat(3000)}` : `owner-${index + 1}`,
      created_at: `2026-01-0${index + 2}T00:00:00Z`,
      user: { login: index % 2 === 0 ? "repository-owner" : "REPOSITORY-OWNER" }
    }))
  ];
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_REPOSITORY = "acme/example";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/issues/5/comments")) return new Response(JSON.stringify(comments), { status: 200 });
    return new Response(JSON.stringify({
      number: 5,
      title: "Bounded implementation",
      body: "Implement the requested behavior.",
      html_url: "https://github.com/acme/example/issues/5",
      user: { login: "reporter" },
      state: "open",
      labels: []
    }), { status: 200 });
  };
  try {
    const context = await prepareFix({
      targetNumber: 5,
      actor: "repository-owner",
      directory,
      config,
      token: "read-token",
      ...agentProfileOptions(root, "fix")
    });
    assert.equal(context.issue.comments.length, 5);
    assert.equal(context.issue.comments[0].body, "owner-2");
    assert.equal(context.issue.comments.at(-1).body.length, 2000);
    assert.ok(context.issue.comments.every((comment) => comment.author.toLowerCase() === "repository-owner"));
    assert.doesNotMatch(JSON.stringify(context), /ATTACKER INSTRUCTION/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  }
});

test("enabled issue implementation requires codekeeper:ready and treats generic paused as fail-closed", async () => {
  const root = await createRepository();
  const directory = bundle(root, "automatic-fix-input");
  const config = structuredClone(templateConfig);
  config.issues.allowAiImplementation = true;
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const fillerLabels = Array.from({ length: 30 }, (_, index) => ({ name: `filler-${index}` }));
  let issueLabels = [...fillerLabels, { name: "ready" }];
  process.env.GITHUB_REPOSITORY = "acme/example";
  globalThis.fetch = async (url) => {
    if (String(url).includes("/comments")) return new Response(JSON.stringify([]), { status: 200 });
    if (String(url).includes("/issues/5")) {
      return new Response(JSON.stringify({
        number: 5,
        title: "Example",
        body: "Details",
        html_url: "https://github.com/acme/example/issues/5",
        user: { login: "reporter" },
        state: "open",
        labels: issueLabels
      }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  try {
    await assert.rejects(
      prepareFix({
        targetNumber: 5,
        actor: "codekeeper-app[bot]",
        authorizationMode: "policy",
        directory,
        config,
        token: "read-token",
        ...agentProfileOptions(root, "fix")
      }),
      /codekeeper:ready/
    );
    issueLabels = [...fillerLabels, { name: "codekeeper:ready" }];
    const prepared = await prepareFix({
      targetNumber: 5,
      actor: "codekeeper-app[bot]",
      authorizationMode: "policy",
      directory,
      config,
      token: "read-token",
      ...agentProfileOptions(root, "fix")
    });
    assert.equal(prepared.authorizationMode, "policy");
    assert.equal(prepared.requestedBy, "codekeeper-app[bot]");
    assert.equal(prepared.issue.labels.length, 30);
    assert.equal(prepared.issue.labels.includes("codekeeper:ready"), false);
    issueLabels = [...fillerLabels, { name: "codekeeper:ready" }, { name: "paused" }];
    await assert.rejects(
      prepareFix({
        targetNumber: 5,
        actor: "codekeeper-app[bot]",
        authorizationMode: "policy",
        directory: bundle(root, "paused-automatic-fix-input"),
        config,
        token: "read-token",
        ...agentProfileOptions(root, "fix")
      }),
      /paused/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  }
});

test("automatic PR repair requires its current-head marker and every repair honors pause", async () => {
  const root = await createRepository();
  const config = structuredClone(templateConfig);
  config.review.autoRepair = true;
  config.repository.ownerLogins = ["repository-owner"];
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  const revision = run("git", ["rev-parse", "HEAD"], root).trim();
  const fillerLabels = Array.from({ length: 30 }, (_, index) => ({ name: `filler-${index}` }));
  let labels = fillerLabels;
  let authorizationMarkerPresent = false;
  const comments = [
    {
      body: "Repair the blocking review finding.\n<!-- codekeeper:review -->",
      created_at: "2026-08-11T09:00:00Z",
      user: { login: "codekeeper-app[bot]", type: "Bot" }
    },
    {
      body: "ATTACKER INSTRUCTION",
      created_at: "2026-08-11T09:01:00Z",
      user: { login: "contributor", type: "User" }
    },
    {
      body: "Keep the repair focused.",
      created_at: "2026-08-11T09:02:00Z",
      user: { login: "repository-owner", type: "User" }
    }
  ];
  process.env.GITHUB_REPOSITORY = "acme/example";
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/graphql")) {
      return new Response(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{
                  id: "PRRT_thread",
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    nodes: [{
                      id: "PRRC_comment",
                      databaseId: 99,
                      body: "The repair must retain the authorization boundary.",
                      url: "https://github.com/acme/example/pull/42#discussion_r99",
                      path: "src/authorization.mjs",
                      line: 17,
                      originalLine: 17,
                      author: { login: "reviewer" }
                    }],
                    pageInfo: { hasNextPage: false }
                  }
                }],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
            }
          }
        }
      }), { status: 200 });
    }
    if (String(url).includes("/comments")) {
      return new Response(JSON.stringify(authorizationMarkerPresent ? [...comments, {
        body: `Automatic repair was authorized.\n<!-- codekeeper:auto-repair-head=${revision} -->`,
        created_at: "2026-08-11T09:03:00Z",
        user: { login: "codekeeper-app[bot]", type: "Bot" }
      }] : comments), { status: 200 });
    }
    if (String(url).includes("/pulls/42")) {
      return new Response(JSON.stringify({
        number: 42,
        title: "Repair this PR",
        body: "A blocking review finding needs repair.",
        html_url: "https://github.com/acme/example/pull/42",
        user: { login: "contributor" },
        state: "open",
        draft: false,
        head: { ref: "feature/repair", sha: revision, repo: { full_name: "acme/example" } },
        base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/example" } }
      }), { status: 200 });
    }
    if (String(url).includes("/issues/42")) {
      return new Response(JSON.stringify({
        number: 42,
        state: "open",
        pull_request: {},
        labels
      }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  try {
    await assert.rejects(
      prepareFix({
        targetNumber: 42,
        actor: "codekeeper-app[bot]",
        authorizationMode: "policy",
        directory: bundle(root, "unmarked-automatic-pr-plan"),
        config,
        token: "read-token",
        expectedHead: revision,
        ...agentProfileOptions(root, "fix")
      }),
      /authorization marker/
    );
    authorizationMarkerPresent = true;
    const prepared = await prepareFix({
      targetNumber: 42,
      actor: "codekeeper-app[bot]",
      authorizationMode: "policy",
      directory: bundle(root, "marked-automatic-pr-plan"),
      config,
      token: "read-token",
      expectedHead: revision,
      reviewThreadIds: ["PRRT_thread"],
      ...agentProfileOptions(root, "fix")
    });
    assert.equal(prepared.target.kind, "pull_request");
    assert.equal(prepared.target.subjectSha256, digest(JSON.stringify(prepared.pullRequest)));
    assert.deepEqual(
      prepared.pullRequest.comments.map((comment) => comment.author),
      ["codekeeper-app[bot]", "repository-owner"]
    );
    assert.match(prepared.pullRequest.comments[0].body, /blocking review finding/);
    assert.doesNotMatch(JSON.stringify(prepared.pullRequest.comments), /ATTACKER INSTRUCTION/);
    assert.equal(labels.some((label) => label.name === "codekeeper:auto-repaired"), false);
    assert.deepEqual(prepared.pullRequest.reviewThreads, [{
      id: "PRRT_thread",
      isResolved: false,
      isOutdated: false,
      comments: [{
        id: "PRRC_comment",
        databaseId: 99,
        author: "reviewer",
        body: "The repair must retain the authorization boundary.",
        bodySha256: digest("The repair must retain the authorization boundary."),
        url: "https://github.com/acme/example/pull/42#discussion_r99",
        path: "src/authorization.mjs",
        line: 17,
        originalLine: 17
      }]
    }]);
    labels = [...fillerLabels, { name: "paused" }];
    await assert.rejects(
      prepareFix({
        targetNumber: 42,
        actor: "repository-owner",
        authorizationMode: "owner",
        directory: bundle(root, "paused-owner-pr-plan"),
        config,
        token: "read-token",
        expectedHead: revision,
        ...agentProfileOptions(root, "fix")
      }),
      /paused/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  }
});

test("prepare writes provider-compatible workspace output schemas for every mode", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-workspace-schema-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await installAgentProfiles(root);
  const config = structuredClone(templateConfig);
  config.issues.allowAiImplementation = true;
  config.repository.ownerLogins = ["workspace-owner"];
  const revision = run("git", ["rev-parse", "HEAD"], projectRoot).trim();
  const reviewEvent = path.join(root, "review-event.json");
  const issueEvent = path.join(root, "issue-event.json");
  await writeFile(reviewEvent, JSON.stringify({
    repository: { full_name: "acme/example" },
    pull_request: {
      number: 7,
      title: "Schema fixture review",
      body: "",
      draft: false,
      html_url: "https://github.com/acme/example/pull/7",
      user: { login: "contributor" },
      base: { ref: "main", sha: revision },
      head: { ref: "main", sha: revision, repo: { full_name: "acme/example" } }
    }
  }), "utf8");
  await writeFile(issueEvent, JSON.stringify({
    repository: { full_name: "acme/example" },
    issue: { number: 5, title: "Schema fixture issue", body: "Details", html_url: "https://github.com/acme/example/issues/5", user: { login: "reporter" } }
  }), "utf8");

  const originalFetch = globalThis.fetch;
  const savedEnvironment = Object.fromEntries(["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"].map((name) => [name, process.env[name]]));
  process.env.GITHUB_REPOSITORY = "acme/example";
  process.env.GITHUB_RUN_ID = "123";
  process.env.GITHUB_RUN_ATTEMPT = "2";
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/graphql")) return new Response(JSON.stringify(closingPullRequestsResponse()), { status: 200 });
    if (String(url).includes("/issues/5/comments")) return new Response(JSON.stringify([]), { status: 200 });
    if (String(url).includes("/issues/5")) {
      return new Response(JSON.stringify({
        number: 5,
        title: "Schema fixture issue",
        body: "Details",
        html_url: "https://github.com/acme/example/issues/5",
        user: { login: "reporter" },
        state: "open",
        labels: []
      }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const directories = Object.fromEntries(["review", "audit", "issue", "fix"].map((mode) => [mode, path.join(root, mode)]));
  try {
    await prepareReview({ eventPath: reviewEvent, directory: directories.review, config, ...agentProfileOptions(root, "review", revision) });
    await prepareAuditBundle({ directory: directories.audit, config, ...agentProfileOptions(root, "audit", revision) });
    await prepareIssue({ eventPath: issueEvent, actor: "reporter", triageMode: "automatic", directory: directories.issue, config, token: "read-token", ...agentProfileOptions(root, "issue", revision) });
    await prepareFix({ targetNumber: 5, actor: "workspace-owner", directory: directories.fix, config, token: "read-token", ...agentProfileOptions(root, "fix", revision) });
    for (const mode of Object.keys(directories)) {
      assertWorkspaceOutputSchema(JSON.parse(await readFile(path.join(directories[mode], "schema.json"), "utf8")), mode);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("audit candidate validation preserves caller changes and clears repository credentials for commands", async () => {
  const root = await createRepository();
  const directory = bundle(root, "input");
  const candidate = bundle(root, "candidate");
  const verifier = bundle(root, "verifier");
  const configPath = path.join(root, ".github/codekeeper.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.audit.repair.enabled = true;
  config.audit.repair.validationCommands = ["test -z \"$GITHUB_TOKEN\" && test -z \"$OPENAI_API_KEY\" && test -z \"$ACTIONS_RUNTIME_TOKEN\""];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  run("git", ["add", ".github/codekeeper.json"], root);
  run("git", ["commit", "-qm", "configure validation"], root);

  prepareAudit(root, directory, {}, true);
  await writeFile(path.join(root, "README.md"), "# Example\n\nUpdated guidance.\n", "utf8");
  await writeFile(path.join(directory, "codex-result.json"), JSON.stringify(auditResult({ repair: true })), "utf8");
  run(
    "node",
    [cli, "validate-audit", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", candidate],
    root,
    { GITHUB_REPOSITORY: "acme/example", GITHUB_TOKEN: "write-token", OPENAI_API_KEY: "model-secret", ACTIONS_RUNTIME_TOKEN: "runner-token" }
  );

  const candidateMetadata = JSON.parse(await readFile(path.join(candidate, "candidate.json"), "utf8"));
  assert.equal(candidateMetadata.version, 2);
  assert.equal(candidateMetadata.patch.valid, true);
  assert.equal(candidateMetadata.runtimeMetadataSha256, digest(await readFile(path.join(candidate, "runtime-metadata.json"))));
  assert.match(await readFile(path.join(root, "README.md"), "utf8"), /Updated guidance/);
  assert.match(await readFile(path.join(candidate, "patch.diff"), "utf8"), /Updated guidance/);

  run("git", ["clone", "-q", root, verifier], root);
  run(
    "node",
    [cli, "verify-audit", "--config", ".github/codekeeper.json", "--candidate", candidate, "--expected-candidate-sha", digest(await readFile(path.join(candidate, "candidate.json")))],
    verifier,
    { GITHUB_REPOSITORY: "acme/example", GITHUB_TOKEN: "write-token", OPENAI_API_KEY: "model-secret", ACTIONS_RUNTIME_TOKEN: "runner-token" }
  );
  assert.match(await readFile(path.join(verifier, "README.md"), "utf8"), /Updated guidance/);
});

test("seal rejects a candidate altered after secretless validation", async () => {
  const root = await createRepository();
  const directory = bundle(root, "input");
  const candidate = bundle(root, "candidate");
  const sealed = bundle(root, "sealed");
  prepareAudit(root, directory);
  const context = await readFile(path.join(directory, "context.json"));
  await writeFile(path.join(directory, "codex-result.json"), JSON.stringify(auditResult()), "utf8");
  run(
    "node",
    [cli, "validate-audit", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", candidate],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  const candidateDigest = digest(await readFile(path.join(candidate, "candidate.json")));
  await writeFile(path.join(candidate, "result.json"), JSON.stringify({ ...auditResult(), summary: "Forged after validation." }), "utf8");

  assert.throws(
    () => run(
      "node",
      [cli, "seal-audit", "--config", ".github/codekeeper.json", "--candidate", candidate, "--artifact", sealed, "--expected-candidate-sha", candidateDigest, "--expected-context-sha", digest(context)],
      root,
      { GITHUB_REPOSITORY: "acme/example" }
    ),
    /Command failed/
  );
});

test("seal produces the only manifest and embeds the frozen policy", async () => {
  const root = await createRepository();
  const directory = bundle(root, "input");
  const candidate = bundle(root, "candidate");
  const sealed = bundle(root, "sealed");
  const configPath = path.join(root, ".github/codekeeper.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.audit.repair.validationCommands = ["false"];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  run("git", ["add", ".github/codekeeper.json"], root);
  run("git", ["commit", "-qm", "configure no-repair validation"], root);
  prepareAudit(root, directory);
  const context = await readFile(path.join(directory, "context.json"));
  await writeFile(path.join(directory, "codex-result.json"), JSON.stringify(auditResult()), "utf8");
  run(
    "node",
    [cli, "validate-audit", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", candidate],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  await assert.rejects(lstat(path.join(candidate, "manifest.json")), { code: "ENOENT" });
  const candidateDigest = digest(await readFile(path.join(candidate, "candidate.json")));
  run(
    "node",
    [cli, "verify-audit", "--config", ".github/codekeeper.json", "--candidate", candidate, "--expected-candidate-sha", candidateDigest],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  run(
    "node",
    [cli, "seal-audit", "--config", ".github/codekeeper.json", "--candidate", candidate, "--artifact", sealed, "--expected-candidate-sha", candidateDigest, "--expected-context-sha", digest(context)],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  const manifest = JSON.parse(await readFile(path.join(sealed, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 3);
  assert.equal(manifest.sealed, true);
  assert.equal("runAttempt" in manifest.context, false);
  assert.ok(manifest.context.configSha256);
  assert.equal(manifest.contextSha256, digest(await readFile(path.join(sealed, "context.json"))));
  assert.equal(manifest.resultSha256, digest(await readFile(path.join(sealed, "result.json"))));
  assert.equal(manifest.configFileSha256, digest(await readFile(path.join(sealed, "config.json"))));
  assert.equal(manifest.validationSha256, digest(await readFile(path.join(sealed, "validation.json"))));
  assert.equal(manifest.runtimeMetadataSha256, digest(await readFile(path.join(sealed, "runtime-metadata.json"))));
  assert.equal(manifest.patchSha256, null);
});

test("review findings outside a changed hunk fall back to file-level evidence", async () => {
  const root = await createRepository();
  await writeFile(path.join(root, "README.md"), "one\ntwo\nthree\n", "utf8");
  run("git", ["add", "README.md"], root);
  run("git", ["commit", "-qm", "base document"], root);
  const base = run("git", ["rev-parse", "HEAD"], root).trim();
  await writeFile(path.join(root, "README.md"), "one\nchanged\nthree\n", "utf8");
  await writeFile(path.join(root, "NOTES.md"), "unrelated changed file\n", "utf8");
  run("git", ["add", "README.md", "NOTES.md"], root);
  run("git", ["commit", "-qm", "change document"], root);
  const head = run("git", ["rev-parse", "HEAD"], root).trim();
  assert.deepEqual([...changedLineHunksBetween(base, head, ["README.md"], root).keys()], ["README.md"]);
  const event = bundle(root, "review-event.json");
  const directory = bundle(root, "review-input");
  await writeFile(event, JSON.stringify({
    repository: { full_name: "acme/example" },
    pull_request: {
      number: 7,
      title: "Change document",
      body: "",
      draft: false,
      html_url: "https://github.com/acme/example/pull/7",
      user: { login: "contributor" },
      base: { ref: "main", sha: base, repo: { full_name: "acme/example" } },
      head: { ref: "docs", sha: head, repo: { full_name: "acme/example" } }
    }
  }), "utf8");
  run(
    "node",
    [cli, "prepare-review", "--config", ".github/codekeeper.json", "--event", event, "--directory", directory, ...agentProfileCliArgs(root, "review")],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  writeRuntimeMetadataFixture(directory, "review");
  const review = {
    mode: "review",
    summary: "A changed line needs attention.",
    risk: "medium",
    labels: [],
    blockingFindings: [],
    nonBlockingFindings: [{
      title: "Changed text",
      explanation: "The changed line needs a stronger explanation.",
      severity: "medium",
      confidence: "high",
      classification: "current",
      validation: "The current documentation still contains the unclear changed line.",
      preventionTest: "Check the rendered documentation wording.",
      rootCauseTags: ["documentation-clarity"],
      reproductionTest: null,
      file: "README.md",
      line: 2
    }],
    tests: { adequate: true, notes: "Documentation change.", missingTest: null },
    mergeRecommendation: "manual",
    noActionReason: null
  };
  await writeFile(path.join(directory, "codex-result.json"), JSON.stringify(review), "utf8");
  run(
    "node",
    [cli, "validate-review", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", bundle(root, "review-candidate")],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );

  await writeFile(path.join(directory, "codex-result.json"), JSON.stringify({
    ...review,
    nonBlockingFindings: [{ ...review.nonBlockingFindings[0], line: 1 }]
  }), "utf8");
  const fallbackArtifact = bundle(root, "file-level-review-candidate");
  run(
    "node",
    [cli, "validate-review", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", fallbackArtifact],
    root,
    { GITHUB_REPOSITORY: "acme/example" }
  );
  assert.equal(JSON.parse(await readFile(path.join(fallbackArtifact, "result.json"), "utf8")).nonBlockingFindings[0].line, null);

  await writeFile(path.join(directory, "codex-result.json"), JSON.stringify({
    ...review,
    nonBlockingFindings: [{ ...review.nonBlockingFindings[0], file: "outside.md", line: null }]
  }), "utf8");
  assert.throws(
    () => run(
      "node",
      [cli, "validate-review", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", bundle(root, "outside-diff-review-candidate")],
      root,
      { GITHUB_REPOSITORY: "acme/example" }
    ),
    /Command failed/
  );
});
