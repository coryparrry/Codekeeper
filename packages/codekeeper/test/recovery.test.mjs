import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGitHubRepository,
  parseRecoveryArgs,
  parseRecoveryBranches,
  requiredRecoverySecrets,
  requiredRecoveryVariables,
  recoveryFingerprint
} from "../src/recovery.mjs";

test("recovery arguments are explicit and bounded", () => {
  assert.deepEqual(parseRecoveryArgs([]), { apply: false, json: false, branch: null });
  assert.deepEqual(parseRecoveryArgs(["--apply", "--json", "--branch", "codekeeper/update-0123456789ab"]), {
    apply: true,
    json: true,
    branch: "codekeeper/update-0123456789ab"
  });
  assert.throws(() => parseRecoveryArgs(["--branch", "main"]), /Codekeeper setup or update branch/);
  assert.throws(() => parseRecoveryArgs(["--force"]), /Unsupported resume option/);
});

test("GitHub origins and recovery refs are parsed without accepting adjacent hosts or branches", () => {
  assert.equal(parseGitHubRepository("https://github.com/example/repo.git"), "example/repo");
  assert.equal(parseGitHubRepository("git@github.com:example/repo.git"), "example/repo");
  assert.throws(() => parseGitHubRepository("https://github.example.com/example/repo.git"), /GitHub.com/);
  assert.deepEqual(
    parseRecoveryBranches([
      "0123456789abcdef0123456789abcdef01234567\trefs/heads/codekeeper/setup",
      "89abcdef0123456789abcdef0123456789abcdef\trefs/heads/codekeeper/update-0123456789ab",
      "fedcba9876543210fedcba9876543210fedcba98\trefs/heads/feature/other"
    ].join("\n")),
    [
      { branch: "codekeeper/setup", sha: "0123456789abcdef0123456789abcdef01234567" },
      { branch: "codekeeper/update-0123456789ab", sha: "89abcdef0123456789abcdef0123456789abcdef" }
    ]
  );
});

test("required recovery credentials follow the committed policy and workflow inventory", () => {
  const policy = {
    ai: {
      tracing: { enabled: true },
      agents: {
        review: { provider: "openai", workspace: { enabled: true } },
        issue: { provider: "deepseek", workspace: { enabled: false } }
      }
    },
    automation: { ownerRequests: true }
  };
  const manifest = {
    managedFiles: {
      ".github/codekeeper.json": "a".repeat(64),
      ".github/workflows/codekeeper-review.yml": "b".repeat(64),
      ".github/workflows/codekeeper-issues.yml": "c".repeat(64)
    }
  };
  assert.deepEqual(requiredRecoverySecrets(policy, manifest), [
    "CODEKEEPER_APP_PRIVATE_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_TRACE_API_KEY"
  ]);
  assert.deepEqual(requiredRecoveryVariables(policy, manifest), [
    "CODEKEEPER_APP_CLIENT_ID",
    "CODEKEEPER_AUTOMATION_BOT_LOGIN",
    "CODEKEEPER_ENABLED"
  ]);
});

test("recovery fingerprint changes with durable remote state", () => {
  const base = {
    repository: "example/repo",
    branch: "codekeeper/setup",
    remoteSha: "0".repeat(40),
    pullRequestUrl: null,
    missingSecrets: ["OPENAI_API_KEY"],
    missingVariables: [],
    invalidVariables: []
  };
  const first = recoveryFingerprint(base);
  const second = recoveryFingerprint({ ...base, remoteSha: "1".repeat(40) });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});
