import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundedChangedFilesBetween, boundedDiffBetween, changedLineHunksBetween, collectWorkingTreeChanges, runValidationCommands, validationEnvironment } from "../src/lib/git.mjs";
import { prepareIssue } from "../src/lib/prepare.mjs";

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

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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

function prepareAudit(root, directory, env = {}) {
  run(
    "node",
    [cli, "prepare-audit", "--config", ".github/codekeeper.json", "--directory", directory],
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
    () => run("node", [cli, "prepare-issue", "--config", ".github/codekeeper.json", "--event", event, "--triage-mode", "manual", "--directory", directory], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );
  assert.throws(
    () => run("node", [cli, "prepare-issue", "--config", ".github/codekeeper.json", "--event", event, "--actor", "untrusted-user", "--triage-mode", "manual", "--directory", directory], root, { GITHUB_REPOSITORY: "acme/example" }),
    /Command failed/
  );
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
      token: "read-token"
    });
    assert.equal(context.triageMode, "automatic");
    assert.equal(context.issue.number, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("audit candidate validation preserves caller changes and exposes only safe environment variables to commands", async () => {
  const root = await createRepository();
  const directory = bundle(root, "input");
  const candidate = bundle(root, "candidate");
  const verifier = bundle(root, "verifier");
  const configPath = path.join(root, ".github/codekeeper.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.audit.repair.enabled = true;
  config.audit.repair.validationCommands = [
    "test -n \"$PATH\" && test -z \"$GITHUB_TOKEN\" && test -z \"$OPENAI_API_KEY\" && test -z \"$ACTIONS_RUNTIME_TOKEN\" && test -z \"$CUSTOM_PROVIDER_KEY\" && test -z \"$NPM_TOKEN\""
  ];
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  run("git", ["add", ".github/codekeeper.json"], root);
  run("git", ["commit", "-qm", "configure validation"], root);

  prepareAudit(root, directory);
  await writeFile(path.join(root, "README.md"), "# Example\n\nUpdated guidance.\n", "utf8");
  await writeFile(path.join(directory, "codex-result.json"), JSON.stringify(auditResult({ repair: true })), "utf8");
  run(
    "node",
    [cli, "validate-audit", "--config", ".github/codekeeper.json", "--directory", directory, "--result", path.join(directory, "codex-result.json"), "--artifact", candidate],
    root,
    {
      GITHUB_REPOSITORY: "acme/example",
      GITHUB_TOKEN: "write-token",
      OPENAI_API_KEY: "model-secret",
      ACTIONS_RUNTIME_TOKEN: "runner-token",
      CUSTOM_PROVIDER_KEY: "provider-secret",
      NPM_TOKEN: "registry-secret"
    }
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
    {
      GITHUB_REPOSITORY: "acme/example",
      GITHUB_TOKEN: "write-token",
      OPENAI_API_KEY: "model-secret",
      ACTIONS_RUNTIME_TOKEN: "runner-token",
      CUSTOM_PROVIDER_KEY: "provider-secret",
      NPM_TOKEN: "registry-secret"
    }
  );
  assert.match(await readFile(path.join(verifier, "README.md"), "utf8"), /Updated guidance/);
});

test("validation commands receive a usable disposable home directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-validation-home-test-"));
  const successfulHomeRecord = path.join(root, "successful-home");
  const failedHomeRecord = path.join(root, "failed-home");
  const inheritedHome = process.env.HOME;
  const usableHome = [
    'test -n "$HOME"',
    'test -d "$HOME"',
    inheritedHome === undefined ? "true" : `test "$HOME" != ${shellLiteral(inheritedHome)}`,
    "git config --global user.name codekeeper-verifier",
    'test "$(git config --global user.name)" = codekeeper-verifier'
  ].join(" && ");
  try {
    const successful = await runValidationCommands([
      `${usableHome} && printf '%s' "$HOME" > ${shellLiteral(successfulHomeRecord)}`
    ], root);
    assert.equal(successful[0].success, true);
    const successfulHome = (await readFile(successfulHomeRecord, "utf8")).trim();
    assert.notEqual(successfulHome, inheritedHome);
    await assert.rejects(lstat(successfulHome), { code: "ENOENT" });

    await assert.rejects(
      runValidationCommands([
        `${usableHome} && printf '%s' "$HOME" > ${shellLiteral(failedHomeRecord)} && false`
      ], root),
      /Validation command failed/
    );
    const failedHome = (await readFile(failedHomeRecord, "utf8")).trim();
    assert.notEqual(failedHome, inheritedHome);
    await assert.rejects(lstat(failedHome), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation environment retains Rust toolchain discovery without inheriting home or secrets", () => {
  const explicit = validationEnvironment({
    PATH: "/toolchains/cargo/bin:/usr/bin",
    HOME: "/Users/cory",
    RUSTUP_HOME: "/toolchains/rustup",
    OPENAI_API_KEY: "must-not-pass"
  });
  assert.deepEqual(explicit, {
    PATH: "/toolchains/cargo/bin:/usr/bin",
    RUSTUP_HOME: "/toolchains/rustup"
  });

  const standard = validationEnvironment({ PATH: "/Users/cory/.cargo/bin:/usr/bin", HOME: "/Users/cory" });
  assert.equal(standard.RUSTUP_HOME, path.join("/Users/cory", ".rustup"));
  assert.equal(standard.HOME, undefined);
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
    [cli, "prepare-review", "--config", ".github/codekeeper.json", "--event", event, "--directory", directory],
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
