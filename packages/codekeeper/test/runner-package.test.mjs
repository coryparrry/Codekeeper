import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, cp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildCodekeeperPackageStage } from "../../../scripts/build-codekeeper-package.mjs";
import { createCommandRunner, requireSuccess, sanitizedEnvironment } from "../src/command-runner.mjs";
import { git, PACKAGE_ROOT, PINNED_COMMIT, REPOSITORY_ROOT, temporaryDirectory } from "./helpers.mjs";

const RUNTIME_PACKAGE_ROOT = path.join(PACKAGE_ROOT, "runtime-package");

const SECRET_CANARIES = Object.freeze({
  OPENAI_API_KEY: "sk-openai-canary-never-forward",
  OPENAI_TRACE_API_KEY: "sk-trace-canary-never-forward",
  DEEPSEEK_API_KEY: "deepseek-canary-never-forward",
  CODEKEEPER_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----canary",
  UNRELATED_SECRET: "unrelated-canary-never-forward"
});

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("sanitized command environments retain only terminal/GitHub configuration and force GitHub.com", () => {
  const environment = sanitizedEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    LANG: "en_GB.UTF-8",
    LC_CTYPE: "UTF-8",
    GH_HOST: "github.enterprise.test",
    GH_CONFIG_DIR: "/tmp/gh",
    ...SECRET_CANARIES
  });
  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    LANG: "en_GB.UTF-8",
    LC_CTYPE: "UTF-8",
    GH_HOST: "github.com",
    GH_CONFIG_DIR: "/tmp/gh",
    GIT_TERMINAL_PROMPT: "0"
  });
  for (const [name, value] of Object.entries(SECRET_CANARIES)) {
    assert.equal(environment[name], undefined);
    assert.doesNotMatch(JSON.stringify(environment), new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the real command runner does not forward secret environment variables to child processes", async () => {
  const runner = createCommandRunner({
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C",
      ...SECRET_CANARIES
    }
  });
  const child = await runner.run(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"]);
  assert.equal(child.status, 0);
  const environment = JSON.parse(child.stdout);
  assert.equal(environment.GH_HOST, "github.com");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  for (const [name, value] of Object.entries(SECRET_CANARIES)) {
    assert.equal(environment[name], undefined);
    assert.doesNotMatch(child.stdout, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the real command runner maps an App PEM descriptor only to child stdin", async () => {
  let spawnCall;
  const runner = createCommandRunner({
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...SECRET_CANARIES
    },
    spawnImpl(command, args, options) {
      spawnCall = { command, args: [...args], options: { ...options } };
      const child = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });
  const result = await runner.run(
    "gh",
    ["secret", "set", "CODEKEEPER_APP_PRIVATE_KEY", "--app", "actions", "--repo", "acme/widget"],
    { cwd: "/tmp/widget", stdio: "ignore", stdinFd: 45, timeoutMs: null }
  );

  assert.equal(result.status, 0);
  assert.deepEqual(spawnCall.options.stdio, [45, "ignore", "ignore"]);
  assert.equal(spawnCall.options.shell, false);
  assert.ok(spawnCall.args.every((argument) => !argument.includes(".pem")));
  for (const [name, value] of Object.entries(SECRET_CANARIES)) {
    assert.equal(spawnCall.options.env[name], undefined);
    assert.doesNotMatch(JSON.stringify(spawnCall), new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the real command runner sends a provider key only through child stdin", async () => {
  const secret = "provider-key-canary-never-log";
  const runner = createCommandRunner({
    environment: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C" }
  });
  const child = await runner.run(process.execPath, [
    "-e",
    "let size=0;process.stdin.on('data',chunk=>size+=chunk.length);process.stdin.on('end',()=>process.stdout.write(size>0?'received':'empty'))"
  ], {
    provideInput(write) {
      write(secret);
    }
  });

  assert.equal(child.status, 0);
  assert.equal(child.stdout, "received");
  assert.doesNotMatch(JSON.stringify(child), new RegExp(secret));
});

test("command runner bounds captured output and requireSuccess rejects failure, timeout, or truncation", async () => {
  const runner = createCommandRunner();
  const large = await runner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(140000))"]);
  assert.equal(large.status, 0);
  assert.equal(large.truncated, true);
  assert.equal(Buffer.byteLength(large.stdout), 128 * 1024);
  await assert.rejects(
    requireSuccess({ run: async () => large }, "node", [], {}, "bounded command failed"),
    (error) => error.code === "COMMAND_FAILED" && error.message === "bounded command failed"
  );
  await assert.rejects(
    requireSuccess({ run: async () => ({ ...large, status: 1, truncated: false }) }, "node", []),
    (error) => error.code === "COMMAND_FAILED"
  );
  await assert.rejects(
    requireSuccess({ run: async () => ({ ...large, status: 1, timedOut: true, truncated: false }) }, "node", []),
    (error) => error.code === "COMMAND_TIMEOUT"
  );
});

test("one npm tarball installs a lightweight CLI then its copied runtime graph entirely offline", async (t) => {
  const npmCache = await temporaryDirectory(t, "codekeeper-npm-cache-");
  const packDestination = await temporaryDirectory(t, "codekeeper-pack-");
  const npmInstallRoot = await temporaryDirectory(t, "codekeeper-npm-install-");
  const dependencyStaging = await temporaryDirectory(t, "codekeeper-dependency-staging-");
  const packageStageParent = await temporaryDirectory(t, "codekeeper-package-runner-stage-");
  const packageStage = path.join(packageStageParent, "package");
  const { manifest: releaseManifest } = await buildCodekeeperPackageStage({
    repositoryRoot: REPOSITORY_ROOT,
    destination: packageStage,
    sourceCommit: git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim(),
    requireClean: false
  });
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
  const npmOptions = { encoding: "utf8", env: npmEnvironment, timeout: 60_000 };
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageStage,
    ...npmOptions
  });
  const report = JSON.parse(output)[0];
  const files = report.files.map((file) => file.path).sort();
  const expected = [...releaseManifest.files.map((file) => file.path), "release/manifest.json"].sort();
  assert.equal(report.name, "codekeeper");
  assert.equal(report.version, "0.2.0");
  assert.deepEqual(files, expected);
  assert.ok(files.every((file) => !file.includes("/test/") && !file.includes("package-lock")));

  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", packDestination
  ], { cwd: packageStage, ...npmOptions }))[0];
  assert.deepEqual(packed.files.map((file) => file.path).sort(), expected);
  const tarball = path.join(packDestination, packed.filename);
  const shrinkwrap = JSON.parse(await readFile(path.join(packageStage, "npm-shrinkwrap.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(path.join(packageStage, "package.json"), "utf8"));
  assert.deepEqual(shrinkwrap.packages[""].dependencies, packageManifest.dependencies);
  const installerLock = structuredClone(shrinkwrap);
  for (const [index, [packagePath, metadata]] of Object.entries(installerLock.packages).entries()) {
    if (!packagePath.startsWith("node_modules/")) continue;
    assert.equal(typeof metadata.version, "string", `${packagePath} is version-locked`);
    assert.match(metadata.integrity, /^sha512-/, `${packagePath} is integrity-locked`);
    const installedDependencyPath = path.join(PACKAGE_ROOT, packagePath);
    if (!(await pathExists(installedDependencyPath))) {
      assert.equal(metadata.optional, true, `${packagePath} is absent only when optional for this platform`);
      continue;
    }
    const installedManifestPath = path.join(installedDependencyPath, "package.json");
    const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
    const hasLifecycleScript = ["preinstall", "install", "postinstall", "prepare"].some(
      (name) => typeof installedManifest.scripts?.[name] === "string"
    );
    let resolvedPath = installedDependencyPath;
    if (hasLifecycleScript) {
      resolvedPath = path.join(dependencyStaging, String(index));
      await cp(installedDependencyPath, resolvedPath, { recursive: true });
      delete installedManifest.scripts;
      await writeFile(path.join(resolvedPath, "package.json"), JSON.stringify(installedManifest));
    }
    delete metadata.integrity;
    metadata.resolved = `file:${resolvedPath}`;
  }
  const installerManifest = {
    name: "codekeeper-install-test",
    private: true,
    dependencies: { codekeeper: `file:${tarball}` }
  };
  installerLock.packages[""] = installerManifest;
  installerLock.packages["node_modules/codekeeper"] = {
    version: packageManifest.version,
    resolved: `file:${tarball}`,
    bin: packageManifest.bin,
    dependencies: packageManifest.dependencies
  };
  await writeFile(path.join(npmInstallRoot, "package.json"), JSON.stringify(installerManifest));
  await writeFile(path.join(npmInstallRoot, "package-lock.json"), JSON.stringify(installerLock));
  execFileSync("npm", [
    "install", "--offline", "--ignore-scripts", "--prefix", npmInstallRoot
  ], { cwd: npmInstallRoot, ...npmOptions });
  const npmInstalledRoot = path.join(npmInstallRoot, "node_modules", "codekeeper");
  const npmInstalledPackage = JSON.parse(await readFile(path.join(npmInstalledRoot, "package.json"), "utf8"));
  const expectedBins = {
    codekeeper: "bin/codekeeper.mjs",
    "codekeeper-verify-package": "bin/verify-package.mjs"
  };
  assert.deepEqual(npmInstalledPackage.bin, expectedBins);
  assert.deepEqual(npmInstalledPackage.dependencies, packageManifest.dependencies);
  assert.deepEqual(npmInstalledPackage.dependencies, { ink: "7.1.1", react: "19.2.8" });
  assert.equal(await pathExists(path.join(npmInstallRoot, "node_modules", "@openai", "agents")), false);
  assert.equal(await pathExists(path.join(npmInstallRoot, "node_modules", "@openai", "codex")), false);
  assert.equal(await pathExists(path.join(npmInstallRoot, "node_modules", "braintrust")), false);
  const npmShim = path.join(npmInstallRoot, "node_modules", ".bin", process.platform === "win32" ? "codekeeper.cmd" : "codekeeper");
  const installedRoot = npmInstalledRoot;
  const shim = npmShim;
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  const installedReadme = await readFile(path.join(installedRoot, "README.md"), "utf8");
  const tarballBytes = await readFile(tarball);
  const expectedIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
  assert.deepEqual(installedPackage.bin, expectedBins);
  assert.deepEqual(installedPackage.dependencies, packageManifest.dependencies);
  assert.deepEqual([...new Set(installedReadme.match(/\b[0-9a-f]{40}\b/g) ?? [])], [PINNED_COMMIT]);
  const shimEnvironment = Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot
  }).filter(([, value]) => typeof value === "string"));
  const invoke = (command, args) => process.platform === "win32"
    ? execFileSync("cmd.exe", ["/d", "/s", "/c", command, ...args], { encoding: "utf8", env: shimEnvironment, timeout: 10_000 })
    : execFileSync(command, args, { encoding: "utf8", env: shimEnvironment, timeout: 10_000 });
  const help = invoke(shim, ["--help"]);
  const version = invoke(shim, ["--version"]);
  const npmInstallHelp = invoke(npmShim, ["--help"]);
  const npmInstallVersion = invoke(npmShim, ["--version"]);
  const npmExecHelp = execFileSync("npm", [
    "exec", "--prefix", npmInstallRoot, "--", "codekeeper", "--help"
  ], { cwd: npmInstallRoot, ...npmOptions });
  const npxHelp = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
    "--offline", "--prefix", npmInstallRoot, "--", "codekeeper", "--help"
  ], { cwd: npmInstallRoot, ...npmOptions });
  const installedTui = await import(pathToFileURL(path.join(
    installedRoot,
    "src",
    "tui.mjs"
  )).href);
  assert.match(help, /^Usage:\n  codekeeper init/m);
  assert.match(help, /^  codekeeper update$/m);
  assert.match(npmInstallHelp, /^Usage:\n  codekeeper init/m);
  assert.match(npmInstallHelp, /^  codekeeper update$/m);
  assert.match(npmExecHelp, /^Usage:\n  codekeeper init/m);
  assert.match(npmExecHelp, /^  codekeeper update$/m);
  assert.match(npxHelp, /^Usage:\n  codekeeper init/m);
  assert.match(npxHelp, /^  codekeeper update$/m);
  assert.equal(version, "0.2.0\n");
  assert.equal(npmInstallVersion, "0.2.0\n");
  assert.throws(
    () => invoke(shim, ["init", "--current-package", "--package-integrity", expectedIntegrity]),
    (error) => {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      return !/release receipt is missing or invalid|Resolving the latest Codekeeper/.test(output);
    },
    "an explicit local tarball receipt enters the current package without registry bootstrapping",
  );
  assert.equal(typeof installedTui.createInkPrompter, "function");
  assert.equal(installedTui.shouldUseInkTui({
    interactive: true,
    input: { isTTY: true, setRawMode() {} },
    output: { isTTY: true },
    environment: { TERM: "xterm-256color" }
  }), true);

  const installedReleaseManifestBytes = await readFile(path.join(installedRoot, "release", "manifest.json"));
  const expectedManifestSha256 = createHash("sha256").update(installedReleaseManifestBytes).digest("hex");
  await writeFile(path.join(installedRoot, "release", "package-integrity.json"), `${JSON.stringify({
    version: 1,
    algorithm: "sha512",
    integrity: expectedIntegrity
  })}\n`);
  const verifier = path.join(
    npmInstallRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "codekeeper-verify-package.cmd" : "codekeeper-verify-package"
  );
  const verifierOutput = invoke(verifier, [
    "--root", installedRoot,
    "--expected-name", "codekeeper",
    "--expected-version", packageManifest.version,
    "--expected-integrity", expectedIntegrity,
    "--expected-manifest-sha256", expectedManifestSha256,
    "--expected-source-commit", releaseManifest.source.commit
  ]);
  assert.match(verifierOutput, /^CODEKEEPER_PACKAGE_VERIFIED name=codekeeper version=0\.2\.0 source=[0-9a-f]{40}$/m);

  const runtimeInstallParent = await temporaryDirectory(t, "codekeeper-runtime-install-");
  const runtimeRoot = path.join(runtimeInstallParent, "runtime");
  await cp(path.join(installedRoot, "runtime"), runtimeRoot, { recursive: true });
  const runtimeLock = JSON.parse(await readFile(path.join(runtimeRoot, "npm-shrinkwrap.json"), "utf8"));
  for (const [index, [packagePath, metadata]] of Object.entries(runtimeLock.packages).entries()) {
    if (!packagePath.startsWith("node_modules/")) continue;
    assert.equal(typeof metadata.version, "string", `${packagePath} is runtime-version-locked`);
    assert.match(metadata.integrity, /^sha512-/, `${packagePath} is runtime-integrity-locked`);
    const installedDependencyPath = path.join(RUNTIME_PACKAGE_ROOT, packagePath);
    if (!(await pathExists(installedDependencyPath))) {
      assert.equal(metadata.optional, true, `${packagePath} is absent only when optional for this platform`);
      continue;
    }
    const installedManifestPath = path.join(installedDependencyPath, "package.json");
    const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
    const hasLifecycleScript = ["preinstall", "install", "postinstall", "prepare"].some(
      (name) => typeof installedManifest.scripts?.[name] === "string"
    );
    let resolvedPath = installedDependencyPath;
    if (hasLifecycleScript) {
      resolvedPath = path.join(dependencyStaging, `runtime-${index}`);
      await cp(installedDependencyPath, resolvedPath, { recursive: true });
      delete installedManifest.scripts;
      await writeFile(path.join(resolvedPath, "package.json"), JSON.stringify(installedManifest));
    }
    delete metadata.integrity;
    metadata.resolved = `file:${resolvedPath}`;
  }
  await writeFile(path.join(runtimeRoot, "npm-shrinkwrap.json"), JSON.stringify(runtimeLock));
  execFileSync("npm", [
    "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"
  ], { cwd: runtimeRoot, ...npmOptions });
  const installedRuntimePaths = await import(pathToFileURL(path.join(runtimeRoot, "src", "lib", "runtime-paths.mjs")).href);
  const installedAgentProfiles = await import(pathToFileURL(path.join(runtimeRoot, "src", "lib", "agent-profiles.mjs")).href);
  const installedBraintrust = await import(pathToFileURL(path.join(runtimeRoot, "integrations", "braintrust", "run-agent.mjs")).href);
  assert.equal(
    await realpath(installedRuntimePaths.CODEX_BIN),
    await realpath(path.join(runtimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js"))
  );
  assert.equal(typeof installedBraintrust.runBraintrustAgent, "function");
  assert.ok(await pathExists(path.join(runtimeRoot, "node_modules", "@openai", "agents")));
  assert.ok(await pathExists(path.join(runtimeRoot, "node_modules", "braintrust")));
  const packagedProfile = await installedAgentProfiles.loadTrustedAgentProfile({
    mode: "review",
    source: installedAgentProfiles.AGENT_PROFILE_SOURCES.package,
    sourceSha: PINNED_COMMIT
  });
  assert.equal(packagedProfile.metadata.source, "package");
  assert.equal(packagedProfile.metadata.path, "runtime/agents/pr-reviewer.md");
  assert.equal(
    packagedProfile.text,
    await readFile(path.join(runtimeRoot, "agents", "pr-reviewer.md"), "utf8")
  );
});
