import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
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
import { generateRuntimeMirror } from "../src/runtime-mirror.mjs";

const SOURCE_COMMIT = "a".repeat(40);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-mirror-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const outputRoot = path.join(root, "output");
  await mkdir(path.join(sourceRoot, "setup"), { recursive: true });
  await writeFile(path.join(sourceRoot, "LICENSE"), "MIT fixture\n");
  await writeFile(
    path.join(sourceRoot, "setup", "action.yml"),
    "name: fixture\n",
  );
  await writeFile(path.join(sourceRoot, "setup", "run.sh"), "#!/bin/sh\n");
  await chmod(path.join(sourceRoot, "setup", "run.sh"), 0o755);
  return { sourceRoot, outputRoot };
}

test("generates a deterministic licensed mirror with file receipts", async (t) => {
  const { sourceRoot, outputRoot } = await fixture(t);
  const manifest = await generateRuntimeMirror({
    sourceRoot,
    outputRoot,
    repository: "github/gh-aw-actions",
    sourceCommit: SOURCE_COMMIT,
  });

  assert.deepEqual(
    manifest.files.map(({ path: filePath }) => filePath),
    ["LICENSE", "setup/action.yml", "setup/run.sh"],
  );
  assert.equal(manifest.files[2].mode, "755");
  assert.equal(
    (await lstat(path.join(outputRoot, "setup", "run.sh"))).mode & 0o777,
    0o755,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(outputRoot, "rivet-runtime-manifest.json"),
        "utf8",
      ),
    ),
    manifest,
  );
});

test("applies an overlay only to the expected upstream bytes", async (t) => {
  const { sourceRoot, outputRoot } = await fixture(t);
  const upstream = "name: fixture\n";
  const manifest = await generateRuntimeMirror({
    sourceRoot,
    outputRoot,
    repository: "github/gh-aw-actions",
    sourceCommit: SOURCE_COMMIT,
    overlays: [
      {
        path: "setup/action.yml",
        expectedSha256: digest(upstream),
        replacement: "name: Rivet\n",
      },
    ],
  });

  assert.equal(
    await readFile(path.join(outputRoot, "setup", "action.yml"), "utf8"),
    "name: Rivet\n",
  );
  assert.deepEqual(manifest.overlays, [
    {
      path: "setup/action.yml",
      upstreamSha256: digest(upstream),
      replacementSha256: digest("name: Rivet\n"),
    },
  ]);
});

test("rejects stale or missing overlay targets", async (t) => {
  const first = await fixture(t);
  await assert.rejects(
    generateRuntimeMirror({
      ...first,
      repository: "github/gh-aw-actions",
      sourceCommit: SOURCE_COMMIT,
      overlays: [
        {
          path: "setup/action.yml",
          expectedSha256: "0".repeat(64),
          replacement: "changed\n",
        },
      ],
    }),
    /overlay conflict for setup\/action.yml/,
  );

  const second = await fixture(t);
  await assert.rejects(
    generateRuntimeMirror({
      ...second,
      repository: "github/gh-aw-actions",
      sourceCommit: SOURCE_COMMIT,
      overlays: [
        {
          path: "missing.js",
          expectedSha256: "0".repeat(64),
          replacement: "changed\n",
        },
      ],
    }),
    /overlay target not found: missing.js/,
  );
});

test("requires the upstream license and rejects symlinks", async (t) => {
  const missingLicense = await fixture(t);
  await rm(path.join(missingLicense.sourceRoot, "LICENSE"));
  await assert.rejects(
    generateRuntimeMirror({
      ...missingLicense,
      repository: "github/gh-aw-actions",
      sourceCommit: SOURCE_COMMIT,
    }),
    /upstream LICENSE is required/,
  );

  const linkedSource = await fixture(t);
  await symlink(
    "action.yml",
    path.join(linkedSource.sourceRoot, "setup", "link.yml"),
  );
  await assert.rejects(
    generateRuntimeMirror({
      ...linkedSource,
      repository: "github/gh-aw-actions",
      sourceCommit: SOURCE_COMMIT,
    }),
    /symbolic links are not allowed: setup\/link.yml/,
  );
});
