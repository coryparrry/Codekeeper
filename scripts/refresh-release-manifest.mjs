import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = "MANIFEST.sha256";
const VALID_MODES = new Set(["100644", "100755"]);

function fail(message) {
  throw new Error(`release-manifest: ${message}`);
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  } catch (error) {
    const detail = String(
      error.stderr || error.message || "git command failed",
    ).trim();
    fail(detail);
  }
}

function validatePath(relativePath) {
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("\\") ||
    /[\0\t\n\r]/u.test(relativePath) ||
    relativePath.includes("//")
  ) {
    fail(`tracked path is unsafe: ${JSON.stringify(relativePath)}`);
  }
  for (const component of relativePath.split("/")) {
    if (component === "." || component === ".." || component.length === 0) {
      fail(`tracked path is unsafe: ${JSON.stringify(relativePath)}`);
    }
  }
  return relativePath;
}

function parseTrackedEntries(output) {
  const entries = [];
  const seen = new Set();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) fail("git returned a malformed tracked inventory");
    const header = record.slice(0, separator).split(" ");
    const [mode, object, stage] = header;
    const relativePath = validatePath(record.slice(separator + 1));
    if (!/^[0-9a-f]{40}$/.test(object) || !/^\d$/.test(stage)) {
      fail(`git returned a malformed tracked entry for ${relativePath}`);
    }
    if (!VALID_MODES.has(mode)) {
      fail(
        `tracked path has unsupported or symlink mode ${mode}: ${relativePath}`,
      );
    }
    if (seen.has(relativePath))
      fail(`tracked inventory contains a duplicate path: ${relativePath}`);
    seen.add(relativePath);
    entries.push({ mode, path: relativePath });
  }
  entries.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  return entries;
}

async function regularFile(root, relativePath) {
  const components = relativePath.split("/");
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink())
      fail(`tracked path or parent is a symlink: ${relativePath}`);
    if (index < components.length - 1 && !metadata.isDirectory()) {
      fail(`tracked path has a non-directory parent: ${relativePath}`);
    }
    if (index === components.length - 1 && !metadata.isFile()) {
      fail(`tracked path is not a regular file: ${relativePath}`);
    }
  }
  return current;
}

function assertClean(root) {
  const status = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.trim()) fail("refusing a dirty checkout before manifest refresh");
}

function assertOnlyManifestChanged(root) {
  const records = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).split("\0");
  const status =
    records.length === 1 ? records[0] : records.filter(Boolean).join("\0");
  if (!status.trim()) return false;
  const lines = status.split("\n").filter(Boolean);
  if (lines.length !== 1 || !/^.. MANIFEST\.sha256$/u.test(lines[0])) {
    fail("manifest refresh changed a path other than MANIFEST.sha256");
  }
  return true;
}

function manifestText(entries, digests) {
  return `${entries
    .filter(({ path: relativePath }) => relativePath !== MANIFEST_PATH)
    .map(
      ({ path: relativePath }) =>
        `${digests.get(relativePath)}  ${relativePath}`,
    )
    .join("\n")}\n`;
}

export async function computeManifest(root) {
  const entries = parseTrackedEntries(
    runGit(root, ["ls-files", "--stage", "-z"]),
  );
  const digests = new Map();
  for (const entry of entries) {
    if (entry.path === MANIFEST_PATH) continue;
    const filePath = await regularFile(root, entry.path);
    const bytes = await readFile(filePath);
    digests.set(entry.path, createHash("sha256").update(bytes).digest("hex"));
  }
  return manifestText(entries, digests);
}

export async function refreshManifest(root) {
  assertClean(root);
  const manifestPath = path.join(root, MANIFEST_PATH);
  let existing;
  try {
    await regularFile(root, MANIFEST_PATH);
    existing = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existing = undefined;
  }
  const expected = await computeManifest(root);
  if (existing === expected) return { changed: false, committed: false };

  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, expected, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporaryPath, manifestPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
  assertOnlyManifestChanged(root);
  runGit(root, ["add", "--", MANIFEST_PATH]);
  const staged = runGit(root, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean);
  if (staged.length !== 1 || staged[0] !== MANIFEST_PATH)
    fail("staged changes are not limited to MANIFEST.sha256");
  runGit(root, ["commit", "-m", "chore(release): refresh source manifest"]);
  return { changed: true, committed: true };
}

function repositoryRoot() {
  return path.dirname(fileURLToPath(import.meta.url));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(repositoryRoot(), "..");
  refreshManifest(root)
    .then(({ changed, committed }) => {
      process.stdout.write(
        `release-manifest: ${changed ? "updated" : "already current"}${committed ? ", committed" : ""}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
