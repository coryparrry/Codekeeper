import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { formatNpmPackReport, normalizeNpmPackReport, packCodekeeperPackage, verifyReleaseAuthority } from "../../../scripts/pack-codekeeper-package.mjs";
import { createCommandRunner, requireSuccess, sanitizedEnvironment } from "../src/command-runner.mjs";
import { PACKAGE_NAME } from "../src/package-identity.mjs";
import { git, PACKAGE_ROOT, PACKAGE_VERSION, PINNED_COMMIT, REPOSITORY_ROOT, temporaryDirectory } from "./helpers.mjs";

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

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

test("normalizes object- and single-element array-shaped npm pack reports", () => {
  const report = {
    filename: "codekeeper-0.2.0.tgz",
    files: [{ path: "package.json" }]
  };
  assert.deepEqual(normalizeNpmPackReport(JSON.stringify(report)), report);
  assert.deepEqual(normalizeNpmPackReport(JSON.stringify({ codekeeper: report })), report);
  assert.deepEqual(normalizeNpmPackReport(JSON.stringify([report])), report);
  assert.equal(formatNpmPackReport(report), `${JSON.stringify(report)}\n`);
});

test("rejects invalid and multiple npm pack reports", () => {
  assert.throws(() => normalizeNpmPackReport("null"), /invalid report/);
  assert.throws(() => normalizeNpmPackReport(JSON.stringify([])), /invalid number of reports/);
  assert.throws(() => normalizeNpmPackReport(JSON.stringify({ first: { files: [] }, second: { files: [] } })), /invalid number of reports/);
  assert.throws(() => normalizeNpmPackReport(JSON.stringify([null])), /invalid report/);
});

test("pack destination rejects an ancestor symlink into the source repository", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlink creation requires platform-specific privileges");
    return;
  }
  const fixture = await temporaryDirectory(t, "codekeeper-pack-symlink-");
  const repositoryRoot = path.join(fixture, "repository");
  await mkdir(path.join(repositoryRoot, "packages", "codekeeper", "assets"), {
    recursive: true
  });
  await writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({ packageManager: "npm@12.0.2" }));
  await writeFile(path.join(repositoryRoot, "packages", "codekeeper", "package.json"), JSON.stringify({ version: "0.2.0" }));
  await writeFile(path.join(repositoryRoot, "packages", "codekeeper", "assets", "metadata.json"), JSON.stringify({ source: { commit: "0".repeat(40) } }));
  const redirectedParent = path.join(fixture, "redirected-parent");
  await symlink(repositoryRoot, redirectedParent);

  await assert.rejects(
    packCodekeeperPackage({
      repositoryRoot,
      destination: path.join(redirectedParent, "release"),
      sourceCommit: "0".repeat(40),
      requireClean: false
    }),
    /pack destination must be outside the source repository/
  );
  assert.equal(await pathExists(path.join(repositoryRoot, "release")), false);
});

test("release authority accepts a merged snapshot and rejects an unmerged branch", async (t) => {
  const repositoryRoot = await temporaryDirectory(t, "codekeeper-pack-authority-");
  git(repositoryRoot, ["init", "--initial-branch=main"]);
  git(repositoryRoot, ["config", "user.name", "Codekeeper Test"]);
  git(repositoryRoot, ["config", "user.email", "codekeeper-test@example.invalid"]);
  await mkdir(path.join(repositoryRoot, "tools", "codekeeper"), {
    recursive: true
  });
  await writeFile(path.join(repositoryRoot, "tools", "codekeeper", "runtime.mjs"), "export {};\n");
  git(repositoryRoot, ["add", "."]);
  git(repositoryRoot, ["commit", "-m", "production checkpoint"]);
  const productionCommit = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(repositoryRoot, "README.md"), "release snapshot\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["commit", "-m", "release pin"]);
  const releaseCommit = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  git(repositoryRoot, ["remote", "add", "origin", "."]);
  git(repositoryRoot, ["fetch", "origin", "main:refs/remotes/origin/main"]);

  assert.deepEqual(
    verifyReleaseAuthority(repositoryRoot, {
      releaseCommit,
      pinnedSourceCommit: productionCommit
    }),
    {
      defaultBranchRef: "refs/remotes/origin/main",
      latestProductionCheckpoint: productionCommit,
      releaseCommit
    }
  );

  git(repositoryRoot, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repositoryRoot, "feature.txt"), "unmerged\n");
  git(repositoryRoot, ["add", "feature.txt"]);
  git(repositoryRoot, ["commit", "-m", "unmerged feature"]);
  const featureCommit = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  assert.throws(
    () =>
      verifyReleaseAuthority(repositoryRoot, {
        releaseCommit: featureCommit,
        pinnedSourceCommit: productionCommit
      }),
    /must be reachable from the fetched default branch/
  );
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
  const result = await runner.run("gh", ["secret", "set", "CODEKEEPER_APP_PRIVATE_KEY", "--app", "actions", "--repo", "acme/widget"], { cwd: "/tmp/widget", stdio: "ignore", stdinFd: 45, timeoutMs: null });

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
  const child = await runner.run(process.execPath, ["-e", "let size=0;process.stdin.on('data',chunk=>size+=chunk.length);process.stdin.on('end',()=>process.stdout.write(size>0?'received':'empty'))"], {
    provideInput(write) {
      write(secret);
    }
  });

  assert.equal(child.status, 0);
  assert.equal(child.stdout, "received");
  assert.doesNotMatch(JSON.stringify(child), new RegExp(secret));
});

test("command runner rejects delayed credential-input failure after an immediate successful close", async () => {
  const runner = createCommandRunner({
    spawnImpl() {
      const child = new EventEmitter();
      child.stdin = {
        writable: true,
        destroy() {},
        end() {},
        write() {}
      };
      child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });

  await assert.rejects(
    runner.run("gh", ["secret", "set", "CODEKEEPER_APP_PRIVATE_KEY"], {
      timeoutMs: null,
      provideInput: async () => {
        await new Promise((resolve) => process.nextTick(resolve));
        throw new Error("test-only delayed input failure");
      }
    }),
    (error) => error.code === "COMMAND_INPUT_FAILED"
  );
});

test("command runner bounds captured output and requireSuccess rejects failure, timeout, or truncation", async () => {
  const runner = createCommandRunner();
  const large = await runner.run(process.execPath, ["-e", "process.stdout.write('x'.repeat(140000))"]);
  assert.equal(large.status, 0);
  assert.equal(large.truncated, true);
  assert.equal(Buffer.byteLength(large.stdout), 128 * 1024);
  await assert.rejects(requireSuccess({ run: async () => large }, "node", [], {}, "bounded command failed"), (error) => error.code === "COMMAND_FAILED" && error.message === "bounded command failed");
  await assert.rejects(requireSuccess({ run: async () => ({ ...large, status: 1, truncated: false }) }, "node", []), (error) => error.code === "COMMAND_FAILED");
  await assert.rejects(
    requireSuccess(
      {
        run: async () => ({
          ...large,
          status: 1,
          timedOut: true,
          truncated: false
        })
      },
      "node",
      []
    ),
    (error) => error.code === "COMMAND_TIMEOUT"
  );
});

test("one npm tarball installs a lightweight CLI then its copied runtime graph entirely offline", async (t) => {
  const repositoryDeviceId = path.join(REPOSITORY_ROOT, ".local", "state", "gh", "device-id");
  const packageDeviceId = path.join(PACKAGE_ROOT, ".local", "state", "gh", "device-id");
  const deviceIdsBefore = await Promise.all([
    readOptionalFile(repositoryDeviceId),
    readOptionalFile(packageDeviceId)
  ]);
  const npmCache = await temporaryDirectory(t, "codekeeper-npm-cache-");
  const packDestination = await temporaryDirectory(t, "codekeeper-pack-");
  const npmInstallRoot = await temporaryDirectory(t, "codekeeper-npm-install-");
  const dependencyStaging = await temporaryDirectory(t, "codekeeper-dependency-staging-");
  const packEnvironment = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
  const { manifest: releaseManifest, report: packed } = await packCodekeeperPackage({
    repositoryRoot: REPOSITORY_ROOT,
    destination: packDestination,
    sourceCommit: git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim(),
    requireClean: false,
    environment: packEnvironment
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
  const files = packed.files
    .map((file) => file.path)
    .filter((file) => !file.startsWith("node_modules/"))
    .sort();
  const expected = [...releaseManifest.files.map((file) => file.path), "release/manifest.json"].sort();
  assert.equal(packed.name, PACKAGE_NAME);
  assert.equal(packed.version, PACKAGE_VERSION);
  assert.deepEqual(files, expected);
  assert.ok(files.every((file) => !file.includes("/test/") && file !== "package-lock.json"));
  assert.ok(["ink", "react"].every((dependency) => packed.bundled.includes(dependency)));
  assert.ok(packed.files.some((file) => file.path === "node_modules/ink/package.json"));
  assert.ok(packed.files.some((file) => file.path === "node_modules/react/package.json"));

  const tarball = path.join(packDestination, packed.filename);
  const packageLock = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package-lock.json"), "utf8"));
  const packageManifest = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  assert.deepEqual(packageLock.packages[""].dependencies, packageManifest.dependencies);
  assert.deepEqual(packageLock.packages[""].bundleDependencies, packageManifest.bundleDependencies);
  for (const [packagePath, metadata] of Object.entries(packageLock.packages)) {
    if (!packagePath.startsWith("node_modules/")) continue;
    assert.equal(typeof metadata.version, "string", `${packagePath} is version-locked`);
    assert.match(metadata.integrity, /^sha512-/, `${packagePath} is integrity-locked`);
    const installedDependencyPath = path.join(PACKAGE_ROOT, packagePath);
    if (!(await pathExists(installedDependencyPath))) {
      assert.equal(metadata.optional, true, `${packagePath} is absent only when optional for this platform`);
    }
  }
  const installerManifest = {
    name: "codekeeper-install-test",
    private: true,
    dependencies: { [PACKAGE_NAME]: `file:${tarball}` }
  };
  await writeFile(path.join(npmInstallRoot, "package.json"), JSON.stringify(installerManifest));
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--allow-file=root", "--prefix", npmInstallRoot], { cwd: npmInstallRoot, ...npmOptions });
  const npmInstalledRoot = path.join(npmInstallRoot, "node_modules", PACKAGE_NAME);
  const npmInstalledPackage = JSON.parse(await readFile(path.join(npmInstalledRoot, "package.json"), "utf8"));
  const expectedBins = {
    codekeeper: "bin/codekeeper.mjs",
    "codekeeper-verify-package": "bin/verify-package.mjs"
  };
  assert.deepEqual(npmInstalledPackage.bin, expectedBins);
  assert.deepEqual(npmInstalledPackage.dependencies, packageManifest.dependencies);
  assert.deepEqual(npmInstalledPackage.dependencies, {
    ink: "7.1.1",
    react: "19.2.8"
  });
  assert.equal(await pathExists(path.join(npmInstallRoot, "node_modules", "@openai", "agents")), false);
  assert.equal(await pathExists(path.join(npmInstallRoot, "node_modules", "@openai", "codex")), false);
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
  const testHome = path.join(npmInstallRoot, "home");
  const shimEnvironment = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: testHome,
      USERPROFILE: testHome,
      SystemRoot: process.env.SystemRoot,
      XDG_CONFIG_HOME: path.join(testHome, ".config"),
      GH_CONFIG_DIR: path.join(testHome, ".config", "gh")
    }).filter(([, value]) => typeof value === "string")
  );
  const invoke = (command, args) =>
    process.platform === "win32"
      ? execFileSync("cmd.exe", ["/d", "/s", "/c", command, ...args], {
          encoding: "utf8",
          env: shimEnvironment,
          cwd: npmInstallRoot,
          timeout: 10_000
        })
      : execFileSync(command, args, {
          encoding: "utf8",
          env: shimEnvironment,
          cwd: npmInstallRoot,
          timeout: 10_000
        });
  const help = invoke(shim, ["--help"]);
  const version = invoke(shim, ["--version"]);
  const npmInstallHelp = invoke(npmShim, ["--help"]);
  const npmInstallVersion = invoke(npmShim, ["--version"]);
  const npmExecHelp = execFileSync("npm", ["exec", "--prefix", npmInstallRoot, "--", "codekeeper", "--help"], { cwd: npmInstallRoot, ...npmOptions });
  const npxHelp = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--offline", "--prefix", npmInstallRoot, "--", "codekeeper", "--help"], { cwd: npmInstallRoot, ...npmOptions });
  const installedTui = await import(pathToFileURL(path.join(installedRoot, "src", "tui.mjs")).href);
  for (const output of [help, npmInstallHelp, npmExecHelp, npxHelp]) {
    assert.match(output, /^Usage:\n  codekeeper init/m);
    assert.match(output, /^  codekeeper update \[--to X\.Y\.Z\]$/m);
    assert.match(output, /^  codekeeper update --check$/m);
    assert.match(output, /^  codekeeper rollback --to X\.Y\.Z$/m);
  }
  assert.equal(version, `${PACKAGE_VERSION}\n`);
  assert.equal(npmInstallVersion, `${PACKAGE_VERSION}\n`);
  assert.throws(
    () => invoke(shim, ["init", "--current-package", "--package-integrity", expectedIntegrity]),
    (error) => {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      return !/release receipt is missing or invalid|Resolving the latest Codekeeper/.test(output);
    },
    "an explicit local tarball receipt enters the current package without registry bootstrapping"
  );
  assert.equal(typeof installedTui.createInkPrompter, "function");
  assert.equal(
    installedTui.shouldUseInkTui({
      interactive: true,
      input: { isTTY: true, setRawMode() {} },
      output: { isTTY: true },
      environment: { TERM: "xterm-256color" }
    }),
    true
  );

  const installedReleaseManifestBytes = await readFile(path.join(installedRoot, "release", "manifest.json"));
  const expectedManifestSha256 = createHash("sha256").update(installedReleaseManifestBytes).digest("hex");
  await writeFile(
    path.join(installedRoot, "release", "package-integrity.json"),
    `${JSON.stringify({
      version: 1,
      algorithm: "sha512",
      integrity: expectedIntegrity
    })}\n`
  );
  const verifier = path.join(npmInstallRoot, "node_modules", ".bin", process.platform === "win32" ? "codekeeper-verify-package.cmd" : "codekeeper-verify-package");
  const verifierOutput = invoke(verifier, ["--root", installedRoot, "--expected-name", PACKAGE_NAME, "--expected-version", packageManifest.version, "--expected-integrity", expectedIntegrity, "--expected-manifest-sha256", expectedManifestSha256, "--expected-source-commit", releaseManifest.source.commit]);
  assert.ok(verifierOutput.includes(`version=${PACKAGE_VERSION}`));
  assert.match(verifierOutput, /source=[0-9a-f]{40}$/m);

  const runtimeInstallParent = await temporaryDirectory(t, "codekeeper-runtime-install-");
  const runtimeRoot = path.join(runtimeInstallParent, "runtime");
  await cp(path.join(installedRoot, "runtime"), runtimeRoot, {
    recursive: true
  });
  const runtimeLock = JSON.parse(await readFile(path.join(runtimeRoot, "package-lock.json"), "utf8"));
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
    const hasLifecycleScript = ["preinstall", "install", "postinstall", "prepare"].some((name) => typeof installedManifest.scripts?.[name] === "string");
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
  await writeFile(path.join(runtimeRoot, "package-lock.json"), JSON.stringify(runtimeLock));
  execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtimeRoot, ...npmOptions });
  const installedRuntimePaths = await import(pathToFileURL(path.join(runtimeRoot, "src", "lib", "runtime-paths.mjs")).href);
  const installedAgentProfiles = await import(pathToFileURL(path.join(runtimeRoot, "src", "lib", "agent-profiles.mjs")).href);
  assert.equal(await realpath(installedRuntimePaths.CODEX_BIN), await realpath(path.join(runtimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js")));
  assert.ok(await pathExists(path.join(runtimeRoot, "node_modules", "@openai", "agents")));
  assert.deepEqual(
    await Promise.all([readOptionalFile(repositoryDeviceId), readOptionalFile(packageDeviceId)]),
    deviceIdsBefore,
    "the offline installed-CLI canary must not write GitHub CLI state into the source checkout"
  );
  const packagedProfile = await installedAgentProfiles.loadTrustedAgentProfile({
    mode: "review",
    source: installedAgentProfiles.AGENT_PROFILE_SOURCES.package,
    sourceSha: PINNED_COMMIT
  });
  assert.equal(packagedProfile.metadata.source, "package");
  assert.equal(packagedProfile.metadata.path, "runtime/agents/pr-reviewer.md");
  assert.equal(packagedProfile.text, await readFile(path.join(runtimeRoot, "agents", "pr-reviewer.md"), "utf8"));
});
