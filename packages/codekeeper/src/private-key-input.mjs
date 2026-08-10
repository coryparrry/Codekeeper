import path from "node:path";
import { homedir } from "node:os";
import { lstat, readdir } from "node:fs/promises";
import { InstallerError } from "./errors.mjs";
import { STDIN_FILE_LIMIT_BYTES } from "./command-runner.mjs";

const UNSAFE_ENTRY_NAME = /[\u0000-\u001f\u007f]/;
const DEFAULT_FS = Object.freeze({ lstat, readdir });

function visibleEntryName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || UNSAFE_ENTRY_NAME.test(name)) return null;
  return name;
}

function safeFolderLabel(directory) {
  return visibleEntryName(path.basename(directory)) || "folder";
}

async function listDirectoryMetadata(fsImpl, directory) {
  try {
    const stat = await fsImpl.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
    return await fsImpl.readdir(directory, { withFileTypes: true });
  } catch (cause) {
    throw new InstallerError("The private-key picker failed to list that folder safely.", {
      code: "SECRET_INPUT_DIRECTORY_INVALID",
      cause
    });
  }
}

export async function defaultPrivateKeyDirectory({
  fsImpl = DEFAULT_FS,
  homeDirectory = homedir()
} = {}) {
  if (typeof homeDirectory !== "string" || !path.isAbsolute(homeDirectory)) {
    throw new InstallerError("The private-key picker failed to find a safe starting folder.", {
      code: "SECRET_INPUT_DIRECTORY_INVALID"
    });
  }
  for (const candidate of [path.join(homeDirectory, "Downloads"), homeDirectory]) {
    try {
      await listDirectoryMetadata(fsImpl, candidate);
      return candidate;
    } catch {
      // Prefer a listable Downloads folder, then fall back to a listable home folder.
    }
  }
  throw new InstallerError("The private-key picker failed to find a safe starting folder.", {
    code: "SECRET_INPUT_DIRECTORY_INVALID"
  });
}

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function listPrivateKeyChoices(directory, {
  fsImpl = DEFAULT_FS,
  rootDirectory = directory,
  includeDirectories = false
} = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new InstallerError("The private-key picker received an invalid folder.", {
      code: "SECRET_INPUT_DIRECTORY_INVALID"
    });
  }
  const directoryEntries = await listDirectoryMetadata(fsImpl, directory);
  const root = path.resolve(rootDirectory);
  if (!containedBy(root, directory)) {
    throw new InstallerError("The private-key picker received an invalid folder.", {
      code: "SECRET_INPUT_DIRECTORY_INVALID"
    });
  }
  const folders = [];
  const candidates = [];
  for (const entry of directoryEntries) {
    const label = visibleEntryName(entry.name);
    if (!label || entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (!containedBy(root, target)) continue;
    if (includeDirectories && entry.isDirectory()) {
      try {
        await listDirectoryMetadata(fsImpl, target);
        folders.push({ label, target, type: "directory" });
      } catch {
        // Hide folders that cannot be opened safely.
      }
      continue;
    }
    if (!(entry.isFile() && label.toLowerCase().endsWith(".pem"))) continue;
    try {
      const stat = await fsImpl.lstat(target);
      if (stat.isSymbolicLink()) continue;
      if (!stat.isFile() || stat.size <= 0 || stat.size > STDIN_FILE_LIMIT_BYTES) continue;
      candidates.push({ label, target, type: "file", modifiedTime: Number(stat.mtimeMs) || 0 });
    } catch {
      continue;
    }
  }
  candidates.sort((left, right) => {
    if (left.modifiedTime !== right.modifiedTime) return right.modifiedTime - left.modifiedTime;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });

  const choices = [];
  const targets = new Map();
  if (includeDirectories && path.resolve(directory) !== root) {
    choices.push(Object.freeze({ id: "parent", type: "parent", label: "Parent folder" }));
    targets.set("parent", path.dirname(directory));
  }
  folders.sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
  folders.forEach((candidate, index) => {
    const id = `folder-${index}`;
    choices.push(Object.freeze({ id, type: candidate.type, label: candidate.label }));
    targets.set(id, candidate.target);
  });
  candidates.forEach((candidate, index) => {
    const id = `entry-${index}`;
    choices.push(Object.freeze({ id, type: candidate.type, label: candidate.label }));
    targets.set(id, candidate.target);
  });
  return Object.freeze({
    folderLabel: safeFolderLabel(directory),
    choices: Object.freeze(choices),
    targets
  });
}

function publicListing(listing) {
  return Object.freeze({ folderLabel: listing.folderLabel, choices: listing.choices });
}

function indexedEntries(listing) {
  return new Map(listing.choices.map((choice) => [choice.id, Object.freeze({
    target: listing.targets.get(choice.id),
    type: choice.type
  })]));
}

export async function createPrivateKeyPickerController({
  fsImpl = DEFAULT_FS,
  homeDirectory = homedir()
} = {}) {
  let currentDirectory = await defaultPrivateKeyDirectory({ fsImpl, homeDirectory });
  const rootDirectory = path.resolve(homeDirectory);
  let currentListing = null;
  let entries = new Map();

  const commitListing = (listing) => {
    currentListing = publicListing(listing);
    entries = indexedEntries(listing);
    return currentListing;
  };

  return Object.freeze({
    async list() {
      if (currentListing) return currentListing;
      return commitListing(await listPrivateKeyChoices(currentDirectory, {
        fsImpl,
        rootDirectory,
        includeDirectories: true
      }));
    },
    async activate(id) {
      const entry = entries.get(id);
      if (!entry?.target) {
        throw new InstallerError("The selected private-key picker item is no longer available.", {
          code: "SECRET_INPUT_FILE_INVALID"
        });
      }
      let stat;
      try {
        stat = await fsImpl.lstat(entry.target);
      } catch (cause) {
        throw new InstallerError("The selected private-key picker item is no longer available.", {
          code: "SECRET_INPUT_FILE_INVALID",
          cause
        });
      }
      if (stat.isSymbolicLink()) {
        throw new InstallerError("The selected private-key picker item is not safe.", {
          code: "SECRET_INPUT_FILE_INVALID"
        });
      }
      if (entry.type === "file") {
        if (!stat.isFile() || stat.size <= 0 || stat.size > STDIN_FILE_LIMIT_BYTES) {
          throw new InstallerError("The selected private-key picker item is not a valid private-key file.", {
            code: "SECRET_INPUT_FILE_INVALID"
          });
        }
        return Object.freeze({ selected: true, value: entry.target });
      }
      if (entry.type === "directory" || entry.type === "parent") {
        if (!stat.isDirectory() || !containedBy(rootDirectory, entry.target)) {
          throw new InstallerError("The selected private-key picker item is not safe.", {
            code: "SECRET_INPUT_DIRECTORY_INVALID"
          });
        }
        currentDirectory = entry.target;
        const listing = commitListing(await listPrivateKeyChoices(currentDirectory, {
          fsImpl,
          rootDirectory,
          includeDirectories: true
        }));
        return Object.freeze({ selected: false, listing });
      }
      throw new InstallerError("The selected private-key picker item is not a valid private-key file.", {
        code: "SECRET_INPUT_FILE_INVALID"
      });
    }
  });
}
