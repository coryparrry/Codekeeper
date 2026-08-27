import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GH_AW_RELEASE } from "./versions.mjs";

function fail(message, options) {
  throw new Error(`Rivet gh-aw compiler: ${message}`, options);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function executableName(platform) {
  return platform === "win32" ? "gh-aw.exe" : "gh-aw";
}

export function resolveGhAwAsset({
  platform = process.platform,
  arch = process.arch,
  release = GH_AW_RELEASE,
} = {}) {
  const asset = release.assets[`${platform}-${arch}`];
  if (!asset) fail(`unsupported platform ${platform}-${arch}`);
  return Object.freeze({
    ...asset,
    url: `https://github.com/${release.repository}/releases/download/${release.tag}/${asset.name}`,
  });
}

export function defaultRivetCacheRoot({
  home = os.homedir(),
  env = process.env,
} = {}) {
  if (env.RIVET_CACHE_HOME) return path.resolve(env.RIVET_CACHE_HOME);
  if (env.XDG_CACHE_HOME)
    return path.join(path.resolve(env.XDG_CACHE_HOME), "rivet");
  return path.join(home, ".cache", "rivet");
}

async function cachedBinary(binaryPath, asset) {
  let metadata;
  try {
    metadata = await lstat(binaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`cached binary is not a regular file: ${binaryPath}`);
  }
  const bytes = await readFile(binaryPath);
  if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) {
    fail(`cached binary checksum does not match ${asset.name}`);
  }
  return true;
}

async function downloadAsset(asset, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(asset.url, { redirect: "follow" });
  } catch (cause) {
    fail(`could not download ${asset.name}`, { cause });
  }
  if (!response.ok) fail(`download failed with HTTP ${response.status}`);
  if (!response.body) fail(`downloaded ${asset.name} has no body`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > asset.size) {
      fail(`downloaded ${asset.name} exceeds expected size ${asset.size}`);
    }
    chunks.push(bytes);
  }
  if (size !== asset.size) {
    fail(`downloaded ${asset.name} has size ${size}, expected ${asset.size}`);
  }
  const bytes = Buffer.concat(chunks, size);
  if (digest(bytes) !== asset.sha256) {
    fail(`downloaded ${asset.name} failed checksum verification`);
  }
  return bytes;
}

export async function ensureGhAwBinary({
  platform = process.platform,
  arch = process.arch,
  cacheRoot = defaultRivetCacheRoot(),
  release = GH_AW_RELEASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  const asset = resolveGhAwAsset({ platform, arch, release });
  const directory = path.join(
    cacheRoot,
    "gh-aw",
    release.version,
    `${platform}-${arch}`,
  );
  const binaryPath = path.join(directory, executableName(platform));
  if (await cachedBinary(binaryPath, asset)) {
    if (platform !== "win32") await chmod(binaryPath, 0o700);
    return binaryPath;
  }

  if (typeof fetchImpl !== "function") fail("fetch is unavailable");
  const bytes = await downloadAsset(asset, fetchImpl);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${executableName(platform)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o700 });
    await rename(temporaryPath, binaryPath);
    if (platform !== "win32") await chmod(binaryPath, 0o700);
  } catch (cause) {
    fail(`could not install ${asset.name}`, { cause });
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  return binaryPath;
}
