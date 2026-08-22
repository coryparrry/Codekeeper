import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createRuntimeArchive,
  decodeRuntimeArchive,
  extractRuntimeArchive,
  sha256,
  validArchivePath,
} from "../src/runtime-archive.mjs";
import { temporaryDirectory } from "./helpers.mjs";

async function runtimeTree(t, extra = async () => {}) {
  const root = await temporaryDirectory(t, "codekeeper-runtime-archive-");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"runtime"}\n');
  await writeFile(path.join(root, "src", "cli.mjs"), "export {};\n");
  await extra(root);
  return root;
}

test("archive paths reject hidden, absolute, and parent components", () => {
  assert.equal(validArchivePath("src/cli.mjs"), true);
  assert.equal(validArchivePath("node_modules/@openai/agents/index.js"), true);
  assert.equal(validArchivePath(".bin/codex"), false);
  assert.equal(validArchivePath("/abs"), false);
  assert.equal(validArchivePath("src/../cli.mjs"), false);
});

test("runtime archive round-trips regular files and skips hidden entries", async (t) => {
  const root = await runtimeTree(t, async (tree) => {
    await mkdir(path.join(tree, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(tree, "node_modules", ".bin", "codex"), "hidden\n");
    await writeFile(path.join(tree, ".hidden"), "skip\n");
  });
  const { archiveBytes, manifest, files } = await createRuntimeArchive(root);
  assert.deepEqual(files.map((file) => file.path), ["package.json", "src/cli.mjs"]);
  assert.equal(manifest.archiveSha256, sha256(archiveBytes));
  const decoded = await decodeRuntimeArchive(archiveBytes, JSON.stringify(manifest));
  assert.deepEqual(decoded.map((file) => file.path), ["package.json", "src/cli.mjs"]);

  const destination = path.join(root, "extracted");
  await extractRuntimeArchive({
    archiveBytes,
    manifestSource: JSON.stringify(manifest),
    destination,
  });
  assert.equal(await readFile(path.join(destination, "src", "cli.mjs"), "utf8"), "export {};\n");
});

test("runtime archive creation rejects unexpected symlinks", async (t) => {
  const root = await runtimeTree(t, async (tree) => {
    await symlink("cli.mjs", path.join(tree, "src", "link.mjs"));
  });
  await assert.rejects(createRuntimeArchive(root), /symlink is not allowed/);
});

test("runtime archive extract rejects digest mismatch, reuse, and unsafe destinations", async (t) => {
  const root = await runtimeTree(t);
  const { archiveBytes, manifest } = await createRuntimeArchive(root);
  const destination = path.join(root, "extracted");
  await assert.rejects(
    decodeRuntimeArchive(Buffer.from("tampered"), JSON.stringify(manifest)),
    /digest mismatch/,
  );
  await extractRuntimeArchive({
    archiveBytes,
    manifestSource: JSON.stringify(manifest),
    destination,
  });
  await assert.rejects(
    extractRuntimeArchive({
      archiveBytes,
      manifestSource: JSON.stringify(manifest),
      destination,
    }),
    /destination already exists/,
  );
  await assert.rejects(
    extractRuntimeArchive({
      archiveBytes,
      manifestSource: JSON.stringify(manifest),
      destination: "relative",
    }),
    /destination is invalid/,
  );
});

test("runtime archive collection can omit platform-specific prefixes", async (t) => {
  const root = await runtimeTree(t, async (tree) => {
    await mkdir(path.join(tree, "node_modules", "@openai", "codex-linux-x64"), { recursive: true });
    await writeFile(path.join(tree, "node_modules", "@openai", "codex-linux-x64", "bin"), "native\n");
    await mkdir(path.join(tree, "node_modules", "zod"), { recursive: true });
    await writeFile(path.join(tree, "node_modules", "zod", "index.js"), "js\n");
  });
  const { files } = await createRuntimeArchive(root, {
    skipPrefixes: ["node_modules/@openai/codex-linux-x64"],
  });
  assert.deepEqual(
    files.map((file) => file.path),
    ["node_modules/zod/index.js", "package.json", "src/cli.mjs"],
  );
});
