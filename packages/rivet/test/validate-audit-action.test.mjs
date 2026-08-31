import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  runValidateAuditAction,
  validateAuditOutput,
} from "../assets/maintenance/.github/rivet/actions/validate-audit/index.mjs";

const headSha = "a".repeat(40);
const event = {
  repository: { full_name: "owner/repository", default_branch: "main" },
};
const audit = {
  headSha,
  sourceRef: "refs/heads/main",
  summary: "The default branch audit completed with current evidence.",
  findings: [
    {
      id: "audit-dependency-drift",
      path: "package-lock.json",
      problemKey: "dependency-lock-drift",
      title: "Dependency drift is documented",
      category: "dependencies",
      priority: "P2",
      evidence: "The lockfile and manifest disagree on one resolved range.",
      recommendation: "Fix the lockfile drift after owner review.",
    },
  ],
};
const validOutput = JSON.stringify({
  items: [
    {
      type: "validate_audit",
      audit: JSON.stringify(audit),
    },
  ],
  errors: [],
});
test("writes one bounded seven-day audit artifact and receipt", async () => {
  const written = new Map();
  const receipt = await runValidateAuditAction({
    env: {
      GITHUB_EVENT_PATH: "/event.json",
      GH_AW_AGENT_OUTPUT: "/output.json",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: headSha,
      RIVET_AUDIT_ARTIFACT: "/runner/rivet-audit",
    },
    readFileImpl: async (filePath) =>
      filePath === "/event.json" ? JSON.stringify(event) : validOutput,
    writeFileImpl: async (filePath, content) => written.set(filePath, content),
    mkdirImpl: async () => {},
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  const artifact = written.get("/runner/rivet-audit/audit.json");
  assert.equal(receipt.headSha, headSha);
  assert.equal(receipt.expiresAt, "2026-09-07T00:00:00.000Z");
  assert.equal(
    receipt.artifactSha256,
    createHash("sha256").update(artifact).digest("hex"),
  );
  assert.match(artifact, /"schemaVersion":1/);
  assert.match(
    written.get("/runner/rivet-audit/receipt.json"),
    /artifactSha256/,
  );
});

test("rejects an audit that is not bound to the default-branch head", () => {
  assert.throws(
    () =>
      validateAuditOutput({
        event,
        agentOutput: validOutput.replace(headSha, "b".repeat(40)),
        expectedHeadSha: headSha,
        expectedRef: "refs/heads/main",
      }),
    /head SHA does not match/,
  );
  assert.throws(
    () =>
      validateAuditOutput({
        event,
        agentOutput: validOutput,
        expectedHeadSha: headSha,
        expectedRef: "refs/heads/feature",
      }),
    /default branch/,
  );
});

test("accepts the declared maximum finding ID length", () => {
  const atLimit = JSON.parse(validOutput);
  atLimit.items[0].audit = JSON.stringify({
    ...audit,
    findings: [
      {
        ...audit.findings[0],
        id: `audit-${"a".repeat(64)}`,
      },
    ],
  });
  assert.doesNotThrow(() =>
    validateAuditOutput({
      event,
      agentOutput: JSON.stringify(atLimit),
      expectedHeadSha: headSha,
      expectedRef: "refs/heads/main",
    }),
  );

  atLimit.items[0].audit = JSON.stringify({
    ...audit,
    findings: [
      {
        ...audit.findings[0],
        id: `audit-${"a".repeat(65)}`,
      },
    ],
  });
  assert.throws(
    () =>
      validateAuditOutput({
        event,
        agentOutput: JSON.stringify(atLimit),
        expectedHeadSha: headSha,
        expectedRef: "refs/heads/main",
      }),
    /bounded string/,
  );
});

test("rejects sensitive, security, malformed, and unbounded output", () => {
  for (const replacement of [
    [
      "The default branch audit completed with current evidence.",
      "token: ghp_12345678901234567890",
    ],
    [
      "The default branch audit completed with current evidence.",
      "A vulnerability was found and must be privately handled.",
    ],
    [
      "The default branch audit completed with current evidence.",
      "Credentials and private keys were exposed.",
    ],
    [
      "The default branch audit completed with current evidence.",
      "Several vulnerable paths were found.",
    ],
    [
      "Fix the lockfile drift after owner review.",
      "Record the exploitable changes for owner review.",
    ],
    [
      "Fix the lockfile drift after owner review.",
      "The private key is exposed as value hunter2.",
    ],
    [
      '\\\"category\\\":\\\"dependencies\\\"',
      '\\\"category\\\":\\\"security\\\"',
    ],
  ]) {
    assert.throws(
      () =>
        validateAuditOutput({
          event,
          agentOutput: validOutput.replace(...replacement),
          expectedHeadSha: headSha,
          expectedRef: "refs/heads/main",
        }),
      /(?:sensitive content|security-sensitive)/,
    );
  }
  assert.throws(
    () =>
      validateAuditOutput({
        event,
        agentOutput: JSON.stringify({ items: [], errors: [] }),
        expectedHeadSha: headSha,
        expectedRef: "refs/heads/main",
      }),
    /exactly one item/,
  );
  const tooMany = JSON.parse(validOutput);
  const unboundedAudit = JSON.parse(tooMany.items[0].audit);
  unboundedAudit.findings = Array.from({ length: 21 }, (_, index) => ({
    id: `audit-finding-${index}`,
    title: "Finding",
    category: "quality",
    priority: "P3",
    evidence: "Evidence",
    recommendation: "Record for owner review.",
  }));
  tooMany.items[0].audit = JSON.stringify(unboundedAudit);
  assert.throws(
    () =>
      validateAuditOutput({
        event,
        agentOutput: JSON.stringify(tooMany),
        expectedHeadSha: headSha,
        expectedRef: "refs/heads/main",
      }),
    /unbounded or malformed/,
  );

  const duplicate = JSON.parse(validOutput);
  const duplicateAudit = JSON.parse(duplicate.items[0].audit);
  duplicateAudit.findings.push(duplicateAudit.findings[0]);
  duplicate.items[0].audit = JSON.stringify(duplicateAudit);
  assert.throws(
    () =>
      validateAuditOutput({
        event,
        agentOutput: JSON.stringify(duplicate),
        expectedHeadSha: headSha,
        expectedRef: "refs/heads/main",
      }),
    /must be unique/,
  );
});
