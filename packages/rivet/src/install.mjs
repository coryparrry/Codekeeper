import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileGhAwWorkflow, validateGhAwWorkflow } from "./gh-aw/compile.mjs";
import { inspectCompiledWorkflow } from "./gh-aw/inspect.mjs";
import { assessPullRequestTargetTrust } from "./gh-aw/trust.mjs";
import { GH_AW_RELEASE } from "./gh-aw/versions.mjs";
import {
  renderRivetReviewWorkflow,
  RIVET_REVIEW_WORKFLOW_ID,
} from "./workflows/review.mjs";

const NATIVE_IMPORT = ".github/rivet/aw/review-extension.md";
const LOCAL_ACTION = "./.github/rivet/actions/authority-receipt";
const ASSET_ROOT = new URL("../assets/review/", import.meta.url);
const ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/authority-receipt/action.yml",
  ".github/rivet/actions/authority-receipt/index.mjs",
  NATIVE_IMPORT,
]);

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function writeFiles(root, files) {
  for (const [relativePath, content] of files) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx", mode: 0o644 });
  }
}

async function assetFiles() {
  return new Map(
    await Promise.all(
      ASSET_PATHS.map(async (relativePath) => [
        relativePath,
        await readFile(new URL(relativePath, ASSET_ROOT), "utf8"),
      ]),
    ),
  );
}

async function existingFile(filePath) {
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile()) {
      throw new Error(
        `Rivet installer: managed path is not a regular file: ${filePath}`,
      );
    }
    return readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function configuration() {
  return {
    schemaVersion: 1,
    modes: {
      review: true,
      repair: false,
      issues: false,
      maintain: false,
    },
  };
}

export async function prepareReviewInstallation({
  repositoryRoot,
  binaryPath,
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
} = {}) {
  const root = path.resolve(repositoryRoot ?? process.cwd());
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Rivet installer: repository root must be a directory");
  }
  const stagingRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "rivet-review-install-")),
  );
  try {
    const files = await assetFiles();
    files.set(
      `.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.md`,
      renderRivetReviewWorkflow({ nativeImport: NATIVE_IMPORT }),
    );
    await writeFiles(stagingRoot, files);
    await validateWorkflow({
      repositoryRoot: stagingRoot,
      workflowId: RIVET_REVIEW_WORKFLOW_ID,
      binaryPath,
    });
    await compileWorkflow({
      repositoryRoot: stagingRoot,
      workflowId: RIVET_REVIEW_WORKFLOW_ID,
      binaryPath,
    });
    const lockPath = `.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.lock.yml`;
    const lockSource = await readFile(path.join(stagingRoot, lockPath), "utf8");
    const authority = inspectCompiledWorkflow(lockSource);
    const trust = assessPullRequestTargetTrust({
      authority,
      expectedImports: [NATIVE_IMPORT],
      expectedLocalActions: [LOCAL_ACTION],
    });
    if (!trust.trusted) {
      throw new Error(
        `Rivet installer: compiled review workflow is not trusted: ${trust.violations.join("; ")}`,
      );
    }
    files.set(lockPath, lockSource);
    files.set(
      ".github/rivet.json",
      `${JSON.stringify(configuration(), null, 2)}\n`,
    );
    const managedFiles = [
      ...files.keys(),
      ".github/rivet/installation.json",
    ].sort();
    files.set(
      ".github/rivet/installation.json",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: "Rivet",
          mode: "review",
          compiler: {
            version: GH_AW_RELEASE.version,
            commit: GH_AW_RELEASE.commit,
            actionsCommit: GH_AW_RELEASE.actionsCommit,
          },
          managedFiles,
        },
        null,
        2,
      )}\n`,
    );

    const plannedFiles = [];
    for (const [relativePath, content] of [...files].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const current = await existingFile(path.join(root, relativePath));
      if (current !== null && current !== content) {
        throw new Error(
          `Rivet installer: refusing to overwrite ${relativePath}`,
        );
      }
      plannedFiles.push({
        path: relativePath,
        status: current === content ? "unchanged" : "create",
        sha256: digest(content),
        content,
      });
    }
    return Object.freeze({
      repositoryRoot: root,
      mode: "review",
      authority,
      files: Object.freeze(plannedFiles),
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function installReview(options = {}) {
  const plan = await prepareReviewInstallation(options);
  if (!options.dryRun) {
    await writeFiles(
      plan.repositoryRoot,
      plan.files
        .filter(({ status }) => status === "create")
        .map(({ path: relativePath, content }) => [relativePath, content]),
    );
  }
  return Object.freeze({
    repositoryRoot: plan.repositoryRoot,
    mode: plan.mode,
    dryRun: options.dryRun === true,
    files: plan.files.map(({ path: filePath, status, sha256 }) => ({
      path: filePath,
      status,
      sha256,
    })),
  });
}
