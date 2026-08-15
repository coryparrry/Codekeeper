import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

async function actionStagingScript() {
  const action = await readFile(path.join(packageRoot, "action.yml"), "utf8");
  const stageStart = action.indexOf("    - name: Stage pinned production tooling\n");
  assert.notEqual(stageStart, -1, "missing composite action staging step");
  const runStart = action.indexOf("      run: |\n", stageStart);
  const nextStep = action.indexOf("\n    - name:", runStart);
  assert.notEqual(runStart, -1, "missing composite action staging script");
  assert.notEqual(nextStep, -1, "missing composite action upload step");
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
  return execFileAsync("bash", ["-c", await actionStagingScript()], {
    env: { ACTION_PATH: actionPath, PATH: process.env.PATH ?? "/usr/bin:/bin", STAGING_ROOT: stagingRoot },
    maxBuffer: 32 * 1024
  });
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
