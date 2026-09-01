import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
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
import {
  assessIssueTriageTrust,
  assessMaintenanceTrust,
  assessPullRequestTargetTrust,
} from "./gh-aw/trust.mjs";
import { completeInstallationFiles } from "./installation-receipt.mjs";
import {
  RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS,
  RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  RIVET_ISSUE_TRIAGE_WORKFLOW_ID,
} from "./workflows/issue-triage.mjs";
import {
  RIVET_MAINTENANCE_NATIVE_IMPORTS,
  RIVET_MAINTENANCE_WORKFLOW_ID,
} from "./workflows/maintenance.mjs";
import {
  RIVET_REPAIR_NATIVE_IMPORTS,
  RIVET_REPAIR_WORKFLOW_ID,
} from "./workflows/repair.mjs";
import {
  RIVET_REVIEW_NATIVE_IMPORTS,
  RIVET_REVIEW_WORKFLOW_ID,
} from "./workflows/review.mjs";
import {
  buildWorkflowFiles,
  ISSUE_CONTEXT_ASSET_PATHS,
  MAINTENANCE_ASSET_PATHS,
  REPAIR_ASSET_PATHS,
  REVIEW_CONTEXT_ASSET_PATHS,
} from "./workflow-files.mjs";
const [ISSUE_TRIAGER_IMPORT] = RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS;
const [FIXER_IMPORT] = RIVET_REPAIR_NATIVE_IMPORTS;
const REVIEW_LOCAL_ACTIONS = Object.freeze([
  "./.github/rivet/actions/authority-receipt",
  "./.github/rivet/actions/prepare-review-context",
]);
const ISSUE_LOCAL_ACTIONS = Object.freeze([
  "./.github/rivet/actions/prepare-issue-context",
]);
const V013_REVIEW_EXTENSION = new URL(
  "../assets/upgrades/v0.1.3/review-extension.md",
  import.meta.url,
);
const V012_PUBLISH_REPAIR = new URL(
  "../assets/upgrades/v0.1.12/publish-repair-index.mjs",
  import.meta.url,
);
const V013_PREPARE_REVIEW_CONTEXT = new URL(
  "../assets/upgrades/v0.1.13/prepare-review-context-index.mjs",
  import.meta.url,
);
const PROFILED_REVIEW_EXTENSIONS = Object.freeze([
  {
    version: "v0.1.13",
    url: new URL(
      "../assets/upgrades/v0.1.13/review-extension.md",
      import.meta.url,
    ),
  },
  {
    version: "v0.1.11",
    url: new URL(
      "../assets/upgrades/v0.1.11/review-extension.md",
      import.meta.url,
    ),
  },
  {
    version: "v0.1.9",
    url: new URL(
      "../assets/upgrades/v0.1.9/review-extension.md",
      import.meta.url,
    ),
  },
  {
    version: "v0.1.7",
    url: new URL(
      "../assets/upgrades/v0.1.7/review-extension.md",
      import.meta.url,
    ),
  },
  {
    version: "v0.1.5",
    url: new URL(
      "../assets/upgrades/v0.1.5/review-extension.md",
      import.meta.url,
    ),
  },
]);
const MAINTENANCE_LOCAL_ACTION = "./.github/rivet/actions/validate-audit";
const MAINTENANCE_MANAGED_PATHS = Object.freeze([
  RIVET_MAINTENANCE_NATIVE_IMPORTS[0],
  ...MAINTENANCE_ASSET_PATHS,
  `.github/workflows/${RIVET_MAINTENANCE_WORKFLOW_ID}.md`,
  `.github/workflows/${RIVET_MAINTENANCE_WORKFLOW_ID}.lock.yml`,
]);
function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}
export function knownCompilerDrift(relativePath, current, planned) {
  if (!relativePath.endsWith(".lock.yml")) return false;
  try {
    return isDeepStrictEqual(parseYaml(current), parseYaml(planned));
  } catch {
    return false;
  }
}
function matchesBaseline(relativePath, current, baseline) {
  const planned = baseline.get(relativePath);
  return (
    planned === current ||
    (planned !== undefined &&
      knownCompilerDrift(relativePath, current, planned))
  );
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
    if (file.status === "delete") {
      await unlink(destination);
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, {
      flag: file.status === "create" ? "wx" : "w",
      mode: 0o644,
    });
  }
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
function withoutIssueTriage(files) {
  return new Map(
    [...files].filter(
      ([relativePath]) =>
        relativePath !== ISSUE_TRIAGER_IMPORT &&
        !ISSUE_CONTEXT_ASSET_PATHS.includes(relativePath) &&
        !relativePath.includes(`/${RIVET_ISSUE_TRIAGE_WORKFLOW_ID}.`),
    ),
  );
}
function withoutMaintenance(files) {
  return new Map(
    [...files].filter(
      ([relativePath]) =>
        !RIVET_MAINTENANCE_NATIVE_IMPORTS.includes(relativePath) &&
        !MAINTENANCE_ASSET_PATHS.includes(relativePath) &&
        !relativePath.includes(`/${RIVET_MAINTENANCE_WORKFLOW_ID}.`),
    ),
  );
}
function withoutReviewContext(files) {
  const previous = new Map(files);
  for (const relativePath of REVIEW_CONTEXT_ASSET_PATHS) {
    previous.delete(relativePath);
  }
  return previous;
}
async function buildMaintenanceVariant({
  stagingRoot,
  mode,
  config,
  validation,
  binaryPath,
  compileWorkflow,
  validateWorkflow,
  env,
}) {
  const files = await buildWorkflowFiles({
    stagingRoot,
    mode,
    config,
    reviewConfig: reviewConfiguration(mode, config),
    validation,
    binaryPath,
    compileWorkflow,
    validateWorkflow,
    env,
    profiles: true,
    includeIssueTriage: config.issues.triage === "automatic",
    includeMaintenance: true,
  });
  return completeInstallationFiles(files, { mode, config });
}
async function prepareInstallation({
  mode,
  repositoryRoot,
  binaryPath,
  configuration,
  validation = ["npm test"],
  compileWorkflow = compileGhAwWorkflow,
  validateWorkflow = validateGhAwWorkflow,
  env,
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
    const files = await buildWorkflowFiles({
      stagingRoot: path.join(stagingRoot, "target"),
      mode,
      config,
      reviewConfig,
      validation,
      binaryPath,
      compileWorkflow,
      validateWorkflow,
      env,
      profiles: true,
      includeIssueTriage: config.issues.triage === "automatic",
      includeMaintenance: config.maintenance.mode !== "disabled",
    });
    const authority = inspectCompiledWorkflow(
      files.get(`.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.lock.yml`),
    );
    const trust = assessPullRequestTargetTrust({
      authority,
      expectedEngine: config.models.review.engine,
      expectedImports: RIVET_REVIEW_NATIVE_IMPORTS,
      expectedLocalActions: REVIEW_LOCAL_ACTIONS,
      expectedModel: config.models.review.model,
      expectedIssueTriage:
        config.issues.triage === "automatic" ? "automatic" : "disabled",
    });
    if (!trust.trusted) {
      throw new Error(
        `Rivet installer: compiled review workflow is not trusted: ${trust.violations.join("; ")}`,
      );
    }
    if (config.issues.triage === "automatic") {
      const issueAuthority = inspectCompiledWorkflow(
        files.get(
          `.github/workflows/${RIVET_ISSUE_TRIAGE_WORKFLOW_ID}.lock.yml`,
        ),
      );
      const issueTrust = assessIssueTriageTrust({
        authority: issueAuthority,
        expectedEngine: config.models.review.engine,
        expectedImports: RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS,
        expectedLocalActions: ISSUE_LOCAL_ACTIONS,
        expectedModel: config.models.review.model,
        expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
      });
      if (!issueTrust.trusted) {
        throw new Error(
          `Rivet installer: compiled issue triage workflow is not trusted: ${issueTrust.violations.join("; ")}`,
        );
      }
    }
    if (config.maintenance.mode !== "disabled") {
      const maintenanceAuthority = inspectCompiledWorkflow(
        files.get(
          `.github/workflows/${RIVET_MAINTENANCE_WORKFLOW_ID}.lock.yml`,
        ),
      );
      const maintenanceTrust = assessMaintenanceTrust({
        authority: maintenanceAuthority,
        expectedEngine: config.models.review.engine,
        expectedImports: RIVET_MAINTENANCE_NATIVE_IMPORTS,
        expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
        expectedModel: config.models.review.model,
        expectedTriggers:
          config.maintenance.mode === "scheduled"
            ? ["schedule", "workflow_dispatch"]
            : ["workflow_dispatch"],
      });
      if (!maintenanceTrust.trusted) {
        throw new Error(
          `Rivet installer: compiled maintenance workflow is not trusted: ${maintenanceTrust.violations.join("; ")}`,
        );
      }
    }
    completeInstallationFiles(files, { mode, config });
    const baselines = [];
    let maintenanceDeletionFiles = null;
    const existingFiles = new Map(
      await Promise.all(
        [...files].map(async ([relativePath]) => [
          relativePath,
          await existingFile(path.join(root, relativePath)),
        ]),
      ),
    );
    const requiresUpgrade = [...files].some(
      ([relativePath, content]) =>
        existingFiles.get(relativePath) !== null &&
        existingFiles.get(relativePath) !== content,
    );
    if (config.maintenance.mode === "disabled") {
      const existingMaintenanceFiles = new Map(
        await Promise.all(
          MAINTENANCE_MANAGED_PATHS.map(async (relativePath) => [
            relativePath,
            await existingFile(path.join(root, relativePath)),
          ]),
        ),
      );
      const existingMaintenancePath = MAINTENANCE_MANAGED_PATHS.find(
        (relativePath) => existingMaintenanceFiles.get(relativePath) !== null,
      );
      const existingConfigurationContent =
        existingFiles.get(".github/rivet.json");
      let existingConfiguration = null;
      if (existingConfigurationContent !== null) {
        try {
          existingConfiguration = validateRivetConfig(
            JSON.parse(existingConfigurationContent),
          );
        } catch {
          existingConfiguration = null;
        }
      }
      const previousMaintenanceMode = existingConfiguration?.maintenance.mode;
      if (
        ["manual", "scheduled"].includes(previousMaintenanceMode) ||
        existingMaintenancePath
      ) {
        if (!existingConfiguration || previousMaintenanceMode === "disabled") {
          throw new Error(
            `Rivet installer: refusing to delete ${existingMaintenancePath ?? ".github/rivet.json"}`,
          );
        }
        const expectedConfiguration = structuredClone(config);
        expectedConfiguration.maintenance.mode = previousMaintenanceMode;
        if (!isDeepStrictEqual(existingConfiguration, expectedConfiguration)) {
          throw new Error(
            "Rivet installer: refusing to delete .github/rivet.json",
          );
        }
        const previousFiles = await buildMaintenanceVariant({
          stagingRoot: path.join(stagingRoot, "previous-maintenance"),
          mode,
          config: existingConfiguration,
          validation,
          binaryPath,
          compileWorkflow,
          validateWorkflow,
          env,
        });
        if (
          existingConfigurationContent !==
          previousFiles.get(".github/rivet.json")
        ) {
          throw new Error(
            "Rivet installer: refusing to delete .github/rivet.json",
          );
        }
        if (
          existingFiles.get(".github/rivet/installation.json") !==
          previousFiles.get(".github/rivet/installation.json")
        ) {
          throw new Error(
            "Rivet installer: refusing to delete .github/rivet/installation.json",
          );
        }
        for (const relativePath of MAINTENANCE_MANAGED_PATHS) {
          if (
            existingMaintenanceFiles.get(relativePath) !==
            previousFiles.get(relativePath)
          ) {
            throw new Error(
              `Rivet installer: refusing to delete ${relativePath}`,
            );
          }
        }
        baselines.push(previousFiles);
        maintenanceDeletionFiles = previousFiles;
      }
    }
    if (requiresUpgrade && config.maintenance.mode !== "disabled") {
      const existingConfigurationContent =
        existingFiles.get(".github/rivet.json");
      if (existingConfigurationContent !== null) {
        let existingConfiguration = null;
        try {
          existingConfiguration = validateRivetConfig(
            JSON.parse(existingConfigurationContent),
          );
        } catch {
          existingConfiguration = null;
        }
        const previousMaintenanceMode = existingConfiguration?.maintenance.mode;
        if (
          ["manual", "scheduled"].includes(previousMaintenanceMode) &&
          previousMaintenanceMode !== config.maintenance.mode
        ) {
          const previousConfiguration = structuredClone(config);
          previousConfiguration.maintenance.mode = previousMaintenanceMode;
          const previousFiles = await buildMaintenanceVariant({
            stagingRoot: path.join(stagingRoot, "previous-maintenance"),
            mode,
            config: previousConfiguration,
            validation,
            binaryPath,
            compileWorkflow,
            validateWorkflow,
            env,
          });
          if (
            existingConfigurationContent !==
              previousFiles.get(".github/rivet.json") ||
            existingFiles.get(".github/rivet/installation.json") !==
              previousFiles.get(".github/rivet/installation.json")
          ) {
            throw new Error(
              "Rivet installer: refusing to overwrite .github/rivet.json",
            );
          }
          for (const relativePath of MAINTENANCE_MANAGED_PATHS) {
            if (
              existingFiles.get(relativePath) !==
              previousFiles.get(relativePath)
            ) {
              throw new Error(
                `Rivet installer: refusing to overwrite ${relativePath}`,
              );
            }
          }
          baselines.push(previousFiles);
        }
      }
    }
    let reviewBaseline = null;
    if (requiresUpgrade && mode === "repair") {
      reviewBaseline = new Map(
        [...files].filter(
          ([relativePath]) =>
            !REPAIR_ASSET_PATHS.includes(relativePath) &&
            relativePath !== FIXER_IMPORT &&
            !relativePath.includes(`/${RIVET_REPAIR_WORKFLOW_ID}.`),
        ),
      );
      reviewBaseline.delete(".github/rivet/installation.json");
      completeInstallationFiles(reviewBaseline, {
        mode: "review",
        config: reviewConfig,
      });
      baselines.push(reviewBaseline);
    }
    if (requiresUpgrade && config.issues.triage === "automatic") {
      const previousFiles = withoutIssueTriage(files);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, { mode, config });
      baselines.push(previousFiles);
      if (mode === "repair") {
        const previousReview = withoutIssueTriage(reviewBaseline);
        previousReview.delete(".github/rivet/installation.json");
        completeInstallationFiles(previousReview, {
          mode: "review",
          config: reviewConfig,
        });
        baselines.push(previousReview);
      }
    }
    if (requiresUpgrade && config.maintenance.mode !== "disabled") {
      const previousConfig = structuredClone(config);
      previousConfig.maintenance.mode = "disabled";
      const previousFiles = withoutMaintenance(files);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, {
        mode,
        config: previousConfig,
      });
      baselines.push(previousFiles);
      if (mode === "repair") {
        const previousReviewConfig = structuredClone(reviewConfig);
        previousReviewConfig.maintenance.mode = "disabled";
        const previousReview = withoutMaintenance(reviewBaseline);
        previousReview.delete(".github/rivet/installation.json");
        completeInstallationFiles(previousReview, {
          mode: "review",
          config: previousReviewConfig,
        });
        baselines.push(previousReview);
      }
    }
    if (requiresUpgrade) {
      for (const { version, url } of PROFILED_REVIEW_EXTENSIONS) {
        const reviewExtension = await readFile(url, "utf8");
        const profiled = await buildWorkflowFiles({
          stagingRoot: path.join(stagingRoot, `profiled-${version}`),
          mode,
          config,
          reviewConfig,
          validation,
          binaryPath,
          compileWorkflow,
          validateWorkflow,
          env,
          profiles: true,
          includeIssueTriage: config.issues.triage === "automatic",
          includeMaintenance: config.maintenance.mode !== "disabled",
          reviewExtension,
          reviewWorkflowVersion: version,
        });
        const previousProfiled = withoutReviewContext(profiled);
        completeInstallationFiles(previousProfiled, { mode, config });
        baselines.push(previousProfiled);
        if (mode === "repair") {
          const profiledReview = await buildWorkflowFiles({
            stagingRoot: path.join(stagingRoot, `profiled-review-${version}`),
            mode: "review",
            config: reviewConfig,
            reviewConfig,
            validation,
            binaryPath,
            compileWorkflow,
            validateWorkflow,
            env,
            profiles: true,
            includeIssueTriage: reviewConfig.issues.triage === "automatic",
            includeMaintenance: reviewConfig.maintenance.mode !== "disabled",
            reviewExtension,
            reviewWorkflowVersion: version,
          });
          const previousProfiledReview = withoutReviewContext(profiledReview);
          completeInstallationFiles(previousProfiledReview, {
            mode: "review",
            config: reviewConfig,
          });
          baselines.push(previousProfiledReview);
        }
      }

      const profiledV013 = await buildWorkflowFiles({
        stagingRoot: path.join(stagingRoot, "profiled-v0.1.3"),
        mode,
        config,
        reviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
        profiles: true,
        includeIssueTriage: config.issues.triage === "automatic",
        includeMaintenance: config.maintenance.mode !== "disabled",
        includeReviewBudget: false,
        reviewExtension: await readFile(V013_REVIEW_EXTENSION, "utf8"),
      });
      const previousProfiledV013 = withoutReviewContext(profiledV013);
      completeInstallationFiles(previousProfiledV013, { mode, config });
      baselines.push(previousProfiledV013);

      const legacyReview = await buildWorkflowFiles({
        stagingRoot: path.join(stagingRoot, "legacy-review"),
        mode: "review",
        config: reviewConfig,
        reviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
        profiles: false,
        includeIssueTriage: false,
        includeMaintenance: false,
        reviewExtension: await readFile(V013_REVIEW_EXTENSION, "utf8"),
      });
      const previousLegacyReview = withoutReviewContext(legacyReview);
      completeInstallationFiles(previousLegacyReview, {
        mode: "review",
        config: reviewConfig,
      });
      baselines.push(previousLegacyReview);
    }
    if (requiresUpgrade && mode === "repair") {
      const legacyRepair = await buildWorkflowFiles({
        stagingRoot: path.join(stagingRoot, "legacy-repair"),
        mode: "repair",
        config,
        reviewConfig,
        validation,
        binaryPath,
        compileWorkflow,
        validateWorkflow,
        env,
        profiles: false,
        includeIssueTriage: false,
        includeMaintenance: false,
        reviewExtension: await readFile(V013_REVIEW_EXTENSION, "utf8"),
      });
      const previousLegacyRepair = withoutReviewContext(legacyRepair);
      completeInstallationFiles(previousLegacyRepair, { mode, config });
      baselines.push(previousLegacyRepair);
    }
    if (requiresUpgrade) {
      const relativePath =
        ".github/rivet/actions/prepare-review-context/index.mjs";
      const previousContent = await readFile(
        V013_PREPARE_REVIEW_CONTEXT,
        "utf8",
      );
      const previousFiles = new Map(files);
      previousFiles.set(relativePath, previousContent);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, { mode, config });
      baselines.push(previousFiles);
      for (const baseline of baselines) {
        baseline.set(relativePath, previousContent);
      }
    }
    if (requiresUpgrade && mode === "repair") {
      const relativePath = ".github/rivet/actions/publish-repair/index.mjs";
      const previousContent = await readFile(V012_PUBLISH_REPAIR, "utf8");
      const previousFiles = new Map(files);
      previousFiles.set(relativePath, previousContent);
      previousFiles.delete(".github/rivet/installation.json");
      completeInstallationFiles(previousFiles, { mode, config });
      baselines.push(previousFiles);
      for (const baseline of baselines) {
        if (baseline.has(relativePath))
          baseline.set(relativePath, previousContent);
      }
    }
    const compatibleBaselines = baselines.filter((baseline) =>
      [...files].every(([relativePath, content]) => {
        const current = existingFiles.get(relativePath);
        return (
          current === null ||
          current === content ||
          knownCompilerDrift(relativePath, current, content) ||
          matchesBaseline(relativePath, current, baseline)
        );
      }),
    );
    const plannedFiles = [];
    for (const [relativePath, content] of [...files].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const current = existingFiles.get(relativePath);
      const canUpgrade =
        current !== null &&
        (knownCompilerDrift(relativePath, current, content) ||
          compatibleBaselines.some((baseline) =>
            matchesBaseline(relativePath, current, baseline),
          ));
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
    if (maintenanceDeletionFiles) {
      for (const relativePath of MAINTENANCE_MANAGED_PATHS) {
        const current = maintenanceDeletionFiles.get(relativePath);
        plannedFiles.push({
          path: relativePath,
          status: "delete",
          previousSha256: digest(current),
          sha256: null,
          content: null,
        });
      }
      plannedFiles.sort(({ path: left }, { path: right }) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
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
