import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_PROFILE_BUNDLE_FILE,
  AGENT_PROFILE_PATHS,
} from "../src/lib/agent-profiles.mjs";
import { runWorkspaceAgentFromBundle } from "../src/lib/agents-runtime.mjs";
import { GitHubClient } from "../src/lib/github.mjs";
import { sha256 } from "../src/lib/markers.mjs";
import {
  renderDeferredIssue,
  renderMaintenanceIssue,
  sanitizeMarkdown,
  sanitizePublicTitle,
} from "../src/lib/render.mjs";
import {
  SECURITY_FINDING_WITHHELD_CODE,
  SECURITY_FINDING_WITHHELD_MESSAGE,
  assertNoPublicSecurityFindings,
  containsCredentialShapedValue,
  containsSecuritySensitivePhrase,
  redactCredentialShapedValues,
} from "../src/lib/security-containment.mjs";
import { publishAudit } from "../src/lib/publish.mjs";
import { sealAudit } from "../src/lib/validate.mjs";

const config = JSON.parse(
  await readFile(
    new URL("../../../.github/codekeeper.json", import.meta.url),
    "utf8",
  ),
);
const fakeToken = "ghp_0123456789abcdefghijklmnopqrst";
const exploitText = "Run the exploit against the privileged endpoint.";

function auditFinding(category, suffix = category) {
  return {
    title: `${suffix} finding ${fakeToken} for @security-team`,
    evidence: `Credential ${fakeToken}. ${exploitText}`,
    category,
    priority: "p1",
    owningPath: "src/auth.mjs",
    problemKey: `${suffix}-finding`,
    proposedAction: `Notify @security-team and rotate token=${fakeToken}.`,
    labels: [],
  };
}

function auditResult({ mixed = false, repair = false } = {}) {
  const findings = [
    ...(mixed ? [auditFinding("bug", "ordinary")] : []),
    auditFinding("security"),
  ];
  const securityIndex = findings.length - 1;
  return {
    mode: "audit",
    summary: "The audit found sensitive evidence.",
    findings,
    repair: repair
      ? {
          requested: true,
          findingIndex: securityIndex,
          title: "fix: repair the security finding",
          body: "Apply the security repair.",
          risk: "high",
          validationSummary: "A focused security test passed.",
        }
      : {
          requested: false,
          findingIndex: null,
          title: "",
          body: "",
          risk: "low",
          validationSummary: "",
        },
    noActionReason: null,
  };
}

function ordinaryFinding(overrides = {}) {
  return {
    title: "Ordinary maintenance finding",
    evidence: "The generated documentation is stale.",
    category: "bug",
    priority: "p2",
    owningPath: "README.md",
    problemKey: "ordinary-maintenance-finding",
    proposedAction: "Update the documentation.",
    labels: [],
    ...overrides,
  };
}

function ordinaryAuditResult(overrides = {}) {
  return {
    mode: "audit",
    summary: "One ordinary maintenance finding.",
    findings: [ordinaryFinding()],
    repair: {
      requested: false,
      findingIndex: null,
      title: "",
      body: "",
      risk: "low",
      validationSummary: "",
    },
    noActionReason: null,
    ...overrides,
  };
}

function runtimeMetadata() {
  return {
    mode: "audit",
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
    usage: {
      requests: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    },
  };
}

async function assertMissing(filePath) {
  await assert.rejects(access(filePath), { code: "ENOENT" });
}

function assertGenericWithheld(error) {
  assert.equal(error.code, SECURITY_FINDING_WITHHELD_CODE);
  assert.equal(error.message, SECURITY_FINDING_WITHHELD_MESSAGE);
  const visibleError = `${error.name}: ${error.message}\n${error.stack ?? ""}`;
  assert.doesNotMatch(visibleError, new RegExp(fakeToken, "i"));
  assert.doesNotMatch(visibleError, /exploit|@security-team/i);
}

async function writeComponents(directory, components) {
  await Promise.all(
    Object.entries(components).map(([name, bytes]) =>
      writeFile(
        path.join(
          directory,
          name === AGENT_PROFILE_BUNDLE_FILE ? name : `${name}.json`,
        ),
        bytes,
      ),
    ),
  );
}

test("credential-bearing workspace audits leave no result artifact despite an ordinary category", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-security-workspace-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = path.join(directory, "workspace-result.json");
  await Promise.all([
    writeFile(
      path.join(directory, "workspace-prompt.md"),
      "Audit the repository.\n",
    ),
    writeFile(
      path.join(directory, "schema.json"),
      JSON.stringify({ type: "object" }),
    ),
    writeFile(
      path.join(directory, "context.json"),
      JSON.stringify({ mode: "audit", repairAuthorized: false }),
    ),
  ]);

  class FakeMCPServerStdio {
    async connect() {}
    async close() {
      throw new Error(`cleanup exposed ${fakeToken}`);
    }
    async listTools() {
      return [{ name: "codex" }];
    }
    async callToolResult() {
      const result = ordinaryAuditResult({
        summary: "Found AWS_SECRET_ACCESS_KEY=x in generated configuration.",
      });
      return {
        structuredContent: {
          content: JSON.stringify(result),
        },
        content: [],
      };
    }
  }

  const workspaceConfig = structuredClone(config);
  workspaceConfig.ai.tracing.enabled = false;
  workspaceConfig.ai.agents.audit.workspace.enabled = true;
  let caught;
  try {
    await runWorkspaceAgentFromBundle({
      mode: "audit",
      directory,
      config: workspaceConfig,
      resultPath,
      apiKey: "workspace-secret",
      environment: {
        CODEX_HOME: path.join(directory, "codex-home"),
        PATH: "/usr/bin",
      },
      sdkLoader: async () => ({ MCPServerStdio: FakeMCPServerStdio }),
      codexAuthenticator: async () => {},
    });
  } catch (error) {
    caught = error;
  }
  assertGenericWithheld(caught);
  await assertMissing(resultPath);
  await assertMissing(path.join(directory, "workspace-runtime-metadata.json"));
});

test("exploit-ready authentication bypass text leaves no workspace artifact", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-security-phrase-workspace-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = path.join(directory, "workspace-result.json");
  await Promise.all([
    writeFile(
      path.join(directory, "workspace-prompt.md"),
      "Audit the repository.\n",
    ),
    writeFile(
      path.join(directory, "schema.json"),
      JSON.stringify({ type: "object" }),
    ),
    writeFile(
      path.join(directory, "context.json"),
      JSON.stringify({ mode: "audit", repairAuthorized: false }),
    ),
  ]);
  const result = ordinaryAuditResult({
    findings: [
      ordinaryFinding({
        title: "Authentication bypass permits administrative access",
        evidence:
          "Send X-Original-Role: admin on the request to bypass authorization.",
      }),
    ],
  });

  class FakeMCPServerStdio {
    async connect() {}
    async close() {}
    async listTools() {
      return [{ name: "codex" }];
    }
    async callToolResult() {
      return {
        structuredContent: { content: JSON.stringify(result) },
        content: [],
      };
    }
  }

  const workspaceConfig = structuredClone(config);
  workspaceConfig.ai.tracing.enabled = false;
  workspaceConfig.ai.agents.audit.workspace.enabled = true;
  let caught;
  try {
    await runWorkspaceAgentFromBundle({
      mode: "audit",
      directory,
      config: workspaceConfig,
      resultPath,
      apiKey: "workspace-secret",
      environment: {
        CODEX_HOME: path.join(directory, "codex-home"),
        PATH: "/usr/bin",
      },
      sdkLoader: async () => ({ MCPServerStdio: FakeMCPServerStdio }),
      codexAuthenticator: async () => {},
    });
  } catch (error) {
    caught = error;
  }
  assertGenericWithheld(caught);
  assert.doesNotMatch(caught.stack ?? "", /X-Original-Role|administrative access/i);
  await assertMissing(resultPath);
  await assertMissing(path.join(directory, "workspace-runtime-metadata.json"));
});

test("sealing rejects a forged security-labelled repair before artifact creation", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-security-candidate-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const candidateDirectory = path.join(root, "candidate");
  const artifactDirectory = path.join(root, "sealed");
  await mkdir(candidateDirectory);
  const configSha256 = "c".repeat(64);
  const agentProfile = Buffer.from(
    "# Repository auditor\n\nUse frozen evidence only.\n",
  );
  const contextValue = {
    mode: "audit",
    repository: process.env.GITHUB_REPOSITORY ?? "owner/repository",
    configSha256,
    baseSha: "b".repeat(40),
    repairAuthorized: true,
    agentProfile: {
      source: "repository",
      path: AGENT_PROFILE_PATHS.audit,
      sha256: sha256(agentProfile),
      sourceSha: "a".repeat(40),
    },
  };
  const result = ordinaryAuditResult({
    findings: [ordinaryFinding({ labels: ["codekeeper:type-security"] })],
    repair: {
      requested: true,
      findingIndex: 0,
      title: "fix: repair the labelled finding",
      body: "Apply the bounded repair.",
      risk: "high",
      validationSummary: "A focused test passed.",
    },
  });
  const validation = { checks: ["head", "patch-policy"] };
  const components = {
    context: Buffer.from(JSON.stringify(contextValue)),
    result: Buffer.from(JSON.stringify(result)),
    validation: Buffer.from(JSON.stringify(validation)),
    "runtime-metadata": Buffer.from(JSON.stringify(runtimeMetadata())),
    [AGENT_PROFILE_BUNDLE_FILE]: agentProfile,
  };
  await writeComponents(candidateDirectory, components);
  const candidate = {
    version: 2,
    mode: "audit",
    repository: contextValue.repository,
    patch: null,
    validation,
    contextSha256: sha256(components.context),
    resultSha256: sha256(components.result),
    patchSha256: null,
    validationSha256: sha256(components.validation),
    agentProfileSha256: sha256(agentProfile),
    runtimeMetadataSha256: sha256(components["runtime-metadata"]),
  };
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  await writeFile(
    path.join(candidateDirectory, "candidate.json"),
    candidateBytes,
  );

  let caught;
  try {
    await sealAudit({
      candidateDirectory,
      artifactDirectory,
      expectedCandidateSha256: sha256(candidateBytes),
      expectedContextSha256: sha256(components.context),
      config,
      configSha256,
    });
  } catch (error) {
    caught = error;
  }
  assertGenericWithheld(caught);
  await assertMissing(artifactDirectory);
});

test("publication rejects a forged sealed credential-bearing audit before GitHub access", async (context) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codekeeper-security-publish-"),
  );
  context.after(() => rm(root, { recursive: true, force: true }));
  const artifactDirectory = path.join(root, "artifact");
  const profilePath = path.join(root, AGENT_PROFILE_PATHS.audit);
  await Promise.all([
    mkdir(artifactDirectory),
    mkdir(path.dirname(profilePath), { recursive: true }),
  ]);
  const configSha256 = "d".repeat(64);
  const agentProfile = Buffer.from(
    "# Repository auditor\n\nUse frozen evidence only.\n",
  );
  await writeFile(profilePath, agentProfile);
  const contextValue = {
    mode: "audit",
    repository: process.env.GITHUB_REPOSITORY ?? "owner/repository",
    configSha256,
    baseSha: "b".repeat(40),
    runUrl: "https://example.test/run",
    repairAuthorized: false,
    agentProfile: {
      source: "repository",
      path: AGENT_PROFILE_PATHS.audit,
      sha256: sha256(agentProfile),
      sourceSha: "a".repeat(40),
    },
  };
  const result = ordinaryAuditResult({
    noActionReason: "The configured database is postgres://admin:p@db.internal/app.",
  });
  const validation = { checks: [] };
  const components = {
    context: Buffer.from(JSON.stringify(contextValue)),
    result: Buffer.from(JSON.stringify(result)),
    config: Buffer.from(JSON.stringify(config)),
    validation: Buffer.from(JSON.stringify(validation)),
    "runtime-metadata": Buffer.from(JSON.stringify(runtimeMetadata())),
    [AGENT_PROFILE_BUNDLE_FILE]: agentProfile,
  };
  await writeComponents(artifactDirectory, components);
  const manifest = {
    version: 3,
    sealed: true,
    mode: "audit",
    repository: contextValue.repository,
    context: contextValue,
    patch: null,
    validation,
    candidateSha256: sha256("forged-candidate"),
    configSha256,
    contextSha256: sha256(components.context),
    resultSha256: sha256(components.result),
    configFileSha256: sha256(components.config),
    validationSha256: sha256(components.validation),
    agentProfileSha256: sha256(agentProfile),
    runtimeMetadataSha256: sha256(components["runtime-metadata"]),
    patchSha256: null,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(path.join(artifactDirectory, "manifest.json"), manifestBytes);

  let githubCalls = 0;
  const originalBegin = GitHubClient.prototype.beginBranchMutation;
  const originalList = GitHubClient.prototype.listMaintenanceIssues;
  GitHubClient.prototype.beginBranchMutation = async () => {
    githubCalls += 1;
  };
  GitHubClient.prototype.listMaintenanceIssues = async () => {
    githubCalls += 1;
    return [];
  };
  context.after(() => {
    GitHubClient.prototype.beginBranchMutation = originalBegin;
    GitHubClient.prototype.listMaintenanceIssues = originalList;
  });

  let caught;
  try {
    await publishAudit({
      artifactDirectory,
      config,
      configSha256,
      expectedManifestSha256: sha256(manifestBytes),
      agentProfilePath: profilePath,
      agentProfileSourceSha: contextValue.agentProfile.sourceSha,
      token: "unused-token",
    });
  } catch (error) {
    caught = error;
  }
  assertGenericWithheld(caught);
  assert.equal(githubCalls, 0);
});

test("ordinary public findings redact credentials and neutralize only untrusted mentions", () => {
  const finding = auditFinding("bug", "ordinary");
  const fingerprint = "f".repeat(64);
  const title = sanitizePublicTitle(`[AI maintenance] ${finding.title}`);
  const body = renderMaintenanceIssue(finding, fingerprint);
  const deferred = renderDeferredIssue({
    feedback: {
      explanation: "Ask @security-team to inspect the token.",
      validation: "The credential remains in generated output.",
      type: "maintenance",
    },
    pullRequest: { number: 7, url: "https://example.test/pull/7" },
    sources: [
      {
        sourceKey: "review:1",
        url: "https://example.test/review/1",
        author: "@trusted-maintainer",
      },
    ],
    marker: "<!-- codekeeper:trusted-marker -->",
  });

  for (const rendered of [title, body]) {
    assert.doesNotMatch(rendered, new RegExp(fakeToken, "i"));
    assert.match(rendered, /\[REDACTED\]/);
    assert.match(rendered, /@\u200bsecurity-team/);
  }
  assert.match(
    body,
    new RegExp(`<!-- codekeeper:fingerprint=${fingerprint} -->$`),
  );
  assert.match(deferred, /@\u200bsecurity-team/);
  assert.match(deferred, /@trusted-maintainer/);
  assert.match(deferred, /<!-- codekeeper:trusted-marker -->$/);
});

test("audit containment inspects labels and credentials in every publishable text surface", () => {
  const cases = [
    ordinaryAuditResult({ summary: "AWS_SECRET_ACCESS_KEY=x" }),
    ordinaryAuditResult({
      findings: [ordinaryFinding({ evidence: "Connect to https://user:p@internal.example." })],
    }),
    ordinaryAuditResult({
      repair: {
        requested: false,
        findingIndex: null,
        title: "",
        body: "STRIPE_SECRET_KEY=short",
        risk: "low",
        validationSummary: "",
      },
    }),
    ordinaryAuditResult({ noActionReason: "password=p" }),
    ordinaryAuditResult({
      findings: [ordinaryFinding({ labels: ["codekeeper:type-security"] })],
    }),
  ];
  for (const result of cases) {
    assert.throws(
      () => assertNoPublicSecurityFindings(result),
      (error) => {
        assertGenericWithheld(error);
        return true;
      },
    );
  }
});

test("the shared detector and renderer redact conservative credential forms", () => {
  const credentials = [
    "AWS_SECRET_ACCESS_KEY=x",
    "STRIPE_SECRET_KEY=short",
    "password=p",
    "postgres://root:p@db.internal/app",
    "Authorization: Bearer abcdefgh",
    fakeToken,
  ];
  for (const credential of credentials) {
    assert.equal(containsCredentialShapedValue(credential), true);
    for (const redacted of [
      redactCredentialShapedValues(credential),
      sanitizeMarkdown(credential),
    ]) {
      assert.match(redacted, /\[REDACTED\]/);
      assert.equal(containsCredentialShapedValue(redacted), false);
    }
  }
  assert.equal(containsCredentialShapedValue("Token budget: 1000"), false);
});

test("security-sensitive phrase detection covers exploit-ready finding families", () => {
  const phrases = [
    "Authentication bypass permits administrative access",
    "Send X-Original-Role: admin to bypass authorization",
    "The untrusted header permits administrative access",
    "The session flaw enables account takeover",
    "The request allows privilege escalation to root",
    "The payload enables remote code execution",
    "The parameter is vulnerable to SQL injection",
    "The callback permits SSRF",
    "Reflected cross-site scripting is exploitable",
    "The archive permits path traversal",
    "A proof-of-concept exploit reaches the internal service",
  ];
  for (const phrase of phrases) {
    assert.equal(containsSecuritySensitivePhrase(phrase), true, phrase);
  }
  assert.equal(
    containsSecuritySensitivePhrase(
      "Authentication documentation explains the ordinary login flow.",
    ),
    false,
  );
});

test("title truncation cannot reactivate a neutralized mention or leave inline code open", () => {
  const mention = sanitizePublicTitle("12345 @security-team follow-up", 13);
  assert.match(mention, /@\u200b/);
  assert.doesNotMatch(mention, /@security-team/);
  assert.equal((mention.match(/`/g) ?? []).length % 2, 0);

  const issueReference = sanitizePublicTitle("12345 closes #42 follow-up", 16);
  assert.equal((issueReference.match(/`/g) ?? []).length % 2, 0);
  assert.doesNotMatch(issueReference, /closes\s+#42/i);
});
