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
  RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE,
  RIVET_REVIEW_AUTHORITY_SHA256_BY_ENGINE,
  RIVET_REVIEW_DISABLED_AUTHORITY_SHA256_BY_ENGINE,
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
const LOCAL_ACTIONS = [
  "./.github/rivet/actions/authority-receipt",
  "./.github/rivet/actions/prepare-review-context",
];
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

async function disabledCompiledAuthority() {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/review/rivet-review-disabled.lock.yml.gz.b64",
    ),
    "utf8",
  );
  const source = gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
  return { source, authority: inspectCompiledWorkflow(source) };
}

function assessReview(authority, options = {}) {
  return assessPullRequestTargetTrust({
    authority,
    expectedEngine: "codex",
    expectedImports: NATIVE_IMPORTS,
    expectedLocalActions: LOCAL_ACTIONS,
    expectedModel: "gpt-5.6-luna",
    ...options,
  });
}

async function issueTriageAuthority(engine = "codex") {
  const encoded = await readFile(
    path.join(
      PACKAGE_ROOT,
      `test/fixtures/issue-triage/rivet-issue-triage${engine === "codex" ? "" : `-${engine}`}.lock.yml.gz.b64`,
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

test("accepts Gemini's engine-specific issue-triage authority", async () => {
  const trust = assessIssueTriageTrust({
    authority: await issueTriageAuthority("gemini"),
    expectedEngine: "gemini",
    expectedImports: [".github/rivet/agents/issue-triager.md"],
    expectedModel: "gemini-review-model",
    expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  });
  assert.equal(trust.trusted, true, trust.violations.join("; "));
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
    const expected = [violation];
    if (change.resolvedImports) {
      // Import drift has a dedicated, more useful diagnostic.
    } else if (change.actions) {
      expected.unshift(
        "issue triage workflow differs from the approved authority inventory",
      );
    }
    assert.deepEqual(trust.violations, expected);
  }
});

test("binds the complete issue-triage authority graph", async () => {
  const authority = await issueTriageAuthority();
  const mutations = [
    ["trigger config", { triggerConfig: { issues: { types: ["closed"] } } }],
    ["root permissions", { permissions: { contents: "write" } }],
    [
      "concurrency",
      { concurrency: { ...authority.concurrency, "cancel-in-progress": true } },
    ],
    [
      "job conditions",
      {
        jobConditions: {
          ...authority.jobConditions,
          agent: { ...authority.jobConditions.agent, needs: ["activation"] },
        },
      },
    ],
    [
      "job authority",
      {
        jobAuthority: {
          ...structuredClone(authority.jobAuthority),
          detection: {
            ...structuredClone(authority.jobAuthority.detection),
            permissions: { contents: "write" },
          },
        },
      },
    ],
    [
      "pinned action",
      {
        actions: [
          ...authority.actions,
          { ...authority.actions[0], job: "agent", id: "injected" },
        ],
      },
    ],
    [
      "shell step",
      {
        scripts: [
          ...authority.scripts,
          {
            ...authority.scripts[0],
            job: "agent",
            id: "injected",
            run: "echo injected",
          },
        ],
      },
    ],
    [
      "container",
      {
        containers: [
          ...authority.containers,
          {
            image: "trusted",
            digest: "sha256:" + "0".repeat(64),
            pinned_image: "trusted@sha256:" + "0".repeat(64),
          },
        ],
      },
    ],
  ];
  for (const [label, change] of mutations) {
    const trust = assessIssueTriageTrust({
      authority: { ...authority, ...change },
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/issue-triager.md"],
      expectedModel: "gpt-5.6-luna",
      expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
    });
    assert.deepEqual(
      trust.violations,
      ["issue triage workflow differs from the approved authority inventory"],
      `${label} drift must fail closed`,
    );
  }
});

test("binds issue-triage model authority and secrets", async () => {
  const authority = await issueTriageAuthority();
  const mutations = [
    [
      { workflowEnv: { TOKEN: "${{ secrets.RIVET_APP_PRIVATE_KEY }}" } },
      "issue triage workflow environment must remain empty",
    ],
    [
      {
        jobAuthority: {
          ...structuredClone(authority.jobAuthority),
          agent: {
            ...structuredClone(authority.jobAuthority.agent),
            env: {
              ...authority.jobAuthority.agent.env,
              RIVET_APP_PRIVATE_KEY: "${{ secrets.RIVET_APP_PRIVATE_KEY }}",
            },
          },
        },
      },
      "issue triage workflow differs from the approved authority inventory",
    ],
    [
      {
        secrets: [...authority.secrets, "EXTRA_TOKEN"].sort(),
        manifestSecrets: [...authority.manifestSecrets, "EXTRA_TOKEN"].sort(),
      },
      "issue triage secrets differ from the approved inventory",
    ],
  ];
  for (const [change, violation] of mutations) {
    const trust = assessIssueTriageTrust({
      authority: { ...authority, ...change },
      expectedEngine: "codex",
      expectedImports: [".github/rivet/agents/issue-triager.md"],
      expectedModel: "gpt-5.6-luna",
      expectedPublisherScript: RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
    });
    const expected = [violation];
    if (change.workflowEnv) {
      expected.unshift(
        "issue triage workflow differs from the approved authority inventory",
      );
    }
    assert.deepEqual(trust.violations, expected);
  }
});

test("accepts the self-contained base-branch Rivet review authority", async () => {
  const { source, authority } = await compiledAuthority();
  const trust = assessReview(authority);
  assert.deepEqual(trust, {
    trusted: true,
    baseContext: "pull_request_target default branch",
    violations: [],
  });
  assert.match(source, /Rivet review contract/);
  assert.match(source, /actively try to disprove it/);
  assert.match(source, /GH_AW_MAX_TURNS: 3/);
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

test("binds disabled issue triage to its exact review authority", async () => {
  const { source, authority } = await disabledCompiledAuthority();
  assert.equal(
    assessReview(authority, { expectedIssueTriage: "disabled" }).trusted,
    true,
  );
  assert.deepEqual(assessReview(authority).violations, [
    "review workflow differs from the approved inventory",
  ]);
  assert.deepEqual(
    assessReview((await compiledAuthority()).authority, {
      expectedIssueTriage: "disabled",
    }).violations,
    ["review workflow differs from the approved inventory"],
  );
  const unknownMode = assessReview(authority, {
    expectedIssueTriage: "owner",
    expectedReviewAuthoritySha256:
      RIVET_REVIEW_DISABLED_AUTHORITY_SHA256_BY_ENGINE.codex,
  });
  assert.equal(unknownMode.trusted, false);
  assert.match(unknownMode.violations.join("; "), /issue triage mode/);
  assert.doesNotMatch(source, /Tools: create_issue,/);
  assert.doesNotMatch(source, /permission-issues: write/);
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
  const trust = assessReview(untrusted);
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "runtime prompt imports are not allowed",
    "all actions must use immutable commit pins",
    "all containers must use immutable digest pins",
    "review workflow differs from the approved inventory",
    "checkouts must use the base context without persisted credentials",
  ]);
});

test("rejects a native import inventory change without approval", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessReview(authority, {
    expectedImports: [
      ...NATIVE_IMPORTS,
      ".github/rivet/aw/unreviewed-extension.md",
    ],
  });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "resolved native imports differ from the approved inventory",
  ]);
});

test("rejects an unapproved local extension action", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessReview(authority, { expectedLocalActions: [] });
  assert.equal(trust.trusted, false);
  assert.deepEqual(trust.violations, [
    "local actions differ from the approved inventory",
  ]);
});

test("rejects review-context authority drift", async () => {
  const { authority } = await compiledAuthority();
  const jobAuthority = structuredClone(authority.jobAuthority);
  jobAuthority.review_context.permissions["pull-requests"] = "write";
  const trust = assessReview({ ...authority, jobAuthority });
  assert.deepEqual(trust.violations, [
    "review workflow differs from the approved inventory",
  ]);
});

test("rejects model repository configuration drift", async () => {
  const { authority } = await compiledAuthority();
  for (const name of ["Execute Codex CLI", "Generate Safe Outputs Config"]) {
    const scripts = authority.scripts.map((script) =>
      script.job === "agent" && script.name === name
        ? { ...script, run: `${script.run}\necho changed` }
        : script,
    );
    const trust = assessReview({ ...authority, scripts });
    assert.deepEqual(trust.violations, [
      "review workflow differs from the approved inventory",
    ]);
  }
});

test("rejects extra agent execution and write authority", async () => {
  const { authority } = await compiledAuthority();
  const extraScript = {
    job: "agent",
    name: "Read repository again",
    if: null,
    run: "gh api repos/${GITHUB_REPOSITORY}",
    shell: null,
    env: {},
  };
  const scriptTrust = assessReview({
    ...authority,
    scripts: [...authority.scripts, extraScript],
  });
  assert.deepEqual(scriptTrust.violations, [
    "review workflow differs from the approved inventory",
  ]);

  const jobAuthority = structuredClone(authority.jobAuthority);
  jobAuthority.agent.permissions = { contents: "write", issues: "write" };
  const permissionTrust = assessReview({ ...authority, jobAuthority });
  assert.deepEqual(permissionTrust.violations, [
    "review workflow differs from the approved inventory",
  ]);
});

test("rejects extra publication execution and permissions", async () => {
  const { authority } = await compiledAuthority();
  const scriptTrust = assessReview({
    ...authority,
    scripts: [
      ...authority.scripts,
      {
        job: "safe_outputs",
        name: "Unapproved publisher",
        if: null,
        run: "echo publish",
        shell: null,
        env: {},
      },
    ],
  });
  assert.deepEqual(scriptTrust.violations, [
    "review workflow differs from the approved inventory",
  ]);

  const jobAuthority = structuredClone(authority.jobAuthority);
  jobAuthority.safe_outputs.permissions.contents = "write";
  const writeCapableJobs = authority.writeCapableJobs.map((job) =>
    job.job === "safe_outputs"
      ? { ...job, permissions: jobAuthority.safe_outputs.permissions }
      : job,
  );
  const permissionTrust = assessReview({
    ...authority,
    jobAuthority,
    writeCapableJobs,
  });
  assert.deepEqual(permissionTrust.violations, [
    "review workflow differs from the approved inventory",
  ]);

  const actions = authority.actions.map((action) =>
    action.job === "safe_outputs" && action.action === "actions/github-script"
      ? {
          ...action,
          with: { ...action.with, "github-token": "${{ github.token }}" },
        }
      : action,
  );
  const tokenTrust = assessReview({ ...authority, actions });
  assert.deepEqual(tokenTrust.violations, [
    "review workflow differs from the approved inventory",
  ]);

  const environmentAuthority = structuredClone(authority.jobAuthority);
  environmentAuthority.safe_outputs.env.CODEX_API_KEY =
    "${{ secrets.CODEX_API_KEY }}";
  const environmentTrust = assessReview({
    ...authority,
    jobAuthority: environmentAuthority,
  });
  assert.deepEqual(environmentTrust.violations, [
    "review workflow differs from the approved inventory",
  ]);
});

test("rejects unapproved safe-output handler fields", async () => {
  const { authority } = await compiledAuthority();
  for (const [handler, field] of [
    ["create_issue", "github-token"],
    ["create_pull_request_review_comment", "target-repository"],
  ]) {
    const safeOutputConfig = structuredClone(authority.safeOutputConfig);
    safeOutputConfig[handler][field] = "unapproved";
    const serializedConfig = JSON.stringify(safeOutputConfig);
    const actions = authority.actions.map((action) => ({
      ...action,
      env: Object.fromEntries(
        Object.entries(action.env).map(([name, value]) => [
          name,
          name === "GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG"
            ? serializedConfig
            : value,
        ]),
      ),
    }));
    const trust = assessReview({ ...authority, actions, safeOutputConfig });
    assert.deepEqual(
      trust.violations,
      ["review workflow differs from the approved inventory"],
      `${handler}.${field} must fail closed`,
    );
  }
});

test("rejects a review model different from configuration", async () => {
  const { authority } = await compiledAuthority();
  const trust = assessReview(authority, { expectedModel: "other-model" });
  assert.deepEqual(trust.violations, [
    "review model differs from the configured model",
  ]);
});

test("rejects model-driven repository read authority", async () => {
  const { authority } = await compiledAuthority();
  for (const change of [
    { githubMcpEnabled: true },
    { shellToolDisabled: false },
  ]) {
    const trust = assessReview({ ...authority, ...change });
    assert.deepEqual(trust.violations, [
      "model-driven repository reads must be disabled",
    ]);
  }
});

test("binds the complete review graph and execution controls", async () => {
  const { authority } = await compiledAuthority();
  const mutations = [];

  const triggerConfig = structuredClone(authority.triggerConfig);
  triggerConfig.pull_request_target.types.push("closed");
  mutations.push(["trigger type", { triggerConfig }]);

  mutations.push([
    "workflow concurrency",
    {
      concurrency: {
        ...authority.concurrency,
        "cancel-in-progress": false,
      },
    },
  ]);
  mutations.push([
    "workflow secret environment",
    { workflowEnv: { TOKEN: "${{ secrets.EXTRA_TOKEN }}" } },
  ]);

  const jobConditions = structuredClone(authority.jobConditions);
  jobConditions.safe_outputs.if = `${jobConditions.safe_outputs.if} || always()`;
  mutations.push(["publication condition", { jobConditions }]);

  const jobAuthority = structuredClone(authority.jobAuthority);
  jobAuthority.agent.continueOnError = true;
  mutations.push(["job failure handling", { jobAuthority }]);

  const scripts = authority.scripts.map((script, index) =>
    index === 0
      ? {
          ...script,
          continueOnError: true,
          timeoutMinutes: 1,
          workingDirectory: "/tmp",
        }
      : script,
  );
  mutations.push(["step execution controls", { scripts }]);

  const extraJobAuthority = structuredClone(authority.jobAuthority);
  extraJobAuthority.exfiltrate = {
    ...structuredClone(authority.jobAuthority.review_context),
    env: { TOKEN: "${{ secrets.EXTRA_TOKEN }}" },
  };
  mutations.push([
    "unknown job",
    {
      jobAuthority: extraJobAuthority,
      scripts: [
        ...authority.scripts,
        {
          job: "exfiltrate",
          id: null,
          name: "Exfiltrate",
          if: null,
          run: "curl https://example.invalid",
          shell: null,
          env: {},
          workingDirectory: null,
          continueOnError: null,
          timeoutMinutes: null,
        },
      ],
    },
  ]);

  for (const [label, change] of mutations) {
    const trust = assessReview({ ...authority, ...change });
    assert.deepEqual(
      trust.violations,
      ["review workflow differs from the approved inventory"],
      `${label} drift must fail closed`,
    );
  }
});

test("pins a complete review inventory for every supported engine", () => {
  for (const inventory of [
    RIVET_REVIEW_AUTHORITY_SHA256_BY_ENGINE,
    RIVET_REVIEW_DISABLED_AUTHORITY_SHA256_BY_ENGINE,
  ]) {
    assert.deepEqual(Object.keys(inventory), [
      "claude",
      "codex",
      "copilot",
      "gemini",
    ]);
    for (const digest of Object.values(inventory)) {
      assert.match(digest, /^[0-9a-f]{64}$/);
    }
  }
});

test("pins a complete issue-triage inventory for every supported engine", () => {
  assert.deepEqual(Object.keys(RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE), [
    "claude",
    "codex",
    "copilot",
    "gemini",
  ]);
  for (const digest of Object.values(
    RIVET_ISSUE_TRIAGE_AUTHORITY_SHA256_BY_ENGINE,
  )) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
});
