import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../markers.mjs";
import { advanceEnvelope, createEnvelope } from "./envelope.mjs";
import {
  createHandoff,
  HANDOFF_ENVELOPE_FILE,
  HANDOFF_MANIFEST_FILE,
  verifyHandoff,
} from "./handoff.mjs";

const ARTIFACT_FILES = [
  "agent-profile.md",
  "candidate.json",
  "context.json",
  "result.json",
  "validation.json",
  "runtime-metadata.json",
];

const RUNTIME_MODE = Object.freeze({
  review: "review",
  issues: "issue",
  maintain: "audit",
  fix: "fix",
});

function workspaceIsDisabled(plan, config) {
  if (plan.workspaceAccess === "none") return true;
  const mode = RUNTIME_MODE[plan.resolvedMode];
  return config?.ai?.agents?.[mode]?.workspace?.enabled !== true;
}

async function requiredArtifactFile(directory, name) {
  const file = path.join(directory, name);
  const information = await lstat(file);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Artifact file is not regular: ${name}`);
  }
  return readFile(file);
}

async function requiredArtifactPath(file, name) {
  const information = await lstat(file);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Artifact file is not regular: ${name}`);
  }
  return readFile(file);
}

function trustedSourceCommit({ toolingSha, context }) {
  const candidates = [
    toolingSha,
    context.toolingSha,
    process.env.CODEKEEPER_TOOLING_SHA,
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const distinct = [...new Set(candidates.map((value) => value.toLowerCase()))];
  if (distinct.length > 1) {
    throw new Error(
      "Trusted package source commit does not match the frozen context",
    );
  }
  const sourceCommit = candidates[0] ?? "";
  if (!/^[a-f0-9]{40,64}$/i.test(sourceCommit)) {
    throw new Error(
      "Trusted package source commit is required for the handoff envelope",
    );
  }
  return sourceCommit;
}

async function optionalArtifactFile(directory, name) {
  try {
    return await requiredArtifactFile(directory, name);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function artifactExpectedFiles(hasPatch, hasValidation = false) {
  const files = [
    HANDOFF_ENVELOPE_FILE,
    ...ARTIFACT_FILES,
    "mode-plan.json",
    "policy.json",
    "profile.json",
    "workspace-result.json",
  ];
  if (hasPatch) files.push("patch.diff");
  if (hasValidation) files.push("validation-receipt.json");
  return files;
}

async function artifactEnvelope({
  modePlanBytes,
  policyBytes,
  profileBytes,
  contextBytes,
  workspaceBytes,
  candidateBytes,
  config,
  toolingSha,
}) {
  const context = JSON.parse(contextBytes.toString("utf8"));
  const plan = JSON.parse(modePlanBytes.toString("utf8"));
  const repository = context.repository ?? process.env.GITHUB_REPOSITORY;
  const baseSha = context.baseSha ?? context.pullRequest?.baseSha;
  const headSha = context.pullRequest?.headSha ?? null;
  const packageVersion = String(
    process.env.CODEKEEPER_PACKAGE_VERSION ?? "",
  ).trim();
  const packageIntegrity = String(
    process.env.CODEKEEPER_PACKAGE_INTEGRITY ?? "",
  ).trim();
  if (!packageVersion || !packageIntegrity) {
    throw new Error(
      "Verified package version and integrity are required for the handoff envelope",
    );
  }
  const sourceCommit = trustedSourceCommit({ toolingSha, context });
  const created = createEnvelope({
    mode: plan.resolvedMode,
    run: {
      repository,
      runId: process.env.GITHUB_RUN_ID ?? "local-run",
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    },
    package: {
      name: "@coryparry/codekeeper",
      version: packageVersion,
      integrity: packageIntegrity,
      sourceCommit,
    },
    request: {
      eventName: process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch",
      targetNumber:
        context.target?.number ??
        context.issue?.number ??
        context.pullRequest?.number ??
        null,
      requestedBy:
        context.requestedBy ?? process.env.GITHUB_ACTOR ?? "codekeeper",
    },
    repository: {
      defaultBranch: config.repository.defaultBranch,
      baseSha,
      headSha,
    },
    digests: {
      modePlan: sha256(modePlanBytes),
      policy: sha256(policyBytes),
      profile: sha256(profileBytes),
      context: sha256(contextBytes),
    },
  });
  return advanceEnvelope(created, "compute-complete", {
    digests: {
      workspaceResult: sha256(workspaceBytes),
      candidate: sha256(candidateBytes),
    },
  });
}

export async function createArtifactHandoff({
  sourceDirectory,
  modePlanPath,
  configPath,
  config,
  toolingSha,
  workspaceResultPath,
}) {
  const modePlanBytes = await readFile(modePlanPath);
  const plan = JSON.parse(modePlanBytes.toString("utf8"));
  const policyBytes = await readFile(configPath);
  const contextBytes = await requiredArtifactFile(
    sourceDirectory,
    "context.json",
  );
  const candidateBytes = await requiredArtifactFile(
    sourceDirectory,
    "candidate.json",
  );
  const profileBytes = await requiredArtifactFile(
    sourceDirectory,
    "agent-profile.md",
  );
  const workspaceDisabled = workspaceIsDisabled(plan, config);
  const workspaceBytes = workspaceDisabled
    ? Buffer.from('{"skipped":true}\n', "utf8")
    : workspaceResultPath
      ? await requiredArtifactPath(workspaceResultPath, "workspace-result")
      : ((await optionalArtifactFile(
          sourceDirectory,
          "workspace-result.json",
        )) ?? Buffer.from('{"skipped":true}\n', "utf8"));
  const patchBytes = await optionalArtifactFile(sourceDirectory, "patch.diff");
  const sourceFiles = [];
  for (const name of ARTIFACT_FILES)
    sourceFiles.push({
      path: name,
      contents: await requiredArtifactFile(sourceDirectory, name),
    });
  if (patchBytes)
    sourceFiles.push({ path: "patch.diff", contents: patchBytes });
  sourceFiles.push(
    { path: "mode-plan.json", contents: modePlanBytes },
    { path: "policy.json", contents: policyBytes },
    { path: "profile.json", contents: profileBytes },
    { path: "workspace-result.json", contents: workspaceBytes },
  );
  const envelope = await artifactEnvelope({
    modePlanBytes,
    policyBytes,
    profileBytes,
    contextBytes,
    workspaceBytes,
    candidateBytes,
    config,
    toolingSha,
  });
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-handoff-"),
  );
  try {
    const expectedFiles = artifactExpectedFiles(Boolean(patchBytes));
    const result = await createHandoff({
      directory: temporary,
      envelope,
      kind: "compute",
      files: sourceFiles,
      expectedFiles,
    });
    for (const name of [
      HANDOFF_ENVELOPE_FILE,
      HANDOFF_MANIFEST_FILE,
      "mode-plan.json",
      "policy.json",
      "profile.json",
      "workspace-result.json",
    ]) {
      await writeFile(
        path.join(sourceDirectory, name),
        await readFile(path.join(temporary, name)),
        { flag: "wx" },
      );
    }
    return { ...result, handoffManifestSha256: result.manifestSha256 };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createValidationArtifactHandoff({
  sourceDirectory,
  modePlanPath,
  configPath,
  config,
  toolingSha,
}) {
  const modePlanBytes = await requiredArtifactFile(
    sourceDirectory,
    "mode-plan.json",
  );
  const policyBytes = await requiredArtifactFile(
    sourceDirectory,
    "policy.json",
  );
  const contextBytes = await requiredArtifactFile(
    sourceDirectory,
    "context.json",
  );
  const candidateBytes = await requiredArtifactFile(
    sourceDirectory,
    "candidate.json",
  );
  const profileBytes = await requiredArtifactFile(
    sourceDirectory,
    "profile.json",
  );
  const workspaceBytes = await requiredArtifactFile(
    sourceDirectory,
    "workspace-result.json",
  );
  const receiptBytes = await requiredArtifactFile(
    sourceDirectory,
    "validation-receipt.json",
  );
  const patchBytes = await optionalArtifactFile(sourceDirectory, "patch.diff");
  const compute = await artifactEnvelope({
    modePlanBytes,
    policyBytes,
    profileBytes,
    contextBytes,
    workspaceBytes,
    candidateBytes,
    config,
    toolingSha,
  });
  const envelope = advanceEnvelope(compute, "validation-complete", {
    validationRequired: true,
    digests: { validationReceipt: sha256(receiptBytes) },
  });
  const files = [];
  for (const name of ARTIFACT_FILES)
    files.push({
      path: name,
      contents: await requiredArtifactFile(sourceDirectory, name),
    });
  if (patchBytes) files.push({ path: "patch.diff", contents: patchBytes });
  files.push(
    { path: "mode-plan.json", contents: modePlanBytes },
    { path: "policy.json", contents: policyBytes },
    { path: "profile.json", contents: profileBytes },
    { path: "workspace-result.json", contents: workspaceBytes },
    { path: "validation-receipt.json", contents: receiptBytes },
  );
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-validation-handoff-"),
  );
  try {
    const result = await createHandoff({
      directory: temporary,
      envelope,
      kind: "validation",
      files,
      expectedFiles: artifactExpectedFiles(Boolean(patchBytes), true),
    });
    await rm(path.join(sourceDirectory, HANDOFF_ENVELOPE_FILE), {
      force: true,
    });
    await rm(path.join(sourceDirectory, HANDOFF_MANIFEST_FILE), {
      force: true,
    });
    for (const name of [HANDOFF_ENVELOPE_FILE, HANDOFF_MANIFEST_FILE]) {
      await writeFile(
        path.join(sourceDirectory, name),
        await readFile(path.join(temporary, name)),
        { flag: "wx" },
      );
    }
    return { ...result, handoffManifestSha256: result.manifestSha256 };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyArtifactHandoff({
  sourceDirectory,
  expectedManifestSha256,
  expectedKind = undefined,
  expectedModePlanPath,
  expectedPolicyPath,
  config,
  toolingSha,
}) {
  const modePlanBytes = await requiredArtifactFile(
    sourceDirectory,
    "mode-plan.json",
  );
  const policyBytes = await requiredArtifactFile(
    sourceDirectory,
    "policy.json",
  );
  if (
    expectedModePlanPath &&
    sha256(
      await requiredArtifactPath(expectedModePlanPath, "expected mode plan"),
    ) !== sha256(modePlanBytes)
  ) {
    throw new Error(
      "Handoff mode plan does not match the independently resolved plan",
    );
  }
  if (
    expectedPolicyPath &&
    sha256(
      await requiredArtifactPath(expectedPolicyPath, "expected policy"),
    ) !== sha256(policyBytes)
  ) {
    throw new Error(
      "Handoff policy does not match the frozen repository policy",
    );
  }
  const contextBytes = await requiredArtifactFile(
    sourceDirectory,
    "context.json",
  );
  const candidateBytes = await requiredArtifactFile(
    sourceDirectory,
    "candidate.json",
  );
  const profileBytes = await requiredArtifactFile(
    sourceDirectory,
    "profile.json",
  );
  const workspaceBytes = await requiredArtifactFile(
    sourceDirectory,
    "workspace-result.json",
  );
  const patchBytes = await optionalArtifactFile(sourceDirectory, "patch.diff");
  const receiptBytes = await optionalArtifactFile(
    sourceDirectory,
    "validation-receipt.json",
  );
  const compute = await artifactEnvelope({
    modePlanBytes,
    policyBytes,
    profileBytes,
    contextBytes,
    workspaceBytes,
    candidateBytes,
    config,
    toolingSha,
  });
  const envelope = receiptBytes
    ? advanceEnvelope(compute, "validation-complete", {
        validationRequired: true,
        digests: { validationReceipt: sha256(receiptBytes) },
      })
    : compute;
  const kind = expectedKind ?? (receiptBytes ? "validation" : "compute");
  return verifyHandoff({
    directory: sourceDirectory,
    expectedEnvelope: envelope,
    expectedKind: kind,
    expectedManifestSha256,
    expectedFiles: artifactExpectedFiles(
      Boolean(patchBytes),
      Boolean(receiptBytes),
    ),
  });
}
