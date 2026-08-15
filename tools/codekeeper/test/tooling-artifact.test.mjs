import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toolingManifestText } from "../scripts/generate-tooling-manifest.mjs";
import { verifyToolingArtifact } from "../scripts/verify-tooling-artifact.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDirectory, "..");
const manifestPath = path.join(packageRoot, "tooling-manifest.json");
const execFileAsync = promisify(execFile);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function copyProductionTooling(target) {
  await mkdir(path.join(target, "scripts"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "tooling-manifest.json"]) {
    await copyFile(path.join(packageRoot, file), path.join(target, file));
  }
  await copyFile(
    path.join(packageRoot, "scripts", "verify-tooling-artifact.mjs"),
    path.join(target, "scripts", "verify-tooling-artifact.mjs")
  );
  for (const directory of ["agents", "integrations/braintrust", "presets", "src"]) {
    await cp(path.join(packageRoot, directory), path.join(target, directory), { recursive: true, force: false, errorOnExist: true });
  }
  return target;
}

async function stageProductionTooling(root) {
  return copyProductionTooling(path.join(root, "tooling", "tools", "codekeeper"));
}

async function stagedFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-tooling-artifact-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return stageProductionTooling(root);
}

async function actionStepScript(name) {
  const action = await readFile(path.join(packageRoot, "action.yml"), "utf8");
  const stepStart = action.indexOf(`    - name: ${name}\n`);
  assert.notEqual(stepStart, -1, `missing composite action step: ${name}`);
  const runStart = action.indexOf("      run: |\n", stepStart);
  const nextStep = action.indexOf("\n    - name:", runStart);
  assert.notEqual(runStart, -1, `missing composite action script: ${name}`);
  assert.notEqual(nextStep, -1, `missing step after composite action script: ${name}`);
  const indentedScript = action.slice(runStart + "      run: |\n".length, nextStep);
  return indentedScript
    .split("\n")
    .map((line) => line.length === 0 ? line : line.replace(/^ {8}/, ""))
    .join("\n");
}

async function actionPathFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-composite-action-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const actionPath = await copyProductionTooling(path.join(root, "action-path"));
  await copyFile(path.join(packageRoot, "action.yml"), path.join(actionPath, "action.yml"));
  return { actionPath, stagingRoot: path.join(root, "staging") };
}

async function runCompositeStaging({ actionPath, stagingRoot }) {
  return execFileAsync("bash", ["-c", await actionStepScript("Stage pinned production tooling")], {
    env: { ACTION_PATH: actionPath, PATH: process.env.PATH ?? "/usr/bin:/bin", STAGING_ROOT: stagingRoot },
    maxBuffer: 32 * 1024
  });
}

async function runActionStep(name, env) {
  return execFileAsync("bash", ["-c", await actionStepScript(name)], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    maxBuffer: 32 * 1024
  });
}

function actionOutputs(text) {
  return Object.fromEntries(text.trim().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function expectedManifestSha256() {
  return sha256(await readFile(manifestPath));
}

async function githubDefaultArtifactPaths(root, relativeDirectory = "") {
  const paths = [];
  for (const entry of await readdir(path.join(root, relativeDirectory), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await githubDefaultArtifactPaths(root, relativePath));
    else if (entry.isFile()) paths.push(relativePath);
  }
  return paths.sort();
}

test("canonical tooling manifest exactly covers the production runtime payload", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(await toolingManifestText(), await readFile(manifestPath, "utf8"));
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes("src/cli.mjs"));
  assert.ok(paths.includes("src/lib/agents-runtime.mjs"));
  assert.ok(paths.includes("agents/pr-reviewer.md"));
  assert.ok(paths.includes("presets/catalogue.mjs"));
  assert.ok(paths.includes("integrations/braintrust/run-agent.mjs"));
  assert.ok(paths.includes("integrations/braintrust/package-lock.json"));
  assert.ok(paths.includes("package-lock.json"));
  assert.ok(paths.includes("scripts/verify-tooling-artifact.mjs"));
  assert.ok(paths.every((entry) => !entry.startsWith("test/") && !entry.startsWith("evals/")));
});

test("verifier accepts the exact bootstrapped production tooling package", async (context) => {
  const target = await stagedFixture(context);
  await verifyToolingArtifact({ root: target, expectedManifestSha256: await expectedManifestSha256() });
});

test("composite staging script accepts a clean action path and rejects hidden or symlink payloads", async (context) => {
  const clean = await actionPathFixture(context);
  const result = await runCompositeStaging(clean);
  assert.equal(result.stdout, "");
  const target = path.join(clean.stagingRoot, "tooling", "tools", "codekeeper");
  assert.deepEqual(
    (await readdir(target)).sort(),
    ["agents", "integrations", "package-lock.json", "package.json", "presets", "scripts", "src", "tooling-manifest.json"]
  );
  await verifyToolingArtifact({ root: target, expectedManifestSha256: await expectedManifestSha256() });

  const hidden = await actionPathFixture(context);
  await writeFile(path.join(hidden.actionPath, "src", ".artifact-hidden.mjs"), "export {};\n", "utf8");
  await assert.rejects(
    () => runCompositeStaging(hidden),
    (error) => error.code === 1 && /refused a hidden tooling path/.test(error.stderr)
  );

  const linked = await actionPathFixture(context);
  await symlink("../package.json", path.join(linked.actionPath, "src", "package-link.json"));
  await assert.rejects(
    () => runCompositeStaging(linked),
    (error) => error.code === 1 && /refused a tooling symlink/.test(error.stderr)
  );
});

test("composite transport derives an exact cache while retaining a run artifact", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-composite-transport-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  await mkdir(workspace);
  await mkdir(runnerTemp);

  const select = async ({ artifactName = "", eventName = "pull_request_target" }) => {
    const output = path.join(root, `output-${randomUUID()}`);
    await writeFile(output, "", "utf8");
    await runActionStep("Select bootstrap transport", {
      ACTION_PATH: packageRoot,
      ARTIFACT_NAME: artifactName,
      EVENT_NAME: eventName,
      GITHUB_OUTPUT: output,
      GITHUB_WORKSPACE_ROOT: workspace,
      RUNNER_OS_NAME: "Linux",
      RUNNER_TEMP_ROOT: runnerTemp
    });
    return actionOutputs(await readFile(output, "utf8"));
  };

  const manifestSha256 = await expectedManifestSha256();
  const lowTrustCache = await select({ artifactName: "codekeeper-tooling-1" });
  assert.equal(lowTrustCache.mode, "cache");
  assert.equal(lowTrustCache["cache-write"], "false");
  assert.equal(lowTrustCache["cache-key"], `codekeeper-tooling-Linux-${manifestSha256}`);
  assert.equal(lowTrustCache["manifest-sha256"], manifestSha256);
  assert.equal(lowTrustCache.destination, path.join(workspace, "tooling"));
  assert.equal(lowTrustCache["artifact-root"], path.join(runnerTemp, "codekeeper-tooling"));

  const trustedCache = await select({
    artifactName: "codekeeper-tooling-2",
    eventName: "workflow_dispatch"
  });
  assert.equal(trustedCache["cache-write"], "true");

  await assert.rejects(
    () => select({}),
    /requires an artifact fallback/
  );
});

test("composite cache verification binds the exact key and manifest before reuse", async (context) => {
  const fixture = await actionPathFixture(context);
  const toolingRoot = await stageProductionTooling(fixture.stagingRoot);
  const manifestSha256 = await expectedManifestSha256();
  const verify = (overrides = {}) => runActionStep("Verify pinned production tooling", {
    ACTION_PATH: fixture.actionPath,
    EXPECTED_CACHE_KEY: `codekeeper-tooling-Linux-${manifestSha256}`,
    EXPECTED_MANIFEST_SHA256: manifestSha256,
    RUNNER_OS_NAME: "Linux",
    TOOLING_ROOT: toolingRoot,
    TRANSPORT_MODE: "cache",
    ...overrides
  });

  await verify();
  await assert.rejects(
    () => verify({ EXPECTED_CACHE_KEY: `unbound-${manifestSha256}` }),
    /cache key is not bound to this pinned manifest/
  );
  await assert.rejects(
    () => verify({ EXPECTED_MANIFEST_SHA256: "0".repeat(64) }),
    /cache manifest is not bound to this pinned action/
  );
});

test("every bootstrap creates the same artifact layout used when cache restore fails", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-cache-fallback-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const artifactRoot = path.join(root, "artifact");
  await stageProductionTooling(workspace);

  await runActionStep("Prepare pinned production tooling artifact fallback", {
    ARTIFACT_ROOT: artifactRoot,
    GITHUB_WORKSPACE: workspace
  });
  await verifyToolingArtifact({
    root: path.join(artifactRoot, "tooling", "tools", "codekeeper"),
    expectedManifestSha256: await expectedManifestSha256()
  });
});

test("verifier rejects a substituted manifest before it can trust the artifact helper", async (context) => {
  const target = await stagedFixture(context);
  await writeFile(path.join(target, "tooling-manifest.json"), '{"version":1,"files":[]}\n', "utf8");
  await assert.rejects(
    async () => verifyToolingArtifact({ root: target, expectedManifestSha256: await expectedManifestSha256() }),
    /manifest digest does not match the pinned workflow/
  );
});

test("verifier rejects a modified production file and an extra file", async (context) => {
  const target = await stagedFixture(context);
  await writeFile(path.join(target, "src", "cli.mjs"), "export const substituted = true;\n", "utf8");
  await assert.rejects(
    async () => verifyToolingArtifact({ root: target, expectedManifestSha256: await expectedManifestSha256() }),
    /digest mismatch for src\/cli\.mjs/
  );

  const pristine = await stagedFixture(context);
  await writeFile(path.join(pristine, "src", "unexpected.mjs"), "export {};\n", "utf8");
  await assert.rejects(
    async () => verifyToolingArtifact({ root: pristine, expectedManifestSha256: await expectedManifestSha256() }),
    /artifact file inventory does not match the pinned manifest/
  );
});

test("verifier rejects a symlink in the artifact even when its target is valid", async (context) => {
  const target = await stagedFixture(context);
  await symlink("../package.json", path.join(target, "src", "package-link.json"));
  await assert.rejects(
    async () => verifyToolingArtifact({ root: target, expectedManifestSha256: await expectedManifestSha256() }),
    /is a symlink/
  );
});

test("hidden runtime paths are refused before GitHub's default artifact upload could omit them", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-tooling-hidden-path-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = await copyProductionTooling(path.join(root, "source"));
  await writeFile(path.join(source, "src", ".artifact-hidden.mjs"), "export {};\n", "utf8");

  assert.ok(!(await githubDefaultArtifactPaths(source)).includes("src/.artifact-hidden.mjs"));
  await assert.rejects(
    async () => toolingManifestText(source),
    /Tooling payload must not contain hidden paths: src\/.artifact-hidden\.mjs/
  );

  const artifact = await stagedFixture(context);
  await writeFile(path.join(artifact, "src", ".artifact-hidden.mjs"), "export {};\n", "utf8");
  await assert.rejects(
    async () => verifyToolingArtifact({ root: artifact, expectedManifestSha256: await expectedManifestSha256() }),
    /src\/.artifact-hidden\.mjs is a hidden path/
  );

  const action = await readFile(path.join(packageRoot, "action.yml"), "utf8");
  assert.match(action, /find "\$ACTION_PATH\/\$directory" -name '\.\*'/);
  assert.match(action, /if find "\$ACTION_PATH\/\$directory" -name '\.\*' -print -quit \| grep -q \.; then/);
  assert.doesNotMatch(action, /grep -q \. &&/);
  assert.match(action, /refused a hidden tooling path/);
  assert.match(action, /created a hidden path/);
  assert.doesNotMatch(action, /include-hidden-files:\s*true/);
});
