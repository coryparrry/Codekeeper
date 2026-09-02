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
    "b90a18b6fc411e9f874b9f3a04324359da8eb9021e733b2ca9aa337a8fcd7766",
    "0e310aacc5426f3ce4de0f21e0c3a704cd2f7c63485f4a4994f007e67b1366ec",
  ]),
  ".github/rivet/aw/review-extension.md": Object.freeze([
    "3629111bc1b10c64929714554a75a50e928dda3c916b60acb985c8f7b3ebe143",
    "25e12a512ffaefb949aeb7ebc7923af6fb209c05d64b75192e7286869543b7d1",
  ]),
  ".github/workflows/rivet-review.lock.yml": Object.freeze([
    "b906670fbab37182a4d2af0ba59061a3d428479bd2f35636f42edc9fe7b965f1",
    "ef6334e8b5052b31c97ae73e29bb36454d5604c9f297fd7ca4b042772a20ee9a",
    "e63cc7d069968d1fab8c898a53b678b2dd0706419d77280c3e53c7259cb5d8f0",
    "e84aa2b95ba285a8061732e5c2dd02d6f597e25b07b17c38cbdaf7979ae931f6",
    "50f232fc428504c79d7467cf1ccf492610870100622cb7f56a2a93c4dc1986c2",
    "b923c73eeea1f2f8cafc6b31e73a36748aa65fe4f18938607834679b62caa25c",
    "ff8a5f19bb6d046ea29b0e1c4d546a0c7ffadf2868f98bade178a3177080bad7",
    "a2d77a423d8abe5002594d17e464f683ab15db122416f04a79cabf7cc45bca82",
    "945d02b11e579ab6bef681dd5ce81e9100ac45512c9624be8f20200bd89465b9",
    "3f6595c8f87cf96e595e26f47f13724201c72bac17cbfb0b95102e23023d61ab",
    "14ff59291b091d3d949c147e7aa39030a4a8fb0f4682c37ebf52c78f4c5a59bb",
    "f976e07ccaf551848a9e426608da54bb18367fbcda647f453b39d5e745ea8672",
    "5af81b919c363900ba23936e154fbb1b7d4e57551c6a939c80545bcfad35fe85",
    "8a35e89f841f6ad58d054ad8bcab1389dfc3f1150e61a5f5bb6f37d96130eec9",
    "d5cd19bf40c56761cc20190b04add02d131c4abe3ca8481ae3ccc176a9aff7c4",
    "6856015d99a66ac241e9f5600a8bf5f8c67ae53f18d424f48f89c61a8c8dffdc",
    "df90ebc17e309862552507de83deb26cb1f56b40cab05d4b1831dbf25a21bc8e",
    "f21719f73a77e48f8ee8fff5bbc55281c5486786868048319e0051045d3acfd0",
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
  includeIssueTriage = false,
  issueTriageWorkflowVersion,
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
    includeIssueTriage,
    includeMaintenance: config.maintenance.mode !== "disabled",
    reviewExtension,
    reviewWorkflowVersion,
    includeReviewBudget,
    issueTriageWorkflowVersion,
  });
  const withoutContext = includeWithoutReviewContext
    ? withoutReviewContext(files)
    : null;
  completeInstallationFiles(files, { mode, config });
  if (!withoutContext) return [files];
  completeInstallationFiles(withoutContext, { mode, config });
  return [files, withoutContext];
}

export async function buildIssueTriageUpgradeBaselines(options) {
  const baselines = await buildBaselines({
    ...options,
    suffix: "previous-array-issue-triage",
    includeIssueTriage: true,
    issueTriageWorkflowVersion: "v0.1.13-array",
  });
  if (options.mode === "repair") {
    baselines.push(
      ...(await buildBaselines({
        ...options,
        mode: "review",
        config: options.reviewConfig,
        suffix: "previous-review-array-issue-triage",
        includeIssueTriage: true,
        issueTriageWorkflowVersion: "v0.1.13-array",
      })),
    );
  }
  baselines.push(
    ...(await buildBaselines({
      ...options,
      suffix: "previous-scalar-issue-triage",
      includeIssueTriage: true,
      issueTriageWorkflowVersion: "v0.1.13",
    })),
  );
  if (options.mode === "repair") {
    baselines.push(
      ...(await buildBaselines({
        ...options,
        mode: "review",
        config: options.reviewConfig,
        suffix: "previous-review-scalar-issue-triage",
        includeIssueTriage: true,
        issueTriageWorkflowVersion: "v0.1.13",
      })),
    );
  }
  const previousConfig = structuredClone(options.config);
  previousConfig.issues.triage = "disabled";
  const previousReviewConfig = structuredClone(options.reviewConfig);
  previousReviewConfig.issues.triage = "disabled";
  const common = {
    ...options,
    config: previousConfig,
    reviewConfig: previousReviewConfig,
  };
  baselines.push(
    ...(await buildBaselines({
      ...common,
      suffix: "previous-issue-triage",
    })),
  );
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
      ...(await buildIssueTriageUpgradeBaselines({
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
