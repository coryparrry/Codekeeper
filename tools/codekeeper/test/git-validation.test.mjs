import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  boundedChangedFilesBetween,
  boundedDiffBetween,
  changedFilesBetween,
  changedLineHunksBetween,
} from "../src/lib/git.mjs";
import { validateAudit, validateFix } from "../src/lib/validate.mjs";

function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

async function createRepository() {
  const repository = await mkdtemp(path.join(os.tmpdir(), "codekeeper-git-validation-"));
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repository, "before.txt"), "content\n", "utf8");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "initial"]);
  return repository;
}

test("review diff helpers treat a pure rename as delete plus add", async () => {
  const repository = await createRepository();
  try {
    const base = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["mv", "before.txt", "after.txt"]);
    git(repository, ["commit", "-qm", "rename"]);
    const head = git(repository, ["rev-parse", "HEAD"]);

    assert.deepEqual(changedFilesBetween(base, head, repository), ["after.txt", "before.txt"]);
    assert.deepEqual(await boundedChangedFilesBetween(base, head, 2, repository), ["after.txt", "before.txt"]);
    const diff = await boundedDiffBetween(base, head, 4096, repository);
    assert.match(diff.patch, /deleted file mode/);
    assert.match(diff.patch, /new file mode/);
    assert.deepEqual(changedLineHunksBetween(base, head, ["after.txt", "before.txt"], repository), new Map([
      ["after.txt", [{ start: 1, end: 1 }]],
    ]));
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

for (const mode of ["audit", "fix"]) {
  test(`${mode} validation rejects a clean checkout committed past its frozen base`, async () => {
    const repository = await createRepository();
    const previousCwd = process.cwd();
    try {
      const baseSha = git(repository, ["rev-parse", "HEAD"]);
      const directory = path.join(repository, "bundle");
      const contextPath = path.join(repository, "context.json");
      const resultPath = path.join(repository, "result.json");
      const configSha256 = "a".repeat(64);
      await writeFile(contextPath, JSON.stringify({
        mode,
        repository: process.env.GITHUB_REPOSITORY ?? "acme/example",
        configSha256,
        baseSha,
      }), "utf8");
      await writeFile(resultPath, "{}", "utf8");
      await writeFile(path.join(repository, "after.txt"), "committed change\n", "utf8");
      git(repository, ["add", "."]);
      git(repository, ["commit", "-qm", "move checkout"]);
      assert.equal(git(repository, ["status", "--porcelain"]), "");

      process.chdir(repository);
      const validate = mode === "audit" ? validateAudit : validateFix;
      await assert.rejects(
        validate({
          directory,
          contextPath,
          resultPath,
          artifactDirectory: path.join(repository, "artifact"),
          config: {},
          configSha256,
          targetNumber: 1,
        }),
        new RegExp(`Checkout HEAD changed from ${baseSha} to [0-9a-f]{40}`),
      );
    } finally {
      process.chdir(previousCwd);
      await rm(repository, { recursive: true, force: true });
    }
  });
}
