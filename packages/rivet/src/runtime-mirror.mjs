import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const MANIFEST_NAME = "rivet-runtime-manifest.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value === "") {
    throw new Error("Rivet runtime mirror: overlay path must be non-empty");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized === MANIFEST_NAME
  ) {
    throw new Error(`Rivet runtime mirror: invalid overlay path ${value}`);
  }
  return normalized;
}

async function collectFiles(root, directory = "") {
  const entries = await readdir(path.join(root, directory), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (directory === "" && entry.name === ".git") continue;
    const relativePath = path.posix.join(directory, entry.name);
    const sourcePath = path.join(root, relativePath);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Rivet runtime mirror: symbolic links are not allowed: ${relativePath}`,
      );
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectFiles(root, relativePath)));
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(
        `Rivet runtime mirror: special files are not allowed: ${relativePath}`,
      );
    }
    files.push({ relativePath, mode: metadata.mode & 0o777 });
  }
  return files;
}

function validateOptions({ sourceRoot, outputRoot, repository, sourceCommit }) {
  if (!sourceRoot || !outputRoot) {
    throw new Error(
      "Rivet runtime mirror: sourceRoot and outputRoot are required",
    );
  }
  if (path.resolve(sourceRoot) === path.resolve(outputRoot)) {
    throw new Error(
      "Rivet runtime mirror: sourceRoot and outputRoot must be different",
    );
  }
  const relativeOutput = path.relative(
    path.resolve(sourceRoot),
    path.resolve(outputRoot),
  );
  if (
    relativeOutput !== "" &&
    !relativeOutput.startsWith("..") &&
    !path.isAbsolute(relativeOutput)
  ) {
    throw new Error(
      "Rivet runtime mirror: outputRoot cannot be inside sourceRoot",
    );
  }
  if (typeof repository !== "string" || repository === "") {
    throw new Error("Rivet runtime mirror: repository is required");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("Rivet runtime mirror: sourceCommit must be a full SHA");
  }
}

export async function generateRuntimeMirror({
  sourceRoot,
  outputRoot,
  repository,
  sourceCommit,
  overlays = [],
}) {
  validateOptions({ sourceRoot, outputRoot, repository, sourceCommit });
  const files = await collectFiles(sourceRoot);
  if (!files.some(({ relativePath }) => relativePath === "LICENSE")) {
    throw new Error("Rivet runtime mirror: upstream LICENSE is required");
  }
  if (files.some(({ relativePath }) => relativePath === MANIFEST_NAME)) {
    throw new Error(
      `Rivet runtime mirror: upstream contains reserved path ${MANIFEST_NAME}`,
    );
  }

  const overlaysByPath = new Map();
  for (const overlay of overlays) {
    const relativePath = normalizeRelativePath(overlay.path);
    if (overlaysByPath.has(relativePath)) {
      throw new Error(
        `Rivet runtime mirror: duplicate overlay path ${relativePath}`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(overlay.expectedSha256)) {
      throw new Error(
        `Rivet runtime mirror: overlay ${relativePath} requires an upstream SHA-256`,
      );
    }
    overlaysByPath.set(relativePath, overlay);
  }

  const sourceFiles = new Set(files.map((file) => file.relativePath));
  for (const [relativePath, overlay] of overlaysByPath) {
    if (!sourceFiles.has(relativePath)) {
      throw new Error(
        `Rivet runtime mirror: overlay target not found: ${relativePath}`,
      );
    }
    const sourceBytes = await readFile(path.join(sourceRoot, relativePath));
    if (sha256(sourceBytes) !== overlay.expectedSha256) {
      throw new Error(
        `Rivet runtime mirror: overlay conflict for ${relativePath}`,
      );
    }
  }

  await mkdir(outputRoot);
  const manifestFiles = [];
  const appliedOverlays = [];
  for (const file of files) {
    const sourcePath = path.join(sourceRoot, file.relativePath);
    const sourceBytes = await readFile(sourcePath);
    const overlay = overlaysByPath.get(file.relativePath);
    let outputBytes = sourceBytes;
    if (overlay) {
      const upstreamSha256 = sha256(sourceBytes);
      outputBytes = Buffer.isBuffer(overlay.replacement)
        ? overlay.replacement
        : Buffer.from(overlay.replacement);
      appliedOverlays.push({
        path: file.relativePath,
        upstreamSha256,
        replacementSha256: sha256(outputBytes),
      });
    }

    const destination = path.join(outputRoot, file.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, outputBytes, { mode: file.mode });
    await chmod(destination, file.mode);
    manifestFiles.push({
      path: file.relativePath,
      mode: file.mode.toString(8).padStart(3, "0"),
      size: outputBytes.length,
      sha256: sha256(outputBytes),
    });
  }

  const manifest = {
    schemaVersion: 1,
    repository,
    sourceCommit,
    files: manifestFiles,
    overlays: appliedOverlays,
  };
  await writeFile(
    path.join(outputRoot, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o644 },
  );
  return manifest;
}
