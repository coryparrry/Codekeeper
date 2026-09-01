import { readFile } from "node:fs/promises";
import path from "node:path";
import { completeInstallationFiles } from "./installation-receipt.mjs";
import {
  buildWorkflowFiles,
  REVIEW_CONTEXT_ASSET_PATHS,
} from "./workflow-files.mjs";

const HISTORICAL_MANAGED_FILE_DIGESTS = Object.freeze({
  ".github/rivet/actions/prepare-review-context/index.mjs": Object.freeze([
    "375aa15b58e9cb04db91a56977ef3646a8aabda7493511b45b9dcbaeb13e666e",
  ]),
});
const SUMMARY_REVIEW_EXTENSION = new URL(
  "../assets/upgrades/v0.1.13/review-extension.md",
  import.meta.url,
);
const V013_REVIEW_EXTENSION = new URL(
  "../assets/upgrades/v0.1.3/review-extension.md",
  import.meta.url,
);

export const PROFILED_REVIEW_EXTENSIONS = Object.freeze(
  ["v0.1.13", "v0.1.11", "v0.1.9", "v0.1.7", "v0.1.5"].map((version) => ({
    version,
    url: new URL(
      `../assets/upgrades/${version}/review-extension.md`,
      import.meta.url,
    ),
  })),
);

export function matchesHistoricalManagedFile(relativePath, sha256) {
  return (
    HISTORICAL_MANAGED_FILE_DIGESTS[relativePath]?.includes(sha256) === true
  );
}

function withoutReviewContext(files) {
  const previous = new Map(files);
  for (const relativePath of REVIEW_CONTEXT_ASSET_PATHS) {
    previous.delete(relativePath);
  }
  return previous;
}

async function buildBaselines({
  mode,
  config,
  reviewConfig,
  stagingRoot,
  suffix,
  validation,
  binaryPath,
  compileWorkflow,
  validateWorkflow,
  env,
  reviewExtension,
  reviewWorkflowVersion,
  includeReviewBudget,
  profiles = true,
  includeWithoutReviewContext = false,
}) {
  const files = await buildWorkflowFiles({
    stagingRoot: path.join(stagingRoot, suffix),
    mode,
    config,
    reviewConfig,
    validation,
    binaryPath,
    compileWorkflow,
    validateWorkflow,
    env,
    profiles,
    includeIssueTriage: false,
    includeMaintenance: config.maintenance.mode !== "disabled",
    reviewExtension,
    reviewWorkflowVersion,
    includeReviewBudget,
  });
  const withoutContext = includeWithoutReviewContext
    ? withoutReviewContext(files)
    : null;
  completeInstallationFiles(files, { mode, config });
  if (!withoutContext) return [files];
  completeInstallationFiles(withoutContext, { mode, config });
  return [files, withoutContext];
}

export async function buildDisabledIssueTriageBaselines(options) {
  const previousConfig = structuredClone(options.config);
  previousConfig.issues.triage = "disabled";
  const previousReviewConfig = structuredClone(options.reviewConfig);
  previousReviewConfig.issues.triage = "disabled";
  const common = {
    ...options,
    config: previousConfig,
    reviewConfig: previousReviewConfig,
  };
  const baselines = await buildBaselines({
    ...common,
    suffix: "previous-issue-triage",
  });
  if (options.mode === "repair") {
    baselines.push(
      ...(await buildBaselines({
        ...common,
        mode: "review",
        config: previousReviewConfig,
        suffix: "previous-review-issue-triage",
      })),
    );
  }
  const summaryReviewExtension = await readFile(
    SUMMARY_REVIEW_EXTENSION,
    "utf8",
  );
  baselines.push(
    ...(await buildBaselines({
      ...common,
      suffix: "previous-review-summary",
      reviewExtension: summaryReviewExtension,
    })),
  );
  if (options.mode === "repair") {
    baselines.push(
      ...(await buildBaselines({
        ...common,
        mode: "review",
        config: previousReviewConfig,
        suffix: "previous-review-summary-review",
        reviewExtension: summaryReviewExtension,
      })),
    );
  }
  for (const { version, url } of PROFILED_REVIEW_EXTENSIONS) {
    const reviewExtension = await readFile(url, "utf8");
    baselines.push(
      ...(await buildBaselines({
        ...common,
        suffix: `profiled-disabled-issue-triage-${version}`,
        reviewExtension,
        reviewWorkflowVersion: version,
        includeWithoutReviewContext: true,
      })),
    );
    if (options.mode === "repair") {
      baselines.push(
        ...(await buildBaselines({
          ...common,
          mode: "review",
          config: previousReviewConfig,
          suffix: `profiled-review-disabled-issue-triage-${version}`,
          reviewExtension,
          reviewWorkflowVersion: version,
          includeWithoutReviewContext: true,
        })),
      );
    }
  }
  const v013ReviewExtension = await readFile(V013_REVIEW_EXTENSION, "utf8");
  baselines.push(
    ...(await buildBaselines({
      ...common,
      suffix: "profiled-disabled-issue-triage-v0.1.3",
      reviewExtension: v013ReviewExtension,
      includeReviewBudget: false,
      includeWithoutReviewContext: true,
    })),
  );
  if (options.mode === "repair") {
    baselines.push(
      ...(await buildBaselines({
        ...common,
        mode: "review",
        config: previousReviewConfig,
        suffix: "profiled-review-disabled-issue-triage-v0.1.3",
        reviewExtension: v013ReviewExtension,
        includeReviewBudget: false,
        includeWithoutReviewContext: true,
      })),
    );
  }
  if (options.config.maintenance.mode !== "disabled") {
    const previousMaintenanceConfig = structuredClone(options.config);
    previousMaintenanceConfig.maintenance.mode = "disabled";
    const previousMaintenanceReviewConfig = structuredClone(
      options.reviewConfig,
    );
    previousMaintenanceReviewConfig.maintenance.mode = "disabled";
    baselines.push(
      ...(await buildDisabledIssueTriageBaselines({
        ...options,
        stagingRoot: path.join(
          options.stagingRoot,
          "previous-maintenance-disabled",
        ),
        config: previousMaintenanceConfig,
        reviewConfig: previousMaintenanceReviewConfig,
      })),
    );
  }
  return baselines;
}
