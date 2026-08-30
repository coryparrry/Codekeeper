import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  readPackage,
  tagForVersion,
  validateReleasePackage,
} from "../scripts/release-check.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const releaseCheckPath = fileURLToPath(
  new URL("../scripts/release-check.mjs", import.meta.url),
);
const workflowUrl = new URL("../../../.github/workflows/rivet-release.yml", import.meta.url);

test("binds public Rivet metadata to its first release tag", async () => {
  const pkg = await readPackage();
  const tag = tagForVersion(pkg.version);

  assert.deepEqual(validateReleasePackage(pkg, tag), {
    name: "@coryparry/rivet",
    version: pkg.version,
    tag,
  });
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.files, ["assets", "bin", "src"]);
});

test("rejects tags that do not exactly match the package version", async () => {
  const pkg = await readPackage();
  assert.throws(
    () => validateReleasePackage(pkg, "rivet-v999.0.0"),
    /must exactly match package version/,
  );
});

test("checks the release tag from the command-line entrypoint", async () => {
  const pkg = await readPackage();
  const tag = tagForVersion(pkg.version);
  const { stdout } = await execFileAsync(
    process.execPath,
    [releaseCheckPath, "--tag", tag],
    { cwd: packageRoot },
  );
  assert.equal(stdout, `@coryparry/rivet@${pkg.version} is ready for ${tag}\n`);
});

test("packs the executable and production payload without package tests", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "rivet-pack-"));
  try {
    const pkg = await readPackage();
    await execFileAsync(
      "npm",
      ["pack", packageRoot, "--ignore-scripts"],
      {
        cwd: outputDirectory,
        env: {
          ...process.env,
          NPM_CONFIG_CACHE: join(outputDirectory, "npm-cache"),
        },
      },
    );
    const archives = (await readdir(outputDirectory)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    assert.deepEqual(archives, [`coryparry-rivet-${pkg.version}.tgz`]);
    const { stdout } = await execFileAsync(
      "tar",
      ["-tzf", join(outputDirectory, archives[0])],
      { cwd: outputDirectory },
    );
    const paths = new Set(
      stdout
        .trim()
        .split("\n")
        .map((entry) => entry.replace(/^package\//, "")),
    );

    assert(paths.has("bin/rivet.mjs"));
    assert([...paths].some((path) => path.startsWith("src/")));
    assert([...paths].some((path) => path.startsWith("assets/")));
    assert(![...paths].some((path) => path.startsWith("test/")));
    assert(!paths.has("package-lock.json"));
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});

test("uses a protected tag workflow with OIDC and a scoped bootstrap credential", async () => {
  const workflow = parse(await readFile(workflowUrl, "utf8"));
  const publish = workflow.jobs.publish;

  assert.deepEqual(workflow.on.push.tags, ["rivet-v*"]);
  assert.equal(publish["runs-on"], "ubuntu-latest");
  assert.deepEqual(publish.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(publish.environment, "npm");
  assert(
    publish.steps.some(
      (step) =>
        step.name === "Publish to npm" &&
        step.run === "npm publish --provenance --access public --ignore-scripts" &&
        step.env?.NODE_AUTH_TOKEN === "${{ secrets.NPM_PUBLISH_TOKEN }}",
    ),
  );
});
