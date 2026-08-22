import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { verifyReleaseAuthority } from "../../../scripts/pack-codekeeper-package.mjs";
import { git, temporaryDirectory } from "./helpers.mjs";

const UNIFIED_SOURCE = "examples/workflows/codekeeper.yml.example";

async function commitFile(repositoryRoot, relativePath, contents, message) {
  const filePath = path.join(repositoryRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  git(repositoryRoot, ["add", relativePath]);
  git(repositoryRoot, ["commit", "-m", message]);
  return git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
}

test("release authority accepts a reviewed no-ff source checkpoint and rejects stale pins", async (t) => {
  const repositoryRoot = await temporaryDirectory(t, "codekeeper-pack-merge-authority-");
  git(repositoryRoot, ["init", "--initial-branch=main"]);
  git(repositoryRoot, ["config", "user.name", "Codekeeper Test"]);
  git(repositoryRoot, ["config", "user.email", "codekeeper-test@example.invalid"]);

  const baseProductionCommit = await commitFile(
    repositoryRoot,
    UNIFIED_SOURCE,
    "name: Codekeeper\n",
    "base production checkpoint",
  );
  git(repositoryRoot, ["checkout", "-b", "assistant-fix"]);
  const featureProductionCommit = await commitFile(
    repositoryRoot,
    UNIFIED_SOURCE,
    'name: Codekeeper\nrun-name: "${{ github.run_id }}"\n',
    "fix assistant caller",
  );
  git(repositoryRoot, ["checkout", "main"]);
  git(repositoryRoot, ["merge", "--no-ff", "assistant-fix", "-m", "review assistant caller"]);
  const reviewedSourceCommit = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  const releaseCommit = await commitFile(
    repositoryRoot,
    "README.md",
    "release snapshot\n",
    "release snapshot",
  );
  git(repositoryRoot, ["remote", "add", "origin", "."]);
  git(repositoryRoot, ["fetch", "origin", "main:refs/remotes/origin/main"]);

  assert.deepEqual(
    verifyReleaseAuthority(repositoryRoot, {
      releaseCommit,
      pinnedSourceCommit: reviewedSourceCommit,
    }),
    {
      defaultBranchRef: "refs/remotes/origin/main",
      latestProductionCheckpoint: featureProductionCommit,
      releaseCommit,
    },
  );
  assert.throws(
    () => verifyReleaseAuthority(repositoryRoot, {
      releaseCommit,
      pinnedSourceCommit: baseProductionCommit,
    }),
    /does not contain the latest production checkpoint/,
  );

  const laterProductionCommit = await commitFile(
    repositoryRoot,
    UNIFIED_SOURCE,
    'name: Codekeeper\nrun-name: "${{ github.run_attempt }}"\n',
    "change assistant caller again",
  );
  const laterReleaseCommit = await commitFile(
    repositoryRoot,
    "README.md",
    "later release snapshot\n",
    "later release snapshot",
  );
  git(repositoryRoot, ["fetch", "origin", "+main:refs/remotes/origin/main"]);
  assert.throws(
    () => verifyReleaseAuthority(repositoryRoot, {
      releaseCommit: laterReleaseCommit,
      pinnedSourceCommit: reviewedSourceCommit,
    }),
    /does not contain the latest production checkpoint/,
  );
  assert.equal(
    verifyReleaseAuthority(repositoryRoot, {
      releaseCommit: laterReleaseCommit,
      pinnedSourceCommit: laterProductionCommit,
    }).latestProductionCheckpoint,
    laterProductionCommit,
  );
});
