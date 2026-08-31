import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";
import {
  assessIssueTriageTrust,
  assessMaintenanceTrust,
  assessPullRequestTargetTrust,
  RIVET_MAINTENANCE_ACTIONS_SHA256,
  RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256,
  RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256,
} from "../src/gh-aw/trust.mjs";
import { RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT } from "../src/workflows/issue-triage.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const NATIVE_IMPORTS = [
  ".github/rivet/agents/pr-reviewer.md",
  ".github/rivet/aw/review-extension.md",
];
const LOCAL_ACTION = "./.github/rivet/actions/authority-receipt";
const MAINTENANCE_LOCAL_ACTION = "./.github/rivet/actions/validate-audit";
test("rejects maintenance mutation authority and non-default checkouts", async () => {
  const compiled = await maintenanceFixtureAuthority("scheduled");
  const authority = {
    ...compiled,
    triggers: ["schedule"],
    additionalRepositories: ["other/repository"],
    writeCapableJobs: [{ job: "publish", permissions: { issues: "write" } }],
    checkouts: [
      {
        repository: "other/repository",
        ref: "main",
        path: null,
        persistCredentials: true,
      },
    ],
  };
  const trust = assessMaintenanceTrust({
    authority,
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedModel: "gpt-5.6-luna",
    expectedTriggers: ["schedule", "workflow_dispatch"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
  });
  assert.deepEqual(trust, {
    trusted: false,
    baseContext: "maintenance default branch",
    violations: [
      "maintenance trigger differs from the approved inventory",
      "additional repository checkouts are not allowed",
      "checkouts must use the default branch without persisted credentials",
      "only conclusion may use workflow write authority for cancellation",
    ],
  });
});

async function maintenanceFixtureAuthority(mode) {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      `test/fixtures/maintenance/rivet-maintenance-${mode}.lock.yml.gz.b64`,
    ),
    "utf8",
  );
  return inspectCompiledWorkflow(
    gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"),
  );
}

test("accepts the pinned manual and scheduled maintenance authorities", async () => {
  for (const mode of ["manual", "scheduled"]) {
    const authority = await maintenanceFixtureAuthority(mode);
    const trust = assessMaintenanceTrust({
      authority,
      expectedActionsSha256: RIVET_MAINTENANCE_ACTIONS_SHA256,
      expectedJobAuthoritySha256: RIVET_MAINTENANCE_JOB_AUTHORITY_SHA256,
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/repository-auditor.md"],
      expectedJobConditionsSha256: RIVET_MAINTENANCE_JOB_CONDITIONS_SHA256,
      expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
      expectedModel: "gpt-5.6-luna",
      expectedTriggers:
        mode === "scheduled"
          ? ["schedule", "workflow_dispatch"]
          : ["workflow_dispatch"],
    });
    assert.equal(trust.trusted, true, trust.violations.join("; "));
  }
});

test("rejects maintenance action, script, secret, and condition drift", async () => {
  const authority = await maintenanceFixtureAuthority("manual");
  for (const [change, violation] of [
    [
      {
        actions: authority.actions.map((action, index) =>
          index === 0
            ? { ...action, with: { ...action.with, destination: "/tmp/other" } }
            : action,
        ),
      },
      "maintenance actions differ from the approved inventory",
    ],
    [
      {
        scripts: authority.scripts.map((script, index) =>
          index === 0
            ? { ...script, run: `${script.run}\necho changed` }
            : script,
        ),
      },
      "maintenance actions differ from the approved inventory",
    ],
    [
      {
        secrets: [...authority.secrets, "EXTRA_TOKEN"].sort(),
        manifestSecrets: [...authority.manifestSecrets, "EXTRA_TOKEN"].sort(),
      },
      "maintenance secrets differ from the approved inventory",
    ],
    [
      {
        jobConditions: {
          ...authority.jobConditions,
          agent: { ...authority.jobConditions.agent, if: null },
        },
      },
      "maintenance job conditions differ from the approved inventory",
    ],
  ]) {
    const trust = assessMaintenanceTrust({
      authority: { ...authority, ...change },
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/repository-auditor.md"],
      expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
      expectedModel: "gpt-5.6-luna",
      expectedTriggers: ["workflow_dispatch"],
    });
    assert.deepEqual(trust.violations, [violation]);
  }
});

test("rejects maintenance runner, container, permission, env, and service drift", async () => {
  const authority = await maintenanceFixtureAuthority("manual");
  const changes = [
    ["agent", "runsOn", "self-hosted"],
    ["agent", "container", "ubuntu:latest"],
    ["agent", "permissions", { "*": "read" }],
    ["agent", "env", { ...authority.jobAuthority.agent.env, UNTRUSTED: "1" }],
    ["agent", "services", { database: { image: "postgres:latest" } }],
  ];
  for (const [job, field, value] of changes) {
    const jobAuthority = structuredClone(authority.jobAuthority);
    jobAuthority[job][field] = value;
    const trust = assessMaintenanceTrust({
      authority: { ...authority, jobAuthority },
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/repository-auditor.md"],
      expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
      expectedModel: "gpt-5.6-luna",
      expectedTriggers: ["workflow_dispatch"],
    });
    assert.deepEqual(
      trust.violations,
      [
        "maintenance runner, container, permissions, environment, or services differ from the approved inventory",
      ],
      `${job}.${field} drift must fail closed`,
    );
  }
});

test("rejects maintenance workflow and deployment environment drift", async () => {
  const authority = await maintenanceFixtureAuthority("manual");
  const workflowEnv = { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" };
  const workflowTrust = assessMaintenanceTrust({
    authority: { ...authority, workflowEnv },
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
    expectedModel: "gpt-5.6-luna",
    expectedTriggers: ["workflow_dispatch"],
  });
  assert.deepEqual(workflowTrust.violations, [
    "maintenance runner, container, permissions, environment, or services differ from the approved inventory",
  ]);

  const jobAuthority = structuredClone(authority.jobAuthority);
  jobAuthority.agent.environment = "production";
  const jobTrust = assessMaintenanceTrust({
    authority: { ...authority, jobAuthority },
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/repository-auditor.md"],
    expectedLocalActions: [MAINTENANCE_LOCAL_ACTION],
    expectedModel: "gpt-5.6-luna",
    expectedTriggers: ["workflow_dispatch"],
  });
  assert.deepEqual(jobTrust.violations, workflowTrust.violations);
});

async function compiledAuthority() {
  const source = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test",
      "fixtures",
      "review",
      ".github",
      "workflows",
      "rivet-review.lock.yml",
    ),
    "utf8",
  );
  return { source, authority: inspectCompiledWorkflow(source) };
}

async function issueTriageAuthority() {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
    ),
    "utf8",
  );
  return inspectCompiledWorkflow(
    gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"),
  );
}

test("accepts pinned incoming issue-triage authority", async () => {
  const trust = assessIssueTriageTrust({
    authority: await issueTriageAuthority(),
    expectedEngine: "codex",
    expectedImports: [".github/rivet/agents/issue-triager.md"],
    expectedModel: "gpt-5.6-luna",
    expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  });
  assert.deepEqual(trust, {
    trusted: true,
    baseContext: "issues event default branch",
    violations: [],
  });
});

test("rejects expanded issue-triage trigger, import, and write authority", async () => {
  const authority = await issueTriageAuthority();
  for (const [change, violation] of [
    [
      { triggers: ["issues", "workflow_dispatch"] },
      "workflow must use only issues",
    ],
    [
      {
        resolvedImports: [
          ...authority.resolvedImports,
          ".github/rivet/aw/unreviewed-extension.md",
        ],
      },
      "resolved native imports must contain only issue-triager",
    ],
    [
      {
        writeCapableJobs: authority.writeCapableJobs.map((job) =>
          job.job === "conclusion"
            ? {
                ...job,
                permissions: { actions: "write", contents: "write" },
              }
            : job,
        ),
      },
      "only conclusion may use workflow write authority for cancellation",
    ],
    [
      {
        actions: authority.actions.map((action) =>
          action.action === "actions/create-github-app-token"
            ? {
                ...action,
                with: { ...action.with, repositories: "other" },
              }
            : action,
        ),
      },
      "issue triage publisher must target only the triggering repository and issue",
    ],
  ]) {
    const trust = assessIssueTriageTrust({
      authority: { ...authority, ...change },
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/issue-triager.md"],
      expectedModel: "gpt-5.6-luna",
      expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
    });
    assert.equal(trust.trusted, false);
    assert.deepEqual(trust.violations, [violation]);
  }
});

test("accepts the self-contained base-branch Rivet review authority", async () => {
  const { source, authority } = await compiledAuthority();
  const trust = assessPullRequestTargetTrust({
    authority,
    expectedImports: NATIVE_IMPORTS,
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.deepEqual(trust, {
    trusted: true,
    baseContext: "pull_request_target default branch",
    violations: [],
  });
  assert.match(source, /Rivet review contract/);
  assert.match(source, /actively try to disprove it/);
  assert.match(source, /GH_AW_MAX_TURNS: 6/);
  assert.match(source, /needs\.agent\.result == 'success'/);
  assert.match(source, /"toolTimeout": 240/);
  assert.ok(
    source.indexOf("- name: Checkout repository") <
      source.indexOf("name: Record Rivet authority receipt"),
  );
  assert.match(source, /Tools: create_issue,/);
  assert.match(source, /permission-issues: write/);
  assert.match(source, /permission-pull-requests: write/);
  assert.doesNotMatch(
    source,
    /permission-(?:actions|contents|deployments|discussions|packages|statuses): write/,
  );
});

test("rejects PR-head prompt loading and mutable action authority", async () => {
  const { authority } = await compiledAuthority();
  const untrusted = {
    ...authority,
    runtimeImports: [".github/workflows/rivet-review.md"],
    unpinnedActions: [{ uses: "owner/action@main" }],
    unpinnedContainers: [{ image: "owner/image:latest" }],
    jobConditions: {
      ...authority.jobConditions,
      safe_outputs: { ...authority.jobConditions.safe_outputs, if: null },
    },
    checkouts: authority.checkouts.map((checkout, index) =>
      index === 0
        ? { ...checkout, ref: "${{ github.event.pull_request.head.sha }}" }
        : checkout,
    ),
  };
  const trust = assessPullRequestTargetTrust({
    authority: untrusted,
    expectedImports: NATIVE_IMPORTS,
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "runtime prompt imports are not allowed",
    "all actions must use immutable commit pins",
    "all containers must use immutable digest pins",
    "review publication requires a successful agent run",
    "checkouts must use the base context without persisted credentials",
  ]);
});

test("rejects a native import inventory change without approval", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessPullRequestTargetTrust({
    authority,
    expectedImports: [
      ...NATIVE_IMPORTS,
      ".github/rivet/aw/unreviewed-extension.md",
    ],
    expectedLocalActions: [LOCAL_ACTION],
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "resolved native imports differ from the approved inventory",
  ]);
});

test("rejects an unapproved local extension action", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessPullRequestTargetTrust({
    authority,
    expectedImports: NATIVE_IMPORTS,
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "local actions differ from the approved inventory",
  ]);
});
