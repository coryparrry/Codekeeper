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

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
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
