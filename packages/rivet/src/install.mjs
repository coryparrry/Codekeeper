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
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { repairAppAuthority, reviewAppAuthority } from "./app-authority.mjs";
import {
  DEFAULT_RIVET_CONFIG,
  productAuthoritySummary,
  validateRivetConfig,
} from "./config.mjs";
import { compileGhAwWorkflow, validateGhAwWorkflow } from "./gh-aw/compile.mjs";
import { inspectCompiledWorkflow } from "./gh-aw/inspect.mjs";
import { assessPullRequestTargetTrust } from "./gh-aw/trust.mjs";
import { GH_AW_RELEASE } from "./gh-aw/versions.mjs";
import {
  renderRivetRepairWorkflow,
  RIVET_REPAIR_WORKFLOW_ID,
} from "./workflows/repair.mjs";
import {
  renderRivetReviewWorkflow,
  RIVET_REVIEW_WORKFLOW_ID,
} from "./workflows/review.mjs";

const NATIVE_IMPORT = ".github/rivet/aw/review-extension.md";
const LOCAL_ACTION = "./.github/rivet/actions/authority-receipt";
const REVIEW_ASSET_ROOT = new URL("../assets/review/", import.meta.url);
const REPAIR_ASSET_ROOT = new URL("../assets/repair/", import.meta.url);
const REVIEW_ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/authority-receipt/action.yml",
  ".github/rivet/actions/authority-receipt/index.mjs",
  NATIVE_IMPORT,
]);
const REPAIR_ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/publish-repair/action.yml",
  ".github/rivet/actions/publish-repair/index.mjs",
  ".github/rivet/actions/validate-repair/action.yml",
  ".github/rivet/actions/validate-repair/index.mjs",
]);

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function knownCompilerDrift(relativePath, current, planned) {
  if (!relativePath.endsWith(".lock.yml")) return false;
  try {
    return isDeepStrictEqual(parseYaml(current), parseYaml(planned));
  } catch {
    return false;
  }
}

async function writeNewFiles(root, files) {
  for (const [relativePath, content] of files) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx", mode: 0o644 });
  }
}

async function assertPlanStillApplies(plan) {
  for (const file of plan.files) {
    const current = await existingFile(
      path.join(plan.repositoryRoot, file.path),
    );
    const currentDigest = current === null ? null : digest(current);
    if (currentDigest !== file.previousSha256) {
      throw new Error(`Rivet installer: ${file.path} changed after planning`);
    }
  }
}

export async function applyInstallation(plan) {
  await assertPlanStillApplies(plan);
  for (const file of plan.files) {
    if (file.status === "unchanged") continue;
    const destination = path.join(plan.repositoryRoot, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, {
      flag: file.status === "create" ? "wx" : "w",
      mode: 0o644,
    });
  }
}

async function assetFiles(paths, root) {
  return new Map(
    await Promise.all(
      paths.map(async (relativePath) => [
        relativePath,
        await readFile(new URL(relativePath, root), "utf8"),
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

function repairConfiguration() {
  return {
    ...structuredClone(DEFAULT_RIVET_CONFIG),
    repair: { authority: "owner" },
  };
}

function reviewConfiguration(mode, config) {
  if (mode !== "repair") return config;
  if (config.repair.authority !== "owner") {
    throw new Error("Rivet installer: repair mode requires owner authority");
  }
  return { ...structuredClone(config), repair: { authority: "never" } };
}

function installationReceipt({
  mode,
  config,
  productAuthority,
  githubApp,
  files,
}) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      product: "Rivet",
      mode,
      configSchemaVersion: config.schemaVersion,
      productAuthority,
      githubApp,
      compiler: {
        version: GH_AW_RELEASE.version,
        commit: GH_AW_RELEASE.commit,
        actionsCommit: GH_AW_RELEASE.actionsCommit,
      },
      managedFiles: [...files.keys(), ".github/rivet/installation.json"].sort(),
    },
    null,
    2,
  )}\n`;
}

async function prepareInstallation({
  mode,
  repositoryRoot,
  binaryPath,
  configuration,
  validation = ["npm test"],
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
} = {}) {
  const root = path.resolve(repositoryRoot ?? process.cwd());
  const config = validateRivetConfig(configuration);
  const reviewConfig = reviewConfiguration(mode, config);
  const productAuthority = productAuthoritySummary(config);
  const githubApp =
    mode === "repair" ? repairAppAuthority(config) : reviewAppAuthority(config);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Rivet installer: repository root must be a directory");
  }
  const stagingRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), `rivet-${mode}-install-`)),
  );
  try {
    const files = await assetFiles(REVIEW_ASSET_PATHS, REVIEW_ASSET_ROOT);
    files.set(
      `.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.md`,
      renderRivetReviewWorkflow({
        nativeImport: NATIVE_IMPORT,
        configuration: reviewConfig,
      }),
    );
    if (mode === "repair") {
      for (const [relativePath, content] of await assetFiles(
        REPAIR_ASSET_PATHS,
        REPAIR_ASSET_ROOT,
      )) {
        files.set(relativePath, content);
      }
      files.set(
        `.github/workflows/${RIVET_REPAIR_WORKFLOW_ID}.md`,
        renderRivetRepairWorkflow({ validation }),
      );
    }
    await writeNewFiles(stagingRoot, files);
    const workflowIds = [
      RIVET_REVIEW_WORKFLOW_ID,
      ...(mode === "repair" ? [RIVET_REPAIR_WORKFLOW_ID] : []),
    ];
    for (const workflowId of workflowIds) {
      await validateWorkflow({
        repositoryRoot: stagingRoot,
        workflowId,
        binaryPath,
      });
      await compileWorkflow({
        repositoryRoot: stagingRoot,
        workflowId,
        binaryPath,
      });
      const lockPath = `.github/workflows/${workflowId}.lock.yml`;
      files.set(
        lockPath,
        await readFile(path.join(stagingRoot, lockPath), "utf8"),
      );
    }
    const authority = inspectCompiledWorkflow(
      files.get(`.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.lock.yml`),
    );
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
    files.set(".github/rivet.json", `${JSON.stringify(config, null, 2)}\n`);
    files.set(
      ".github/rivet/installation.json",
      installationReceipt({ mode, config, productAuthority, githubApp, files }),
    );

    let reviewBaseline = null;
    if (mode === "repair") {
      const baselineFiles = new Map(
        [...files].filter(
          ([relativePath]) =>
            !REPAIR_ASSET_PATHS.includes(relativePath) &&
            !relativePath.includes(`/${RIVET_REPAIR_WORKFLOW_ID}.`),
        ),
      );
      baselineFiles.set(
        ".github/rivet.json",
        `${JSON.stringify(reviewConfig, null, 2)}\n`,
      );
      baselineFiles.set(
        ".github/rivet/installation.json",
        installationReceipt({
          mode: "review",
          config: reviewConfig,
          productAuthority: productAuthoritySummary(reviewConfig),
          githubApp: reviewAppAuthority(reviewConfig),
          files: new Map(
            [...baselineFiles].filter(
              ([relativePath]) =>
                relativePath !== ".github/rivet/installation.json",
            ),
          ),
        }),
      );
      reviewBaseline = baselineFiles;
    }

    const plannedFiles = [];
    for (const [relativePath, content] of [...files].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const current = await existingFile(path.join(root, relativePath));
      const canUpgrade =
        reviewBaseline?.get(relativePath) === current ||
        (current !== null &&
          knownCompilerDrift(relativePath, current, content));
      if (current !== null && current !== content && !canUpgrade) {
        throw new Error(
          `Rivet installer: refusing to overwrite ${relativePath}`,
        );
      }
      plannedFiles.push({
        path: relativePath,
        status:
          current === content
            ? "unchanged"
            : current === null
              ? "create"
              : "update",
        previousSha256: current === null ? null : digest(current),
        sha256: digest(content),
        content,
      });
    }
    return Object.freeze({
      repositoryRoot: root,
      mode,
      productAuthority,
      githubApp,
      authority,
      files: Object.freeze(plannedFiles),
    });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export function prepareReviewInstallation(options = {}) {
  return prepareInstallation({
    ...options,
    mode: "review",
    configuration: options.configuration ?? DEFAULT_RIVET_CONFIG,
  });
}

export function prepareRepairInstallation(options = {}) {
  return prepareInstallation({
    ...options,
    mode: "repair",
    configuration: options.configuration ?? repairConfiguration(),
  });
}

async function install(prepare, options) {
  const plan = await prepare(options);
  if (!options.dryRun) await applyInstallation(plan);
  return Object.freeze({
    repositoryRoot: plan.repositoryRoot,
    mode: plan.mode,
    dryRun: options.dryRun === true,
    productAuthority: plan.productAuthority,
    githubApp: plan.githubApp,
    files: plan.files.map(({ path: filePath, status, sha256 }) => ({
      path: filePath,
      status,
      sha256,
    })),
  });
}

export function installReview(options = {}) {
  return install(prepareReviewInstallation, options);
}

export function installRepair(options = {}) {
  return install(prepareRepairInstallation, options);
}
