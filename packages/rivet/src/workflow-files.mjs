import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  renderRivetIssueTriageWorkflow,
  renderRivetIssueTriageWorkflowV013,
  renderRivetIssueTriageWorkflowV013Array,
  RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS,
  RIVET_ISSUE_TRIAGE_WORKFLOW_ID,
} from "./workflows/issue-triage.mjs";
import {
  renderRivetMaintenanceWorkflow,
  RIVET_MAINTENANCE_NATIVE_IMPORTS,
  RIVET_MAINTENANCE_WORKFLOW_ID,
} from "./workflows/maintenance.mjs";
import {
  renderRivetRepairWorkflow,
  renderRivetRepairWorkflowV012,
  RIVET_REPAIR_NATIVE_IMPORTS,
  RIVET_REPAIR_WORKFLOW_ID,
} from "./workflows/repair.mjs";
import {
  renderRivetReviewWorkflow,
  renderRivetReviewWorkflowV0111,
  renderRivetReviewWorkflowV0113,
  renderRivetReviewWorkflowV017,
  renderRivetReviewWorkflowV019,
  renderRivetReviewWorkflowV012,
  RIVET_REVIEW_NATIVE_IMPORTS,
  RIVET_REVIEW_WORKFLOW_ID,
} from "./workflows/review.mjs";

const AGENT_ASSET_ROOT = new URL("../assets/agents/", import.meta.url);
const ISSUE_ASSET_ROOT = new URL("../assets/issue/", import.meta.url);
const REVIEW_ASSET_ROOT = new URL("../assets/review/", import.meta.url);
const REVIEW_EXTENSION_IMPORT = RIVET_REVIEW_NATIVE_IMPORTS[1];
const REPAIR_ASSET_ROOT = new URL("../assets/repair/", import.meta.url);
const MAINTENANCE_ASSET_ROOT = new URL(
  "../assets/maintenance/",
  import.meta.url,
);
export const REVIEW_CONTEXT_ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/prepare-review-context/action.yml",
  ".github/rivet/actions/prepare-review-context/index.mjs",
]);
export const ISSUE_CONTEXT_ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/prepare-issue-context/action.yml",
  ".github/rivet/actions/prepare-issue-context/index.mjs",
]);
const REVIEW_ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/authority-receipt/action.yml",
  ".github/rivet/actions/authority-receipt/index.mjs",
  ...REVIEW_CONTEXT_ASSET_PATHS,
  REVIEW_EXTENSION_IMPORT,
]);
export const REPAIR_ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/publish-repair/action.yml",
  ".github/rivet/actions/publish-repair/index.mjs",
  ".github/rivet/actions/validate-repair/action.yml",
  ".github/rivet/actions/validate-repair/index.mjs",
]);
export const MAINTENANCE_ASSET_PATHS = Object.freeze([
  ".github/rivet/actions/validate-audit/action.yml",
  ".github/rivet/actions/validate-audit/index.mjs",
]);

async function writeNewFiles(root, files) {
  for (const [relativePath, content] of files) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx", mode: 0o644 });
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
async function agentProfile(name) {
  return readFile(new URL(name, AGENT_ASSET_ROOT), "utf8");
}

export async function buildWorkflowFiles({
  stagingRoot,
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
  includeMaintenance,
  includeReviewBudget = profiles,
  includeAutoTagging = true,
  includeFailureSafePendingTags = true,
  reviewExtension,
  reviewWorkflowVersion,
  issueTriageWorkflowVersion,
}) {
  const files = await assetFiles(REVIEW_ASSET_PATHS, REVIEW_ASSET_ROOT);
  if (reviewExtension) {
    files.set(REVIEW_EXTENSION_IMPORT, reviewExtension);
  }
  if (profiles) {
    files.set(
      RIVET_REVIEW_NATIVE_IMPORTS[0],
      await agentProfile("pr-reviewer.md"),
    );
  }
  files.set(
    `.github/workflows/${RIVET_REVIEW_WORKFLOW_ID}.md`,
    profiles
      ? reviewWorkflowVersion === "v0.1.11"
        ? renderRivetReviewWorkflowV0111({ configuration: reviewConfig })
        : reviewWorkflowVersion === "v0.1.13"
          ? renderRivetReviewWorkflowV0113({ configuration: reviewConfig })
          : reviewWorkflowVersion === "v0.1.9"
            ? renderRivetReviewWorkflowV019({ configuration: reviewConfig })
            : reviewWorkflowVersion === "v0.1.5" ||
                reviewWorkflowVersion === "v0.1.7"
              ? renderRivetReviewWorkflowV017({ configuration: reviewConfig })
              : renderRivetReviewWorkflow({
                  nativeImports: RIVET_REVIEW_NATIVE_IMPORTS,
                  configuration: reviewConfig,
                  includeReviewBudget,
                  includeAutoTagging,
                  includeFailureSafePendingTags,
                })
      : renderRivetReviewWorkflowV012({ configuration: reviewConfig }),
  );
  if (includeIssueTriage) {
    for (const [relativePath, content] of await assetFiles(
      ISSUE_CONTEXT_ASSET_PATHS,
      ISSUE_ASSET_ROOT,
    )) {
      files.set(relativePath, content);
    }
    files.set(
      RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS[0],
      await agentProfile("issue-triager.md"),
    );
    files.set(
      `.github/workflows/${RIVET_ISSUE_TRIAGE_WORKFLOW_ID}.md`,
      issueTriageWorkflowVersion === "v0.1.13"
        ? renderRivetIssueTriageWorkflowV013({ configuration: config })
        : issueTriageWorkflowVersion === "v0.1.13-array"
          ? renderRivetIssueTriageWorkflowV013Array({ configuration: config })
          : renderRivetIssueTriageWorkflow({ configuration: config }),
    );
  }
  if (includeMaintenance) {
    for (const [relativePath, content] of await assetFiles(
      MAINTENANCE_ASSET_PATHS,
      MAINTENANCE_ASSET_ROOT,
    )) {
      files.set(relativePath, content);
    }
    files.set(
      RIVET_MAINTENANCE_NATIVE_IMPORTS[0],
      await agentProfile("repository-auditor.md"),
    );
    files.set(
      `.github/workflows/${RIVET_MAINTENANCE_WORKFLOW_ID}.md`,
      renderRivetMaintenanceWorkflow({ configuration: config }),
    );
  }
  if (mode === "repair") {
    for (const [relativePath, content] of await assetFiles(
      REPAIR_ASSET_PATHS,
      REPAIR_ASSET_ROOT,
    )) {
      files.set(relativePath, content);
    }
    if (profiles) {
      files.set(RIVET_REPAIR_NATIVE_IMPORTS[0], await agentProfile("fixer.md"));
    }
    files.set(
      `.github/workflows/${RIVET_REPAIR_WORKFLOW_ID}.md`,
      profiles
        ? renderRivetRepairWorkflow({
            nativeImports: RIVET_REPAIR_NATIVE_IMPORTS,
            validation,
          })
        : renderRivetRepairWorkflowV012({ validation }),
    );
  }
  await writeNewFiles(stagingRoot, files);
  const workflowIds = [
    RIVET_REVIEW_WORKFLOW_ID,
    ...(includeIssueTriage ? [RIVET_ISSUE_TRIAGE_WORKFLOW_ID] : []),
    ...(includeMaintenance ? [RIVET_MAINTENANCE_WORKFLOW_ID] : []),
    ...(mode === "repair" ? [RIVET_REPAIR_WORKFLOW_ID] : []),
  ];
  for (const workflowId of workflowIds) {
    await validateWorkflow({
      repositoryRoot: stagingRoot,
      workflowId,
      binaryPath,
      env,
    });
    await compileWorkflow({
      repositoryRoot: stagingRoot,
      workflowId,
      binaryPath,
      env,
    });
    const lockPath = `.github/workflows/${workflowId}.lock.yml`;
    files.set(
      lockPath,
      await readFile(path.join(stagingRoot, lockPath), "utf8"),
    );
  }
  return files;
}
