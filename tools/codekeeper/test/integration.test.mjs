import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentProfilePathForMode } from "../src/lib/agent-profiles.mjs";
import { runAgentFromBundle } from "../src/lib/agents-runtime.mjs";
import { boundedChangedFilesBetween, boundedDiffBetween, changedLineHunksBetween, collectWorkingTreeChanges } from "../src/lib/git.mjs";
import { prepareAudit as prepareAuditBundle, prepareFix, prepareIssue, prepareReview } from "../src/lib/prepare.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, "../../..");
const cli = path.join(projectRoot, "tools/codekeeper/src/cli.mjs");
const configSource = path.join(projectRoot, ".github/codekeeper.json");
const templateConfig = JSON.parse(await readFile(configSource, "utf8"));
const documentationLabel = templateConfig.review.allowedLabels.find((label) => label.includes("documentation"));

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
        labels: [documentationLabel]
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
}

test("prepare requires an external runner-owned directory and cannot follow checkout symlinks", async () => {
  const root = await createRepository();
  const victim = `${root}-victim`;
  const checkoutDirectory = path.join(root, ".codekeeper");
  await writeFile(victim, "safe\n", "utf8");
  await symlink(victim, checkoutDirectory);

  assert.throws(
    () => run("node", [cli, "prepare-audit", "--config", ".github/codekeeper.json", "--directory", checkoutDirectory], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );
  assert.equal(await readFile(victim, "utf8"), "safe\n");
  assert.equal((await lstat(checkoutDirectory)).isSymbolicLink(), true);

  const externalDirectory = bundle(root, "trusted-input");
  prepareAudit(root, externalDirectory);
  assert.equal((await lstat(path.join(externalDirectory, "context.json"))).isFile(), true);
  assert.equal(await readFile(victim, "utf8"), "safe\n");
});

test("preparation freezes one trusted profile whose exact bytes reach workspace and coordinator prompts", async (context) => {
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
  const workspacePrompt = await readFile(path.join(directory, "prompt.md"), "utf8");
  assert.deepEqual(frozenBytes, Buffer.from(profile));
  assert.deepEqual(frozenContext.agentProfile, {
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
  await runAgentFromBundle({
    mode: "audit",
    directory,
    config,
    resultPath: path.join(directory, "result.json"),
    apiKey: "provider-secret",
    sdkLoader: async () => ({ Agent: FakeAgent, Runner: FakeRunner, OpenAIProvider: FakeProvider })
  });
  assert.ok(calls.instructions.includes(profile));
  assert.ok(calls.input.includes(profile));
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

test("manual issue and fix preparation authorize owner login casing variants", async () => {
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
  config.issues.allowAiImplementation = true;
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
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

test("automatic issue preparation records trusted mode without an owner command", async () => {
  const root = await createRepository();
  const directory = bundle(root, "automatic-issue-input");
  const event = bundle(root, "automatic-issue-event.json");
  await writeFile(event, JSON.stringify({
    repository: { full_name: "acme/example" },
    issue: { number: 5, title: "Example", body: "Details", html_url: "https://github.com/acme/example/issues/5", user: { login: "reporter" } }
  }), "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([]), { status: 200 });
  try {
    const context = await prepareIssue({
      eventPath: event,
      actor: "reporter",
      triageMode: "automatic",
      directory,
      config: templateConfig,
      token: "read-token",
      ...agentProfileOptions(root, "issue")
    });
    assert.equal(context.triageMode, "automatic");
    assert.equal(context.issue.number, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enabled issue implementation accepts a trusted ready-label run without an owner command", async () => {
  const root = await createRepository();
  const directory = bundle(root, "automatic-fix-input");
  const config = structuredClone(templateConfig);
  config.issues.allowAiImplementation = true;
  const originalFetch = globalThis.fetch;
  const originalRepository = process.env.GITHUB_REPOSITORY;
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
        labels: [{ name: "codekeeper:ready" }]
      }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  try {
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
  assert.equal(candidateMetadata.patch.valid, true);
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
  assert.equal(manifest.version, 2);
  assert.equal(manifest.sealed, true);
  assert.equal(manifest.context.runAttempt, "2");
  assert.ok(manifest.context.configSha256);
  assert.equal(manifest.contextSha256, digest(await readFile(path.join(sealed, "context.json"))));
  assert.equal(manifest.resultSha256, digest(await readFile(path.join(sealed, "result.json"))));
  assert.equal(manifest.configFileSha256, digest(await readFile(path.join(sealed, "config.json"))));
  assert.equal(manifest.validationSha256, digest(await readFile(path.join(sealed, "validation.json"))));
  assert.equal(manifest.patchSha256, null);
});

test("review findings must cite a changed line hunk", async () => {
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
      file: "README.md",
      line: 2
    }],
    tests: { adequate: true, notes: "Documentation change." },
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
  assert.throws(
    () => run(
      "node",
      [cli, "validate-review", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", bundle(root, "invalid-review-candidate")],
      root,
      { GITHUB_REPOSITORY: "acme/example" }
    ),
    /Command failed/
  );
});
