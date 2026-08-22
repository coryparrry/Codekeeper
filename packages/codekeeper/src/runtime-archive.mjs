import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzip as gunzipCallback, gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const RUNTIME_ARCHIVE_PATH = "release/runtime-archive.bin";
export const RUNTIME_ARCHIVE_MANIFEST_PATH = "release/runtime-archive.manifest.json";
export const RUNTIME_ARCHIVE_SOURCE_PATH = "generated/runtime-archive.bin";
export const RUNTIME_ARCHIVE_MANIFEST_SOURCE_PATH =
  "generated/runtime-archive.manifest.json";

const MAGIC = Buffer.from("CKRA");
const VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PATH = 400;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;

function fail(message) {
  throw new Error(`Codekeeper runtime archive: ${message}`);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validArchivePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."))
  );
}

function normalizeMode(mode) {
  if (mode === FILE_MODE || mode === "100644") return FILE_MODE;
  if (mode === EXECUTABLE_MODE || mode === "100755") return EXECUTABLE_MODE;
  fail(`unsupported file mode ${mode}`);
}

function modeLabel(mode) {
  return normalizeMode(mode) === EXECUTABLE_MODE ? "100755" : "100644";
}

function skippedByPrefix(relativePath, skipPrefixes) {
  return skipPrefixes.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

async function collectFiles(root, relativeDirectory, skipPrefixes, files) {
  const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split("/")) : root;
  const information = await lstat(directory);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    fail(`not a regular directory: ${relativeDirectory || "."}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (skippedByPrefix(relativePath, skipPrefixes)) continue;
    if (!validArchivePath(relativePath)) fail(`unsafe path: ${relativePath}`);
    const fullPath = path.join(root, ...relativePath.split("/"));
    if (entry.isSymbolicLink()) fail(`symlink is not allowed: ${relativePath}`);
    if (entry.isDirectory()) {
      await collectFiles(root, relativePath, skipPrefixes, files);
      continue;
    }
    if (!entry.isFile()) fail(`unsupported filesystem entry: ${relativePath}`);
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`not a regular file: ${relativePath}`);
    const bytes = await readFile(fullPath);
    if (bytes.length > MAX_FILE_BYTES) fail(`file exceeds size limit: ${relativePath}`);
    files.push({
      path: relativePath,
      mode: (stat.mode & 0o111) === 0 ? FILE_MODE : EXECUTABLE_MODE,
      bytes,
    });
  }
}

export async function collectRuntimeArchiveFiles(root, { skipPrefixes = [] } = {}) {
  const files = [];
  await collectFiles(root, "", skipPrefixes, files);
  files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  if (files.length === 0) fail("archive would be empty");
  if (files.length > MAX_FILES) fail("archive contains too many files");
  return files;
}

function encodeArchive(files) {
  const chunks = [MAGIC, Buffer.alloc(8)];
  chunks[1].writeUInt32LE(VERSION, 0);
  chunks[1].writeUInt32LE(files.length, 4);
  let uncompressed = 12;
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const mode = normalizeMode(file.mode);
    if (pathBytes.length > MAX_PATH) fail(`path exceeds size limit: ${file.path}`);
    if (file.bytes.length > MAX_FILE_BYTES) fail(`file exceeds size limit: ${file.path}`);
    const header = Buffer.alloc(10);
    header.writeUInt16LE(pathBytes.length, 0);
    header.writeUInt16LE(mode, 2);
    header.writeUInt32LE(file.bytes.length, 4);
    header.writeUInt16LE(0, 8);
    chunks.push(header, pathBytes, file.bytes);
    uncompressed += header.length + pathBytes.length + file.bytes.length;
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) fail("archive exceeds uncompressed size limit");
  }
  return Buffer.concat(chunks);
}

function readExact(buffer, offset, size, label) {
  if (offset + size > buffer.length) fail(`${label} is truncated`);
  return buffer.subarray(offset, offset + size);
}

export function parseRuntimeArchive(uncompressed) {
  if (!uncompressed.subarray(0, 4).equals(MAGIC)) fail("magic is invalid");
  const version = uncompressed.readUInt32LE(4);
  const fileCount = uncompressed.readUInt32LE(8);
  if (version !== VERSION) fail("version is unsupported");
  if (fileCount === 0 || fileCount > MAX_FILES) fail("file count is invalid");
  const files = [];
  const seen = new Set();
  let offset = 12;
  for (let index = 0; index < fileCount; index += 1) {
    const header = readExact(uncompressed, offset, 10, "file header");
    offset += 10;
    const pathLength = header.readUInt16LE(0);
    const mode = header.readUInt16LE(2);
    const size = header.readUInt32LE(4);
    const reserved = header.readUInt16LE(8);
    if (reserved !== 0) fail("reserved header field must be zero");
    const pathBytes = readExact(uncompressed, offset, pathLength, "path");
    offset += pathLength;
    const relativePath = pathBytes.toString("utf8");
    if (!validArchivePath(relativePath) || seen.has(relativePath)) {
      fail(`duplicate or unsafe archive path: ${relativePath}`);
    }
    if (size > MAX_FILE_BYTES) fail(`file exceeds size limit: ${relativePath}`);
    const bytes = Buffer.from(readExact(uncompressed, offset, size, relativePath));
    offset += size;
    seen.add(relativePath);
    files.push({ path: relativePath, mode: normalizeMode(mode), bytes, sha256: sha256(bytes) });
  }
  if (offset !== uncompressed.length) fail("archive has trailing bytes");
  return files;
}

export function runtimeArchiveManifest(files, archiveSha256) {
  return {
    version: 1,
    algorithm: "sha256",
    archiveSha256,
    files: files.map((file) => ({
      path: file.path,
      mode: modeLabel(file.mode),
      size: file.bytes?.length ?? file.size,
      sha256: file.sha256 ?? sha256(file.bytes),
    })),
  };
}

export function parseRuntimeArchiveManifest(source) {
  let manifest;
  try {
    manifest = typeof source === "string" || Buffer.isBuffer(source) ? JSON.parse(source.toString("utf8")) : source;
  } catch {
    fail("manifest is not valid JSON");
  }
  if (
    manifest?.version !== 1 ||
    manifest?.algorithm !== "sha256" ||
    !SHA256.test(manifest?.archiveSha256 ?? "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_FILES
  ) {
    fail("manifest shape is invalid");
  }
  const files = new Map();
  for (const entry of manifest.files) {
    if (
      !entry ||
      !validArchivePath(entry.path) ||
      files.has(entry.path) ||
      !SHA256.test(entry.sha256 ?? "") ||
      !Number.isInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_FILE_BYTES
    ) {
      fail(`manifest contains an invalid file entry: ${entry?.path ?? "unknown"}`);
    }
    files.set(entry.path, {
      path: entry.path,
      mode: normalizeMode(entry.mode),
      size: entry.size,
      sha256: entry.sha256,
    });
  }
  return { manifest, files };
}

export async function createRuntimeArchive(root, { skipPrefixes = [] } = {}) {
  const files = await collectRuntimeArchiveFiles(root, { skipPrefixes });
  const uncompressed = encodeArchive(files);
  const archiveBytes = await gzip(uncompressed);
  const archiveSha256 = sha256(archiveBytes);
  const manifest = runtimeArchiveManifest(files, archiveSha256);
  return { archiveBytes, manifest, files };
}

export async function decodeRuntimeArchive(archiveBytes, manifestSource) {
  const { manifest, files: expected } = parseRuntimeArchiveManifest(manifestSource);
  if (sha256(archiveBytes) !== manifest.archiveSha256) fail("archive digest mismatch");
  const uncompressed = await gunzip(archiveBytes, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  const actual = parseRuntimeArchive(uncompressed);
  if (actual.length !== expected.size) fail("archive file inventory does not match the manifest");
  for (const file of actual) {
    const entry = expected.get(file.path);
    if (!entry) fail(`archive contains an undeclared path: ${file.path}`);
    if (entry.mode !== file.mode || entry.size !== file.bytes.length || entry.sha256 !== file.sha256) {
      fail(`archive entry does not match the manifest: ${file.path}`);
    }
  }
  return actual;
}

export async function extractRuntimeArchive({ archiveBytes, manifestSource, destination, fsImpl = { chmod, lstat, mkdir, rm, writeFile } }) {
  if (typeof destination !== "string" || !path.isAbsolute(destination) || destination.includes("\0")) {
    fail("destination is invalid");
  }
  try {
    await fsImpl.lstat(destination);
    fail("destination already exists");
  } catch (error) {
    if (error?.message?.includes("destination already exists")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const files = await decodeRuntimeArchive(archiveBytes, manifestSource);
  try {
    await fsImpl.mkdir(destination, { recursive: true });
    for (const file of files) {
      const target = path.join(destination, ...file.path.split("/"));
      if (path.relative(destination, target).startsWith("..") || path.isAbsolute(path.relative(destination, target))) {
        fail(`extracted path escaped the destination: ${file.path}`);
      }
      await fsImpl.mkdir(path.dirname(target), { recursive: true });
      await fsImpl.writeFile(target, file.bytes, { flag: "wx", mode: FILE_MODE });
      if (file.mode === EXECUTABLE_MODE) await fsImpl.chmod(target, EXECUTABLE_MODE);
    }
  } catch (cause) {
    await fsImpl.rm(destination, { force: true, recursive: true });
    if (cause?.message?.startsWith("Codekeeper runtime archive:")) throw cause;
    fail("the runtime archive could not be extracted.");
  }
  return destination;
}

export async function verifyRuntimeArchive(root) {
  const archiveBytes = await readFile(path.join(root, ...RUNTIME_ARCHIVE_PATH.split("/")));
  const manifestSource = await readFile(path.join(root, ...RUNTIME_ARCHIVE_MANIFEST_PATH.split("/")));
  await decodeRuntimeArchive(archiveBytes, manifestSource);
  return parseRuntimeArchiveManifest(manifestSource).manifest;
}
