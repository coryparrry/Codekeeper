import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCommandRunner, requireSuccess, sanitizedEnvironment } from "../src/command-runner.mjs";
import { PACKAGE_ROOT, temporaryDirectory } from "./helpers.mjs";

const SECRET_CANARIES = Object.freeze({
  OPENAI_API_KEY: "sk-openai-canary-never-forward",
  OPENAI_TRACE_API_KEY: "sk-trace-canary-never-forward",
  DEEPSEEK_API_KEY: "deepseek-canary-never-forward",
  CODEKEEPER_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----canary",
  UNRELATED_SECRET: "unrelated-canary-never-forward"
});

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

test("npm tarball contains only the declared runtime and its local entrypoint works without registry access", async (t) => {
  const npmCache = await temporaryDirectory(t, "codekeeper-npm-cache-");
  const packDestination = await temporaryDirectory(t, "codekeeper-pack-");
  const installRoot = await temporaryDirectory(t, "codekeeper-install-");
  const npmInstallRoot = await temporaryDirectory(t, "codekeeper-npm-install-");
  const dependencyStaging = await temporaryDirectory(t, "codekeeper-dependency-staging-");
  const dependencyTarballs = await temporaryDirectory(t, "codekeeper-dependency-tarballs-");
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
    cwd: PACKAGE_ROOT,
    ...npmOptions
  });
  const report = JSON.parse(output)[0];
  const files = report.files.map((file) => file.path).sort();
  const expected = [
    "LICENSE",
    "README.md",
    "assets/agents/issue-triager.md",
    "assets/agents/maintenance-planner.md",
    "assets/agents/pr-reviewer.md",
    "assets/agents/repository-auditor.md",
    "assets/metadata.json",
    "assets/policies/mixed.json",
    "assets/policies/openai.json",
    "assets/workflows/fix.yml",
    "assets/workflows/issues.yml",
    "assets/workflows/maintain.yml",
    "assets/workflows/review.yml",
    "bin/codekeeper.mjs",
    "npm-shrinkwrap.json",
    "package.json",
    "src/assets.mjs",
    "src/cli.mjs",
    "src/command-runner.mjs",
    "src/constants.mjs",
    "src/errors.mjs",
    "src/install.mjs",
    "src/plan.mjs",
    "src/preflight.mjs",
    "src/private-key-input.mjs",
    "src/prompts.mjs",
    "src/shell-command.mjs",
    "src/tui.mjs"
  ].sort();
  assert.equal(report.name, "codekeeper");
  assert.equal(report.version, "0.2.0");
  assert.deepEqual(files, expected);
  assert.ok(files.every((file) => !file.startsWith("test/") && !file.includes("package-lock")));

  const packed = JSON.parse(execFileSync("npm", [
    "pack", "--json", "--ignore-scripts", "--pack-destination", packDestination
  ], { cwd: PACKAGE_ROOT, ...npmOptions }))[0];
  assert.deepEqual(packed.files.map((file) => file.path).sort(), expected);
  const tarball = path.join(packDestination, packed.filename);
  const packageLock = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package-lock.json"), "utf8"));
  const shrinkwrap = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "npm-shrinkwrap.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.deepEqual(shrinkwrap, packageLock, "the published shrinkwrap matches the reviewed development lockfile");
  assert.deepEqual(packageLock.packages[""].dependencies, packageManifest.dependencies);
  const installerLock = structuredClone(packageLock);
  for (const [index, [packagePath, metadata]] of Object.entries(installerLock.packages).entries()) {
    if (!packagePath.startsWith("node_modules/")) continue;
    assert.equal(typeof metadata.version, "string", `${packagePath} is version-locked`);
    assert.match(metadata.integrity, /^sha512-/, `${packagePath} is integrity-locked`);
    const packageName = packagePath.slice("node_modules/".length);
    const stagedPackagePath = path.join(dependencyStaging, `${index}`);
    await cp(path.join(PACKAGE_ROOT, packagePath), stagedPackagePath, { recursive: true });
    const stagedManifestPath = path.join(stagedPackagePath, "package.json");
    const stagedManifest = JSON.parse(await readFile(stagedManifestPath, "utf8"));
    assert.equal(stagedManifest.name, packageName, `${packagePath} has the locked package name`);
    assert.equal(stagedManifest.version, metadata.version, `${packagePath} has the locked version`);
    delete stagedManifest.scripts;
    await writeFile(stagedManifestPath, JSON.stringify(stagedManifest));
    const dependencyTarball = JSON.parse(execFileSync("npm", [
      "pack", "--json", "--ignore-scripts", "--pack-destination", dependencyTarballs
    ], { cwd: stagedPackagePath, ...npmOptions }))[0];
    delete metadata.integrity;
    metadata.resolved = `file:${path.join(dependencyTarballs, dependencyTarball.filename)}`;
  }
  installerLock.packages[""] = {
    name: "codekeeper-install-test",
    private: true,
    dependencies: { codekeeper: `file:${tarball}` }
  };
  installerLock.packages["node_modules/codekeeper"] = {
    version: packageManifest.version,
    resolved: `file:${tarball}`,
    bin: packageManifest.bin,
    dependencies: packageManifest.dependencies
  };
  await writeFile(path.join(npmInstallRoot, "package.json"), JSON.stringify(installerLock.packages[""]));
  await writeFile(path.join(npmInstallRoot, "package-lock.json"), JSON.stringify(installerLock));
  execFileSync("npm", [
    "install", "--offline", "--ignore-scripts", "--prefix", npmInstallRoot
  ], { cwd: npmInstallRoot, ...npmOptions });
  const npmInstalledRoot = path.join(npmInstallRoot, "node_modules", "codekeeper");
  const npmInstalledPackage = JSON.parse(await readFile(path.join(npmInstalledRoot, "package.json"), "utf8"));
  assert.deepEqual(npmInstalledPackage.bin, { codekeeper: "bin/codekeeper.mjs" });
  assert.deepEqual(npmInstalledPackage.dependencies, { ink: "7.1.1", react: "19.2.8" });
  const npmShim = path.join(npmInstallRoot, "node_modules", ".bin", process.platform === "win32" ? "codekeeper.cmd" : "codekeeper");
  const modulesRoot = path.join(installRoot, "node_modules");
  const installedRoot = path.join(modulesRoot, "codekeeper");
  await mkdir(installedRoot, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", installedRoot, "--strip-components=1"], {
    encoding: "utf8",
    timeout: 10_000
  });
  for (const dependency of ["ink", "react"]) {
    await symlink(
      path.join(PACKAGE_ROOT, "node_modules", dependency),
      path.join(modulesRoot, dependency),
      process.platform === "win32" ? "junction" : "dir"
    );
  }
  const binDirectory = path.join(modulesRoot, ".bin");
  await mkdir(binDirectory);
  const shim = path.join(binDirectory, process.platform === "win32" ? "codekeeper.cmd" : "codekeeper");
  if (process.platform === "win32") {
    await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0\\..\\codekeeper\\bin\\codekeeper.mjs" %*\r\n`);
  } else {
    await symlink("../codekeeper/bin/codekeeper.mjs", shim);
    await chmod(path.join(installedRoot, "bin", "codekeeper.mjs"), 0o755);
  }
  const installedPackage = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8"));
  assert.deepEqual(installedPackage.bin, { codekeeper: "bin/codekeeper.mjs" });
  assert.deepEqual(installedPackage.dependencies, { ink: "7.1.1", react: "19.2.8" });
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
    "exec", "--prefix", installRoot, "--", "codekeeper", "--help"
  ], { cwd: installRoot, ...npmOptions });
  const npxHelp = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
    "--offline", "--prefix", installRoot, "--", "codekeeper", "--help"
  ], { cwd: installRoot, ...npmOptions });
  const installedTui = await import(pathToFileURL(path.join(
    installedRoot,
    "src",
    "tui.mjs"
  )).href);
  assert.match(help, /^Usage:\n  codekeeper init/m);
  assert.match(npmInstallHelp, /^Usage:\n  codekeeper init/m);
  assert.match(npmExecHelp, /^Usage:\n  codekeeper init/m);
  assert.match(npxHelp, /^Usage:\n  codekeeper init/m);
  assert.equal(version, "0.2.0\n");
  assert.equal(npmInstallVersion, "0.2.0\n");
  assert.equal(typeof installedTui.createInkPrompter, "function");
  assert.equal(installedTui.shouldUseInkTui({
    interactive: true,
    input: { isTTY: true, setRawMode() {} },
    output: { isTTY: true },
    environment: { TERM: "xterm-256color" }
  }), true);
});
