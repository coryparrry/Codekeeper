import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import {
  defaultRivetCacheRoot,
  ensureGhAwBinary,
  resolveGhAwAsset,
} from "../src/gh-aw/binary.mjs";
import {
  GH_AW_RELEASE,
  GH_AW_UPGRADE_EXPERIMENT,
} from "../src/gh-aw/versions.mjs";

function fixtureRelease(bytes = Buffer.from("verified gh-aw fixture")) {
  return Object.freeze({
    repository: "github/gh-aw",
    version: "test-version",
    tag: "test-tag",
    commit: "a".repeat(40),
    assets: Object.freeze({
      "linux-x64": Object.freeze({
        name: "linux-amd64",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    }),
  });
}

function response(bytes, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

async function temporaryCache(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rivet-gh-aw-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("pins the immutable gh-aw release and supported assets", () => {
  assert.equal(GH_AW_RELEASE.version, "0.86.2");
  assert.equal(GH_AW_RELEASE.tag, "v0.86.2");
  assert.equal(
    GH_AW_RELEASE.commit,
    "48e5fa3ff52294d91d97715017a9f8693a48387f",
  );
  assert.equal(
    GH_AW_RELEASE.actionsCommit,
    "6aab9e5b5c91c615506061f09bedd81a23babe3c",
  );
  assert.deepEqual(Object.keys(GH_AW_RELEASE.assets), [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  for (const asset of Object.values(GH_AW_RELEASE.assets)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.size > 0);
  }
});

test("records the adjacent upgrade compiler and action receipts", () => {
  assert.equal(GH_AW_UPGRADE_EXPERIMENT.version, "0.86.3");
  assert.equal(
    GH_AW_UPGRADE_EXPERIMENT.commit,
    "6062cd2238b68226eb2bfd47607703ed7944330f",
  );
  assert.equal(
    GH_AW_UPGRADE_EXPERIMENT.actionsCommit,
    "30aadb1626371455f145991c6385924babda2d04",
  );
  assert.deepEqual(
    Object.keys(GH_AW_UPGRADE_EXPERIMENT.assets),
    Object.keys(GH_AW_RELEASE.assets),
  );
  for (const asset of Object.values(GH_AW_UPGRADE_EXPERIMENT.assets)) {
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.size > 0);
  }
});

test("resolves one exact release URL and rejects unsupported platforms", () => {
  const asset = resolveGhAwAsset({ platform: "darwin", arch: "arm64" });
  assert.equal(
    asset.url,
    "https://github.com/github/gh-aw/releases/download/v0.86.2/darwin-arm64",
  );
  assert.throws(
    () => resolveGhAwAsset({ platform: "aix", arch: "ppc64" }),
    /unsupported platform aix-ppc64/,
  );
});

test("uses a Rivet-owned cache root", () => {
  assert.equal(
    defaultRivetCacheRoot({ home: "/users/rivet", env: {} }),
    path.join("/users/rivet", ".cache", "rivet"),
  );
  assert.equal(
    defaultRivetCacheRoot({
      home: "/ignored",
      env: { XDG_CACHE_HOME: "/cache" },
    }),
    path.join("/cache", "rivet"),
  );
  assert.equal(
    defaultRivetCacheRoot({
      home: "/ignored",
      env: { RIVET_CACHE_HOME: "/rivet-cache" },
    }),
    "/rivet-cache",
  );
});

test("downloads, verifies, installs, and reuses the pinned binary", async (t) => {
  const cacheRoot = await temporaryCache(t);
  const bytes = Buffer.from("verified gh-aw fixture");
  const release = fixtureRelease(bytes);
  let downloads = 0;
  const binaryPath = await ensureGhAwBinary({
    platform: "linux",
    arch: "x64",
    cacheRoot,
    release,
    fetchImpl: async (url, options) => {
      downloads += 1;
      assert.equal(
        url,
        "https://github.com/github/gh-aw/releases/download/test-tag/linux-amd64",
      );
      assert.deepEqual(options, { redirect: "follow" });
      return response(bytes);
    },
  });
  assert.deepEqual(await readFile(binaryPath), bytes);
  assert.equal((await lstat(binaryPath)).mode & 0o777, 0o700);

  assert.equal(
    await ensureGhAwBinary({
      platform: "linux",
      arch: "x64",
      cacheRoot,
      release,
      fetchImpl: async () => {
        throw new Error("cache reuse must not fetch");
      },
    }),
    binaryPath,
  );
  assert.equal(downloads, 1);
});

test("rejects a downloaded checksum mismatch without installing it", async (t) => {
  const cacheRoot = await temporaryCache(t);
  const release = fixtureRelease(Buffer.from("expected"));
  await assert.rejects(
    ensureGhAwBinary({
      platform: "linux",
      arch: "x64",
      cacheRoot,
      release,
      fetchImpl: async () => response(Buffer.from("changed!")),
    }),
    /failed checksum verification/,
  );
  const binaryPath = path.join(
    cacheRoot,
    "gh-aw",
    release.version,
    "linux-x64",
    "gh-aw",
  );
  await assert.rejects(lstat(binaryPath), { code: "ENOENT" });
});

test("rejects a corrupt cached binary without falling back to a download", async (t) => {
  const cacheRoot = await temporaryCache(t);
  const release = fixtureRelease();
  const directory = path.join(cacheRoot, "gh-aw", release.version, "linux-x64");
  const binaryPath = path.join(directory, "gh-aw");
  await mkdir(directory, { recursive: true });
  await writeFile(binaryPath, "corrupt");
  let fetched = false;
  await assert.rejects(
    ensureGhAwBinary({
      platform: "linux",
      arch: "x64",
      cacheRoot,
      release,
      fetchImpl: async () => {
        fetched = true;
        return response(Buffer.from("verified gh-aw fixture"));
      },
    }),
    /cached binary checksum does not match/,
  );
  assert.equal(fetched, false);
});

test("rejects symlinked cache entries and failed downloads", async (t) => {
  const cacheRoot = await temporaryCache(t);
  const release = fixtureRelease();
  const directory = path.join(cacheRoot, "gh-aw", release.version, "linux-x64");
  const binaryPath = path.join(directory, "gh-aw");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "target"), "verified gh-aw fixture");
  await symlink("target", binaryPath);
  await assert.rejects(
    ensureGhAwBinary({ platform: "linux", arch: "x64", cacheRoot, release }),
    /cached binary is not a regular file/,
  );

  await rm(binaryPath);
  await assert.rejects(
    ensureGhAwBinary({
      platform: "linux",
      arch: "x64",
      cacheRoot,
      release,
      fetchImpl: async () =>
        response(Buffer.alloc(0), { ok: false, status: 503 }),
    }),
    /download failed with HTTP 503/,
  );
});

test("reports transport failure without using another compiler source", async (t) => {
  const cacheRoot = await temporaryCache(t);
  await assert.rejects(
    ensureGhAwBinary({
      platform: "linux",
      arch: "x64",
      cacheRoot,
      release: fixtureRelease(),
      fetchImpl: async () => {
        throw new Error("network unavailable");
      },
    }),
    /Rivet gh-aw compiler: could not download linux-amd64/,
  );
});
