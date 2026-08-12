import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const releaseScript = path.join(repositoryRoot, "scripts/release-source.sh");

function run(command, args, cwd, { env = process.env } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("documented relative output directory resolves outside the checkout", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-release-test-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const checkout = path.join(fixtureRoot, "checkout");
  const output = path.join(fixtureRoot, "artifacts");
  const scripts = path.join(checkout, "scripts");
  await mkdir(scripts, { recursive: true });
  await mkdir(output);
  await copyFile(releaseScript, path.join(scripts, "release-source.sh"));

  const readme = "# Release fixture\n";
  await writeFile(path.join(checkout, "README.md"), readme, "utf8");
  const script = await readFile(path.join(scripts, "release-source.sh"));
  await writeFile(
    path.join(checkout, "MANIFEST.sha256"),
    `${digest(readme)}  README.md\n${digest(script)}  scripts/release-source.sh\n`,
    "utf8"
  );

  run("git", ["init", "-q"], checkout);
  run("git", ["config", "user.name", "Test"], checkout);
  run("git", ["config", "user.email", "test@example.com"], checkout);
  run("git", ["add", "."], checkout);
  run("git", ["commit", "-qm", "fixture"], checkout);

  const stdout = run("bash", ["scripts/release-source.sh", "--output", "../artifacts"], checkout);
  const archives = (await readdir(output)).filter((name) => name.endsWith(".tar.gz"));
  assert.equal(archives.length, 1);
  assert.match(stdout, /verified source archive/);
  assert.match(stdout, /codekeeper-source-[0-9a-f]{40}\.tar\.gz/);

  await mkdir(path.join(checkout, "artifacts"));
  assert.throws(
    () => run("bash", ["scripts/release-source.sh", "--output", "artifacts"], checkout),
    (error) => {
      assert.match(error.stderr, /output directory must be outside the checkout/);
      return true;
    }
  );
});

test("failed verification leaves no final archive and a corrected retry succeeds", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-release-failure-test-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const checkout = path.join(fixtureRoot, "checkout");
  const output = path.join(fixtureRoot, "artifacts");
  const scripts = path.join(checkout, "scripts");
  await mkdir(scripts, { recursive: true });
  await mkdir(output);
  await copyFile(releaseScript, path.join(scripts, "release-source.sh"));

  const readme = "# Release fixture\n";
  await writeFile(path.join(checkout, "README.md"), readme, "utf8");
  const script = await readFile(path.join(scripts, "release-source.sh"));
  await writeFile(
    path.join(checkout, "MANIFEST.sha256"),
    `${"0".repeat(64)}  README.md\n${digest(script)}  scripts/release-source.sh\n`,
    "utf8"
  );

  run("git", ["init", "-q"], checkout);
  run("git", ["config", "user.name", "Test"], checkout);
  run("git", ["config", "user.email", "test@example.com"], checkout);
  run("git", ["add", "."], checkout);
  run("git", ["commit", "-qm", "broken fixture"], checkout);

  assert.throws(() => run("bash", ["scripts/release-source.sh", "--output", "../artifacts"], checkout));
  assert.deepEqual(await readdir(output), []);

  await writeFile(
    path.join(checkout, "MANIFEST.sha256"),
    `${digest(readme)}  README.md\n${digest(script)}  scripts/release-source.sh\n`,
    "utf8"
  );
  run("git", ["add", "MANIFEST.sha256"], checkout);
  run("git", ["commit", "-qm", "fix fixture"], checkout);

  const stdout = run("bash", ["scripts/release-source.sh", "--output", "../artifacts"], checkout);
  assert.match(stdout, /verified source archive/);
  assert.equal((await readdir(output)).filter((name) => name.endsWith(".tar.gz")).length, 1);
});

test("archive inventory explicitly forces C byte-order sorting", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-release-locale-test-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const checkout = path.join(fixtureRoot, "checkout");
  const shimDirectory = path.join(fixtureRoot, "bin");
  const scripts = path.join(checkout, "scripts");
  await mkdir(shimDirectory);
  await mkdir(scripts, { recursive: true });
  await copyFile(releaseScript, path.join(scripts, "release-source.sh"));

  const systemSort = run("which", ["sort"], checkout).trim();
  assert.match(systemSort, /^\/[A-Za-z0-9_./-]+$/);
  await writeFile(
    path.join(shimDirectory, "sort"),
    `#!/bin/sh\nif [ "$LC_ALL" != C ]; then exit 97; fi\nexec "${systemSort}" "$@"\n`,
    { encoding: "utf8", mode: 0o755 }
  );

  const fixtureFiles = new Map([
    ["Z-source.mjs", "export const upper = true;\n"],
    ["_source.mjs", "export const underscore = true;\n"],
    ["a-source.mjs", "export const lower = true;\n"]
  ]);
  for (const [name, contents] of fixtureFiles) {
    await writeFile(path.join(checkout, name), contents, "utf8");
  }
  const script = await readFile(path.join(scripts, "release-source.sh"));
  const manifest = [
    ...[...fixtureFiles].map(([name, contents]) => `${digest(contents)}  ${name}`),
    `${digest(script)}  scripts/release-source.sh`
  ].sort().join("\n");
  await writeFile(path.join(checkout, "MANIFEST.sha256"), `${manifest}\n`, "utf8");

  run("git", ["init", "-q"], checkout);
  run("git", ["config", "user.name", "Test"], checkout);
  run("git", ["config", "user.email", "test@example.com"], checkout);
  run("git", ["add", "."], checkout);
  run("git", ["commit", "-qm", "locale fixture"], checkout);

  const stdout = run("bash", ["scripts/release-source.sh", "--verify"], checkout, {
    env: {
      ...process.env,
      LANG: "POSIX",
      LC_ALL: "POSIX",
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH}`
    }
  });
  assert.match(stdout, /verified source archive/);
});

test("worktree verification checks pending content without weakening archive cleanliness", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-release-worktree-test-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const checkout = path.join(fixtureRoot, "checkout");
  const output = path.join(fixtureRoot, "artifacts");
  const scripts = path.join(checkout, "scripts");
  await mkdir(scripts, { recursive: true });
  await mkdir(output);
  await copyFile(releaseScript, path.join(scripts, "release-source.sh"));

  const readmePath = path.join(checkout, "README.md");
  const manifestPath = path.join(checkout, "MANIFEST.sha256");
  const originalReadme = "# Release fixture\n";
  await writeFile(readmePath, originalReadme, "utf8");
  const script = await readFile(path.join(scripts, "release-source.sh"));
  await writeFile(
    manifestPath,
    `${digest(originalReadme)}  README.md\n${digest(script)}  scripts/release-source.sh\n`,
    "utf8"
  );

  run("git", ["init", "-q"], checkout);
  run("git", ["config", "user.name", "Test"], checkout);
  run("git", ["config", "user.email", "test@example.com"], checkout);
  run("git", ["add", "."], checkout);
  run("git", ["commit", "-qm", "fixture"], checkout);

  const updatedReadme = "# Pending release fixture\n";
  await writeFile(readmePath, updatedReadme, "utf8");
  await writeFile(
    manifestPath,
    `${digest(updatedReadme)}  README.md\n${digest(script)}  scripts/release-source.sh\n`,
    "utf8"
  );
  assert.match(run("bash", ["scripts/release-source.sh", "--verify-worktree"], checkout), /verified working tree/);

  await writeFile(readmePath, "# Stale manifest\n", "utf8");
  assert.throws(() => run("bash", ["scripts/release-source.sh", "--verify-worktree"], checkout));

  await writeFile(readmePath, updatedReadme, "utf8");
  assert.throws(
    () => run("bash", ["scripts/release-source.sh", "--output", "../artifacts"], checkout),
    (error) => {
      assert.match(error.stderr, /refusing dirty checkout/);
      return true;
    }
  );

  const newSourcePath = path.join(checkout, "new-source.mjs");
  const newSource = "export const ready = true;\n";
  await writeFile(newSourcePath, newSource, "utf8");
  assert.throws(() => run("bash", ["scripts/release-source.sh", "--verify-worktree"], checkout));
  await writeFile(
    manifestPath,
    `${digest(updatedReadme)}  README.md\n${digest(newSource)}  new-source.mjs\n${digest(script)}  scripts/release-source.sh\n`,
    "utf8"
  );
  assert.match(run("bash", ["scripts/release-source.sh", "--verify-worktree"], checkout), /verified working tree/);
});
