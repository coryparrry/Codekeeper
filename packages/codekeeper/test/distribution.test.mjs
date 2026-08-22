import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildDistributionMetadata,
  generateCodekeeperDistribution,
} from "../src/distribution.mjs";
import { SOURCE_REPOSITORY } from "../src/constants.mjs";
import { loadVerifiedAssets, sha256 } from "../src/assets.mjs";
import { buildCodekeeperPackageStage } from "../../../scripts/build-codekeeper-package.mjs";
import { fixturePackageStageOptions, git, REPOSITORY_ROOT, temporaryDirectory } from "./helpers.mjs";

test("generated metadata hashes the current canonical caller, runtime, and provenance files", async () => {
  const sourceCommit = "d".repeat(40);
  const metadata = await buildDistributionMetadata({
    repositoryRoot: REPOSITORY_ROOT,
    sourceCommit,
  });
  const caller = await readFile(
    path.join(REPOSITORY_ROOT, "examples/workflows/codekeeper.yml.example"),
  );
  assert.equal(metadata.source.repository, SOURCE_REPOSITORY);
  assert.equal(metadata.source.commit, sourceCommit);
  assert.equal(metadata.assets["workflows/codekeeper.yml"].sha256, sha256(caller));
  assert.equal(metadata.assets["workflows/codekeeper.yml"].bytes, caller.byteLength);
  assert.equal(
    metadata.assets["runtime-workflows/runtime.yml"].sourcePath,
    ".github/workflows/codekeeper-runtime.yml",
  );
});

test("distribution generation writes the caller copy and metadata without a tracked source pin", async (t) => {
  const destination = path.join(await temporaryDirectory(t, "codekeeper-distribution-"), "stage");
  await mkdir(destination, { recursive: true });
  const sourceCommit = git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim();
  const { metadata, files } = await generateCodekeeperDistribution({
    repositoryRoot: REPOSITORY_ROOT,
    destination,
    sourceCommit,
  });
  const caller = await readFile(path.join(destination, "assets/workflows/codekeeper.yml"));
  const example = await readFile(path.join(REPOSITORY_ROOT, "examples/workflows/codekeeper.yml.example"));
  assert.deepEqual(caller, example);
  assert.equal(metadata.source.commit, sourceCommit);
  assert.deepEqual(
    files.map((entry) => entry.path),
    ["assets/workflows/codekeeper.yml", "assets/metadata.json"],
  );
});

test("a package stage records the same build commit in the release manifest and generated metadata", async (t) => {
  const destination = path.join(await temporaryDirectory(t, "codekeeper-distribution-stage-"), "package");
  const sourceCommit = git(REPOSITORY_ROOT, ["rev-parse", "HEAD"]).trim();
  const { manifest } = await buildCodekeeperPackageStage({
    repositoryRoot: REPOSITORY_ROOT,
    destination,
    ...fixturePackageStageOptions(sourceCommit),
  });
  const metadata = JSON.parse(await readFile(path.join(destination, "assets/metadata.json"), "utf8"));
  const bundle = await loadVerifiedAssets({ packageRoot: destination });
  assert.equal(manifest.source.commit, sourceCommit);
  assert.equal(metadata.source.commit, sourceCommit);
  assert.equal(bundle.metadata.source.commit, sourceCommit);
  assert.equal(metadata.source.repository, SOURCE_REPOSITORY);
});
