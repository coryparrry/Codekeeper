import { assertVerifiedModePlan, modeAdapter } from "./mode-adapters.mjs";
import { assertCredentialBoundary } from "./credential-boundaries.mjs";
import {
  createArtifactHandoff,
  createValidationArtifactHandoff,
  verifyArtifactHandoff,
} from "./artifact-handoff.mjs";

function required(value, name) {
  if (value === undefined || value === null || value === "")
    throw new Error(`${name} is required`);
  return value;
}

function adapterMode(mode) {
  return mode === "issues" ? "issue" : mode === "maintain" ? "audit" : mode;
}

export async function runValidate({
  mode,
  operation,
  plan,
  config,
  ...options
}) {
  assertCredentialBoundary("validate", {
    token: options.token ?? process.env.GITHUB_TOKEN,
    modelKey: process.env.CODEKEEPER_MODEL_API_KEY,
    traceKey: process.env.CODEKEEPER_TRACE_API_KEY,
    workspaceKey: process.env.CODEKEEPER_WORKSPACE_API_KEY,
  });
  const verifiedPlan = assertVerifiedModePlan(plan, mode, { config });
  const adapter = modeAdapter(verifiedPlan.resolvedMode);
  const translatedMode = adapterMode(verifiedPlan.resolvedMode);
  if (operation === "candidate") {
    if (typeof adapter.validate !== "function")
      throw new Error(`Mode ${mode} has no candidate validation adapter`);
    const result = await adapter.validate({
      ...options,
      mode: translatedMode,
      config,
    });
    const handoff = await createArtifactHandoff({
      sourceDirectory: options.artifactDirectory,
      modePlanPath: options.modePlanPath,
      configPath: options.configPath,
      config,
      toolingSha: options.toolingSha,
      workspaceResultPath: options.workspaceResultPath,
    });
    return { ...result, handoffManifestSha256: handoff.handoffManifestSha256 };
  }
  if (operation === "verify") {
    if (!verifiedPlan.validationRequired) {
      throw new Error(`Mode ${mode} does not authorize repository validation`);
    }
    if (typeof adapter.verify !== "function")
      throw new Error(`Mode ${mode} does not support a verification stage`);
    await verifyArtifactHandoff({
      sourceDirectory: options.candidateDirectory,
      expectedManifestSha256: options.expectedHandoffManifestSha256,
      expectedModePlanPath: options.modePlanPath,
      expectedPolicyPath: options.configPath,
      config,
      toolingSha: options.toolingSha,
      expectedKind: "compute",
    });
    const result = await adapter.verify({
      ...options,
      mode: translatedMode,
      config,
    });
    if (!result.validationReceipt) return result;
    const handoff = await createValidationArtifactHandoff({
      sourceDirectory: options.candidateDirectory,
      modePlanPath: options.modePlanPath,
      configPath: options.configPath,
      config,
      toolingSha: options.toolingSha,
    });
    return { ...result, handoffManifestSha256: handoff.handoffManifestSha256 };
  }
  if (operation === "seal") {
    if (
      verifiedPlan.validationRequired &&
      !options.expectedHandoffManifestSha256
    ) {
      throw new Error("Sealing requires a verified validation handoff");
    }
    if (typeof adapter.seal !== "function")
      throw new Error(`Mode ${mode} has no sealing adapter`);
    if (options.expectedHandoffManifestSha256) {
      await verifyArtifactHandoff({
        sourceDirectory: options.candidateDirectory,
        expectedManifestSha256: options.expectedHandoffManifestSha256,
        expectedModePlanPath: options.modePlanPath,
        expectedPolicyPath: options.configPath,
        config,
        toolingSha: options.toolingSha,
      });
    }
    return adapter.seal({ ...options, mode: translatedMode, config });
  }
  throw new Error(`Unknown validation operation: ${operation}`);
}
