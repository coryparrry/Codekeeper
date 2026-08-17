import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_PROFILE_IDS, AGENT_PROFILES } from "../src/constants.mjs";
import { discoverRepositoryValidationCommand } from "../src/preflight.mjs";
import { buildInstallPlan } from "../src/plan.mjs";
import { upgradePolicy } from "../src/policy.mjs";
import { createEditableSettings, setSetting, settingsAnswers, settingsRows, validateEditableSettings } from "../src/settings.mjs";
import { HEAD_SHA, temporaryDirectory } from "./helpers.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writePackage(root, source, lockfile = "package-lock.json") {
  await writeFile(`${root}/package.json`, `${JSON.stringify(source, null, 2)}\n`);
  if (lockfile) await writeFile(`${root}/${lockfile}`, "{}\n");
}

test("validation discovery reads only root package metadata and chooses one unambiguous check or test script", async (t) => {
  const root = await temporaryDirectory(t);
  await writePackage(root, {
    packageManager: "npm@11.0.0",
    scripts: { test: "node --test", check: "npm run lint" },
  });
  assert.deepEqual(await discoverRepositoryValidationCommand(root), {
    command: "npm run check",
    packageManager: "npm",
    lockfile: "package-lock.json",
    script: "check",
  });

  await writePackage(root, { scripts: { test: "node --test" } }, "pnpm-lock.yaml");
  assert.equal(await discoverRepositoryValidationCommand(root), null, "multiple package-manager lockfiles are ambiguous");

  const yarnRoot = await temporaryDirectory(t);
  await writePackage(yarnRoot, { scripts: { test: "node --test" } }, "yarn.lock");
  assert.equal((await discoverRepositoryValidationCommand(yarnRoot)).command, "yarn run test");

  const mismatchRoot = await temporaryDirectory(t);
  await writePackage(mismatchRoot, { packageManager: "pnpm@9.0.0", scripts: { test: "node --test" } });
  assert.equal(await discoverRepositoryValidationCommand(mismatchRoot), null);
});

test("validation discovery accepts one reproducible non-Node root build signal and rejects conflicts", async (t) => {
  const makeRoot = await temporaryDirectory(t);
  await writeFile(path.join(makeRoot, "Makefile"), "check:\n\t@true\ntest:\n\t@true\n");
  assert.deepEqual(await discoverRepositoryValidationCommand(makeRoot), {
    command: "make check",
    ecosystem: "make",
    buildFile: "Makefile",
  });

  const uvRoot = await temporaryDirectory(t);
  await writeFile(path.join(uvRoot, "pyproject.toml"), "[project]\ndependencies = [\"pytest>=8\"]\n");
  await writeFile(path.join(uvRoot, "uv.lock"), "version = 1\n");
  assert.deepEqual(await discoverRepositoryValidationCommand(uvRoot), {
    command: "uv run pytest",
    ecosystem: "python",
    buildFile: "pyproject.toml",
    lockfile: "uv.lock",
  });

  const unlockedPythonRoot = await temporaryDirectory(t);
  await writeFile(path.join(unlockedPythonRoot, "pyproject.toml"), "[project]\ndependencies = [\"pytest>=8\"]\n");
  assert.equal(await discoverRepositoryValidationCommand(unlockedPythonRoot), null, "pytest without a lockfile is not reproducible enough to suggest");

  const cargoRoot = await temporaryDirectory(t);
  await writeFile(path.join(cargoRoot, "Cargo.toml"), "[package]\nname = \"widget\"\nversion = \"0.1.0\"\n");
  await writeFile(path.join(cargoRoot, "Cargo.lock"), "version = 4\n");
  assert.equal((await discoverRepositoryValidationCommand(cargoRoot)).command, "cargo test --locked");

  const swiftRoot = await temporaryDirectory(t);
  await writeFile(path.join(swiftRoot, "Package.swift"), "// swift-tools-version: 6.0\n");
  assert.equal((await discoverRepositoryValidationCommand(swiftRoot)).command, "swift test");

  const gradleRoot = await temporaryDirectory(t);
  await writeFile(path.join(gradleRoot, "build.gradle.kts"), "plugins {}\n");
  await writeFile(path.join(gradleRoot, "gradlew"), "#!/bin/sh\n");
  await chmod(path.join(gradleRoot, "gradlew"), 0o755);
  assert.deepEqual(await discoverRepositoryValidationCommand(gradleRoot), {
    command: "./gradlew test",
    ecosystem: "gradle",
    buildFile: "build.gradle.kts",
  });

  const nonExecutableGradleRoot = await temporaryDirectory(t);
  await writeFile(path.join(nonExecutableGradleRoot, "build.gradle"), "plugins {}\n");
  await writeFile(path.join(nonExecutableGradleRoot, "gradlew"), "#!/bin/sh\n");
  await chmod(path.join(nonExecutableGradleRoot, "gradlew"), 0o644);
  assert.equal(await discoverRepositoryValidationCommand(nonExecutableGradleRoot), null);

  const mavenRoot = await temporaryDirectory(t);
  await writeFile(path.join(mavenRoot, "pom.xml"), "<project/>\n");
  await writeFile(path.join(mavenRoot, "mvnw"), "#!/bin/sh\n");
  await chmod(path.join(mavenRoot, "mvnw"), 0o755);
  assert.equal((await discoverRepositoryValidationCommand(mavenRoot)).command, "./mvnw test");

  await writeFile(path.join(mavenRoot, "Cargo.toml"), "[package]\nname = \"widget\"\nversion = \"0.1.0\"\n");
  await writeFile(path.join(mavenRoot, "Cargo.lock"), "version = 4\n");
  assert.equal(await discoverRepositoryValidationCommand(mavenRoot), null, "multiple root ecosystems fail closed");

  const packagePriorityRoot = await temporaryDirectory(t);
  await writePackage(packagePriorityRoot, { scripts: { test: "node --test" } });
  await writeFile(path.join(packagePriorityRoot, "Cargo.toml"), "[package]\nname = \"widget\"\nversion = \"0.1.0\"\n");
  await writeFile(path.join(packagePriorityRoot, "Cargo.lock"), "version = 4\n");
  assert.equal((await discoverRepositoryValidationCommand(packagePriorityRoot)).command, "npm run test", "a locked package-manager script has explicit priority");
});

async function settingsFixture() {
  const policy = upgradePolicy(JSON.parse(await readFile(path.join(PACKAGE_ROOT, "../..", ".github/codekeeper.json"), "utf8")));
  const profiles = Object.fromEntries(await Promise.all(AGENT_PROFILE_IDS.map(async (id) => [
    id,
    await readFile(path.join(PACKAGE_ROOT, "assets", AGENT_PROFILES[id].asset), "utf8"),
  ])));
  return { policy, profiles };
}

test("code-changing settings require explicit confirmation of the discovered command", async () => {
  const { policy, profiles } = await settingsFixture();
  const settings = createEditableSettings({
    policy,
    modes: ["review", "fix"],
    enabled: true,
    validationCommandCandidate: "npm run test",
    profiles,
  });
  const repair = settingsRows(settings).find((row) => row.id === "policy:review.autoRepair");
  const confirmation = settingsRows(settings).find((row) => row.id === "validation-command-confirmed");
  assert.ok(repair);
  assert.ok(confirmation);
  const writesEnabled = setSetting(settings, repair, true);
  assert.throws(() => validateEditableSettings(writesEnabled, policy), /Confirm npm run test/);
  const confirmed = setSetting(writesEnabled, confirmation, true);
  assert.equal(settingsAnswers(confirmed).validationCommand, "npm run test");
});

function planSnapshot(validationCommandCandidate) {
  return {
    root: "/tmp/widget",
    repository: "acme/widget",
    defaultBranch: "main",
    headSha: HEAD_SHA,
    viewerLogin: "coryparrry",
    validationCommandCandidate,
  };
}

function repairAnswers(validationCommand = null) {
  return {
    modes: ["review", "fix"],
    preset: "openai",
    displayName: "Widget",
    ownerLogins: ["coryparrry"],
    appClientId: "Iv123456789012345678",
    automationBotLogin: "codekeeper[bot]",
    enabled: true,
    tracing: false,
    capabilities: ["reviewRepair"],
    validationCommand,
  };
}

test("the plan fails closed without confirmation before it renders an install policy", async () => {
  const bundle = {
    contents: {
      "policies/openai.json": await readFile(path.join(PACKAGE_ROOT, "assets/policies/openai.json"), "utf8"),
    },
  };
  assert.throws(
    () => buildInstallPlan({ bundle, snapshot: planSnapshot("npm run test"), answers: repairAnswers() }),
    /Confirm npm run test/,
  );
});
