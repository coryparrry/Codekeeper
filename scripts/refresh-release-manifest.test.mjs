import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeManifest,
  refreshManifest,
} from "./refresh-release-manifest.mjs";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
    },
  });
}

async function fixture(t, files = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-release-manifest-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

test("refreshes a deterministic tracked inventory and commits only MANIFEST.sha256", async (t) => {
  const root = await fixture(t, {
    "README.md": "# Fixture\n",
    "src/index.mjs": "export const ready = true;\n",
  });
  await writeFile(
    path.join(root, "MANIFEST.sha256"),
    "0".repeat(64) + "  README.md\n",
  );
  git(root, ["add", "MANIFEST.sha256"]);
  git(root, ["commit", "-qm", "stale manifest"]);
  const expected = await computeManifest(root);
  const result = await refreshManifest(root);
  assert.deepEqual(result, { changed: true, committed: true });
  assert.equal(
    await readFile(path.join(root, "MANIFEST.sha256"), "utf8"),
    expected,
  );
  assert.equal(
    git(root, [
      "show",
      "--format=%s",
      "--name-only",
      "--no-renames",
      "HEAD",
    ]).trim(),
    "chore(release): refresh source manifest\n\nMANIFEST.sha256",
  );
  assert.deepEqual(await refreshManifest(root), {
    changed: false,
    committed: false,
  });
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]).trim(), "3");
});

test("refuses dirty non-manifest changes before writing", async (t) => {
  const root = await fixture(t, { "README.md": "# Fixture\n" });
  await writeFile(path.join(root, "README.md"), "# Changed\n");
  await assert.rejects(refreshManifest(root), /dirty checkout/);
});

test("refuses tracked symlinks instead of hashing an outside target", async (t) => {
  const root = await fixture(t, { "README.md": "# Fixture\n" });
  await symlink("README.md", path.join(root, "linked.md"));
  git(root, ["add", "linked.md"]);
  git(root, ["commit", "-qm", "symlink fixture"]);
  await assert.rejects(
    refreshManifest(root),
    /unsupported or symlink mode 120000/,
  );
});

test("supports a parent directory with the same name as its file", async (t) => {
  const root = await fixture(t, { "same/same": "safe\n" });
  await assert.doesNotReject(computeManifest(root));
});
