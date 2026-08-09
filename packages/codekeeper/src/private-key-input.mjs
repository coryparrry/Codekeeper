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
    throw new InstallerError("The private-key picker could not list that folder safely.", {
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
    throw new InstallerError("The private-key picker could not determine a safe starting folder.", {
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
  throw new InstallerError("The private-key picker could not determine a safe starting folder.", {
    code: "SECRET_INPUT_DIRECTORY_INVALID"
  });
}

export async function listPrivateKeyChoices(directory, { fsImpl = DEFAULT_FS } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new InstallerError("The private-key picker received an invalid folder.", {
      code: "SECRET_INPUT_DIRECTORY_INVALID"
    });
  }
  const directoryEntries = await listDirectoryMetadata(fsImpl, directory);
  const candidates = [];
  for (const entry of directoryEntries) {
    const label = visibleEntryName(entry.name);
    if (!label || entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() && !(entry.isFile() && label.toLowerCase().endsWith(".pem"))) continue;
    const target = path.join(directory, entry.name);
    try {
      const stat = await fsImpl.lstat(target);
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory() && !stat.isDirectory()) continue;
      if (entry.isFile() && (!stat.isFile() || stat.size <= 0 || stat.size > STDIN_FILE_LIMIT_BYTES)) continue;
    } catch {
      continue;
    }
    candidates.push({ label, target, type: entry.isDirectory() ? "directory" : "file" });
  }
  candidates.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });

  const choices = [];
  const targets = new Map();
  const parent = path.dirname(directory);
  if (parent !== directory) {
    choices.push(Object.freeze({ id: "parent", type: "parent", label: "Go up one folder" }));
    targets.set("parent", parent);
  }
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
      return commitListing(await listPrivateKeyChoices(currentDirectory, { fsImpl }));
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
      if (!stat.isDirectory()) {
        throw new InstallerError("The selected private-key picker item is not a safe folder.", {
          code: "SECRET_INPUT_DIRECTORY_INVALID"
        });
      }

      // Navigation commits only after the target directory has been listed safely.
      const nextListing = await listPrivateKeyChoices(entry.target, { fsImpl });
      currentDirectory = entry.target;
      commitListing(nextListing);
      return Object.freeze({ selected: false });
    }
  });
}
