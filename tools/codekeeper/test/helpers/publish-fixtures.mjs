import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubClient } from "../../src/lib/github.mjs";
import { AGENT_PROFILE_BUNDLE_FILE, AGENT_PROFILE_PATHS } from "../../src/lib/agent-profiles.mjs";
import { createValidationReceipt } from "../../src/lib/git.mjs";
import { sha256 } from "../../src/lib/markers.mjs";
import {
  publishAudit as publishAuditProduction,
  publishFix as publishFixProduction,
  publishIssue as publishIssueProduction,
  publishReview as publishReviewProduction
} from "../../src/lib/publish.mjs";

export const config = JSON.parse(
  await readFile(new URL("../../../../.github/codekeeper.json", import.meta.url), "utf8")
);
const profileFixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codekeeper-publish-domain-profiles-"));
export const profilePaths = {};
export const profileBytes = {};
for (const [mode, relativePath] of Object.entries(AGENT_PROFILE_PATHS)) {
  const filePath = path.join(profileFixtureRoot, relativePath);
  const bytes = Buffer.from(`# Test ${mode} profile\n\nUse frozen evidence only.\n`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  profilePaths[mode] = filePath;
  profileBytes[mode] = bytes;
}
test.after(() => rm(profileFixtureRoot, { recursive: true, force: true }));

export function publishReview(options) {
  return publishReviewProduction({ agentProfilePath: profilePaths.review, ...options });
}

export function publishAudit(options) {
  return publishAuditProduction({ agentProfilePath: profilePaths.audit, ...options });
}

export function publishIssue(options) {
  return publishIssueProduction({ agentProfilePath: profilePaths.issue, ...options });
}

export function publishFix(options) {
  return publishFixProduction({ agentProfilePath: profilePaths.fix, ...options });
}

const ambientGitHubEnvironment = ["GITHUB_REPOSITORY", "GITHUB_GRAPHQL_URL"].map((name) => [name, process.env[name]]);
for (const [name] of ambientGitHubEnvironment) delete process.env[name];
test.after(() => {
  for (const [name, value] of ambientGitHubEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

export const identity = { login: "codekeeper[bot]", id: "123456" };

export function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function replaceGitHubMethods(methods) {
  const originals = Object.fromEntries(Object.keys(methods).map((name) => [name, GitHubClient.prototype[name]]));
  Object.assign(GitHubClient.prototype, methods);
  return () => Object.assign(GitHubClient.prototype, originals);
}

export async function writeSealedArtifact(artifactDirectory, {
  mode,
  context,
  result,
  configSha256,
  patch = null,
  validation = { checks: [] },
  artifactConfig = config,
  agentProfile: suppliedAgentProfile
}) {
  const agentProfile = suppliedAgentProfile ?? profileBytes[mode];
  const patchBytes = patch?.valid ? await readFile(path.join(artifactDirectory, "patch.diff")) : null;
  const candidateSha256 = sha256(`fixture candidate ${mode}`);
  const effectiveValidation = patch?.valid
    ? {
        ...validation,
        receipt: createValidationReceipt({
          candidateSha256,
          configSha256,
          patchSha256: sha256(patchBytes),
          baseSha: context.baseSha,
          commands: artifactConfig.audit.repair.validationCommands.map((command) => ({
            command,
            exitCode: 0,
            durationMs: 1,
            stdoutDigest: sha256(`fixture output for ${command}`),
            startedAt: "2026-08-17T12:00:00.000Z",
          })),
          patchUnchanged: true,
        }),
      }
    : validation;
  context.agentProfile ??= {
    path: AGENT_PROFILE_PATHS[mode],
    sha256: sha256(agentProfile),
    sourceSha: "a".repeat(40)
  };
  const components = {
    context: Buffer.from(JSON.stringify(context)),
    result: Buffer.from(JSON.stringify(result)),
    config: Buffer.from(JSON.stringify(artifactConfig)),
    validation: Buffer.from(JSON.stringify(effectiveValidation)),
    "runtime-metadata": Buffer.from(JSON.stringify({
      mode,
      provider: "offline",
      model: "offline-fixture",
      attempt: 1,
      structuredOutputs: true,
      workspaceSpecialistUsed: true,
      maxTurns: 1,
      durationMs: 1,
      promptBytes: 1,
      evidenceBytes: 1,
      outputBytes: 1,
      cacheKey: "offline-fixture",
      cacheMode: "unsupported",
      usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
    })),
    [AGENT_PROFILE_BUNDLE_FILE]: agentProfile
  };
  await Promise.all(Object.entries(components).map(([name, bytes]) => writeFile(
    path.join(artifactDirectory, name === AGENT_PROFILE_BUNDLE_FILE ? name : `${name}.json`),
    bytes
  )));
  const manifest = {
    version: 3,
    sealed: true,
    mode,
    repository: context.repository,
    configSha256,
    context,
    patch,
    validation: effectiveValidation,
    candidateSha256,
    contextSha256: sha256(components.context),
    resultSha256: sha256(components.result),
    configFileSha256: sha256(components.config),
    validationSha256: sha256(components.validation),
    agentProfileSha256: sha256(agentProfile),
    runtimeMetadataSha256: sha256(components["runtime-metadata"]),
    patchSha256: patchBytes ? sha256(patchBytes) : null
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(artifactDirectory, "manifest.json"), manifestBytes);
  return { expectedManifestSha256: sha256(manifestBytes) };
}
