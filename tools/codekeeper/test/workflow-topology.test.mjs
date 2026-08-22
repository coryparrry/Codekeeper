import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  countSteps,
  modelCallStage,
  runnerWasAllocated,
  timestamp,
} from "../../../scripts/measure-codekeeper-runs.mjs";
import { renderWorkflow } from "../../../packages/codekeeper/src/assets.mjs";
import {
  MODE_IDS,
  MODES,
} from "../../../packages/codekeeper/src/constants.mjs";
import { completionGuidance } from "../../../packages/codekeeper/src/plan.mjs";
import {
  loadVerifiedAssets,
  TEST_PACKAGE_RELEASE,
} from "../../../packages/codekeeper/test/helpers.mjs";
import {
  execFileAsync,
  jobSection,
  repositoryFile,
  repositoryRoot,
  stepRunScript,
  workflow,
} from "./workflow-test-helpers.mjs";

const topologyFixture = JSON.parse(
  await readFile(
    new URL("./fixtures/runtime-v2-current-topology.json", import.meta.url),
    "utf8",
  ),
);
const workflowFiles = Object.freeze({
  review: "review",
  issue: "issues",
  fix: "fix",
  maintain: "maintain",
});
const effectiveModes = Object.freeze({
  review: "review",
  issue: "issue",
  fix: "fix",
  maintain: "audit",
});
const genericRuntime = await workflow("runtime");
const wrappersActive = /uses: \.\/\.github\/workflows\/codekeeper-runtime\.yml/.test(
  await workflow("review"),
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function productionJobNames(source) {
  const jobsStart = source.indexOf("\njobs:\n");
  assert.notEqual(jobsStart, -1, "production workflow must declare jobs");
  return [...source.slice(jobsStart).matchAll(/^  ([a-z][a-z0-9_-]*):$/gm)].map(
    (match) => match[1],
  );
}

function namedSteps(job) {
  const starts = [...job.matchAll(/^      - name: (.+)$/gm)];
  return starts.map((start, index) => ({
    name: start[1],
    source: job.slice(start.index, starts[index + 1]?.index ?? job.length),
  }));
}

function sections(source) {
  const names = productionJobNames(source);
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      jobSection(source, name, names[index + 1]),
    ]),
  );
}

function stepContaining(job, needle, description) {
  const aliases = {
    "run-workspace-agent": "stage compute --operation workspace",
    "run-agent": "stage compute --operation analyze",
    "verify-review": "stage validate --operation verify",
    "verify-audit": "stage validate --operation verify",
    "verify-issue": "stage validate --operation verify",
    "verify-fix": "stage validate --operation verify",
    "seal-review": "stage validate --operation seal",
    "seal-audit": "stage validate --operation seal",
    "seal-issue": "stage validate --operation seal",
    "seal-fix": "stage validate --operation seal",
  };
  const match = namedSteps(job).find(
    (step) =>
      step.source.includes(needle) ||
      (aliases[needle] && step.source.includes(aliases[needle])),
  );
  assert.ok(match, `${description} step containing ${needle} is present`);
  return match;
}

const candidateReferencePattern =
  /(?:\$\{CANDIDATE\}|\$CANDIDATE(?!_SHA256)\b|\$\{HANDOFF\}\/candidate\b|\$HANDOFF\/candidate\b|--candidate\b|\/candidate(?:["'\s]|$))/i;
const allowedCandidateReferenceLines = [
  /^\s*test -d "\$HANDOFF\/candidate" \|\|/,
  /^\s*CANDIDATE:\s*\$\{\{\s*runner\.temp\s*\}\}\/codekeeper-review-handoff\/candidate\s*$/,
  /^\s*--candidate "\$CANDIDATE"\s*\\$/,
];

function candidateReferenceViolations(source) {
  return source
    .split("\n")
    .filter((line) => candidateReferencePattern.test(line))
    .filter(
      (line) =>
        !allowedCandidateReferenceLines.some((pattern) => pattern.test(line)),
    );
}

function noCredentialSource(source, description) {
  assert.doesNotMatch(
    source,
    /secrets\.(?:model_api_key|workspace_api_key|openai_api_key|trace_api_key|app_private_key)|CODEKEEPER_(?:MODEL|WORKSPACE|TRACE)_API_KEY|APP_PRIVATE_KEY|github\.token|GITHUB_TOKEN|create-github-app-token|private-key:/,
    `${description} must not receive provider, workspace, trace, GitHub, or App credentials`,
  );
}

function appCredentialSource(source) {
  return /secrets\.app_private_key|APP_PRIVATE_KEY|private-key:\s*\$\{\{\s*secrets\.app_private_key/.test(
    source,
  );
}

const modelCredentialReference =
  /secrets\.model_api_key|(?:CODEKEEPER_)?MODEL_API_KEY|\bMODEL_API_KEY\b/i;
const traceCredentialReference =
  /secrets\.trace_api_key|(?:CODEKEEPER_)?TRACE_API_KEY|\bTRACE_API_KEY\b|\bOPENAI_TRACE_API_KEY\b/i;
const workspaceCredentialReference =
  /secrets\.(?:workspace_api_key|openai_api_key)|(?:CODEKEEPER_)?(?:WORKSPACE|OPENAI)_API_KEY|\b(?:WORKSPACE|OPENAI)_API_KEY\b/i;
const appPrivateKeyReference =
  /secrets\.app_private_key|(?:CODEKEEPER_)?APP_PRIVATE_KEY|\bAPP_PRIVATE_KEY\b|private-key:/i;

function assertNoCredentialReference(source, pattern, description) {
  assert.doesNotMatch(source, pattern, description);
}

function assertMeasurementClassifiers() {
  const steps = [
    {
      name: "Check out trusted default branch",
      uses: "actions/checkout@full-sha",
    },
    {
      name: "Post Run actions/checkout",
      uses: "actions/checkout@full-sha",
    },
    {
      name: "Set up pinned Node.js",
      uses: "actions/setup-node@full-sha",
    },
    {
      name: "Post Run actions/setup-node",
      uses: "actions/setup-node@full-sha",
    },
    {
      name: "Upload review publication handoff",
      uses: "actions/upload-artifact@full-sha",
    },
    {
      name: "Post Run actions/upload-artifact",
      uses: "actions/upload-artifact@full-sha",
    },
    {
      name: "Download review publication handoff",
      uses: "actions/download-artifact@full-sha",
    },
    {
      name: "Post Run actions/download-artifact",
      uses: "actions/download-artifact@full-sha",
    },
    {
      name: "Install pinned Agents SDK runtime",
      started_at: "2026-08-21T10:00:00Z",
      completed_at: "2026-08-21T10:05:00Z",
    },
    {
      name: "Finalize review with configured Agents SDK model",
      started_at: "2026-08-21T10:05:00Z",
      completed_at: "2026-08-21T10:06:00Z",
    },
    {
      name: "Triage issue with configured Agents SDK model",
      started_at: "2026-08-21T10:06:00Z",
      completed_at: "2026-08-21T10:07:00Z",
    },
  ];

  assert.equal(countSteps(steps, /check out|actions\/checkout/i), 1);
  assert.equal(countSteps(steps, /set\s+up[^\n]*node|actions\/setup-node/i), 1);
  assert.equal(countSteps(steps, /upload\b|actions\/upload-artifact/i), 1);
  assert.equal(countSteps(steps, /download\b|actions\/download-artifact/i), 1);
  assert.equal(modelCallStage(steps[8]), null);
  assert.deepEqual(modelCallStage(steps[9]), {
    stage: "Finalize review with configured Agents SDK model",
    durationMs: 60_000,
  });
  assert.deepEqual(modelCallStage(steps[10]), {
    stage: "Triage issue with configured Agents SDK model",
    durationMs: 60_000,
  });
  assert.equal(
    runnerWasAllocated({
      startedAt: "2026-08-21T10:00:00Z",
      conclusion: "skipped",
    }),
    false,
  );
  assert.equal(
    runnerWasAllocated({
      startedAt: "2026-08-21T10:00:00Z",
      conclusion: "success",
    }),
    true,
  );
  assert.equal(
    timestamp("2026-02-28T10:00:00.123Z", "fixture timestamp").value,
    "2026-02-28T10:00:00.123Z",
  );
  assert.throws(
    () => timestamp("0", "fixture timestamp"),
    /RFC3339 UTC timestamp/,
  );
  assert.throws(
    () => timestamp("2026-02-30T00:00:00Z", "fixture timestamp"),
    /RFC3339 UTC timestamp/,
  );
}

test("the committed fixture matches the current production job graphs", async () => {
  assert.deepEqual(Object.keys(topologyFixture), [
    "review",
    "issue",
    "fix",
    "maintain",
  ]);
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    assert.deepEqual(
      productionJobNames(source),
      topologyFixture[mode],
      `${mode} production job graph must match the committed baseline`,
    );
  }
  const updateGuidance = completionGuidance(["review", "maintain"], true, true);
  assert.match(
    updateGuidance.heading,
    /keeps running the current default-branch configuration/i,
  );
  assert.match(updateGuidance.heading, /after this pull request merges/i);
  assert.match(updateGuidance.closing, /After merge, run codekeeper verify/i);

  const bundle = await loadVerifiedAssets();
  for (const mode of MODE_IDS) {
    const rendered = renderWorkflow(bundle.contents[MODES[mode].asset], {
      packageRelease: TEST_PACKAGE_RELEASE,
      mode,
      preset: "openai",
    });
    assert.match(
      rendered,
      new RegExp(
        `package_version: "${escapeRegExp(TEST_PACKAGE_RELEASE.version)}"`,
      ),
      `${mode} caller must retain the exact package version while an update PR is pending`,
    );
    assert.match(
      rendered,
      new RegExp(escapeRegExp(TEST_PACKAGE_RELEASE.integrity)),
      `${mode} caller must retain the exact package integrity while an update PR is pending`,
    );
    assert.doesNotMatch(
      rendered,
      /(?:@latest|package_version:\s*latest|npm\s+(?:install|exec)[^\n]*latest)/i,
      `${mode} caller must not use a dynamic latest package reference`,
    );
  }
});

test("job dependencies preserve the staged state-machine order", async () => {
  if (wrappersActive) {
    const validate = jobSection(genericRuntime, "validate", "publish");
    const publish = jobSection(genericRuntime, "publish");
    assert.match(validate, /^    needs: compute$/m);
    assert.match(publish, /^    needs: \[compute, validate\]$/m);
    assert.match(publish, /always\(\)/);
    return;
  }
  const expectedNeeds = {
    review: { gate: "needs: analyze" },
    issue: {
      analyze: "needs: workspace",
      seal: "needs: [workspace, analyze]",
      publish: "needs: [workspace, seal]",
    },
    fix: {
      analyze: "needs: workspace",
      verify: "needs: [workspace, analyze]",
      seal: "needs: [workspace, analyze, verify]",
      publish: "needs: [workspace, analyze, seal]",
    },
    maintain: {
      analyze: "needs: workspace",
      verify: "needs: [workspace, analyze]",
      seal: "needs: [workspace, analyze, verify]",
      publish: "needs: [workspace, seal]",
    },
  };
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const jobSections = sections(source);
    for (const [job, dependency] of Object.entries(expectedNeeds[mode])) {
      assert.match(
        jobSections[job],
        new RegExp(`^    ${escapeRegExp(dependency)}$`, "m"),
      );
    }
  }
});

test("App private keys and App-token creation stay in publication jobs", async () => {
  if (wrappersActive) {
    const compute = jobSection(genericRuntime, "compute", "validate");
    const validate = jobSection(genericRuntime, "validate", "publish");
    const publish = jobSection(genericRuntime, "publish");
    assert.doesNotMatch(compute, /secrets\.app_private_key|create-github-app-token/);
    assert.doesNotMatch(validate, /secrets\.app_private_key|create-github-app-token/);
    assert.match(publish, /secrets\.app_private_key/);
    assert.match(publish, /create-github-app-token/);
    return;
  }
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const jobSections = sections(source);
    const publicationJob =
      mode === "review" ? jobSections.gate : jobSections.publish;
    assert.ok(
      appCredentialSource(publicationJob),
      `${mode} publication receives the App private key`,
    );
    assert.match(publicationJob, /create-github-app-token/);
    for (const job of topologyFixture[mode]) {
      if (job === (mode === "review" ? "gate" : "publish")) continue;
      assert.equal(
        appCredentialSource(jobSections[job]),
        false,
        `${mode}.${job} must not receive the App private key`,
      );
      assert.doesNotMatch(
        jobSections[job],
        /create-github-app-token/,
        `${mode}.${job} must not mint an App token`,
      );
    }
  }
});

test("provider, trace, and workspace credentials remain in their stage boundaries", async () => {
  if (wrappersActive) {
    const compute = jobSection(genericRuntime, "compute", "validate");
    const validate = jobSection(genericRuntime, "validate", "publish");
    const publish = jobSection(genericRuntime, "publish");
    assert.match(compute, /secrets\.workspace_api_key/);
    assert.match(compute, /secrets\.model_api_key/);
    assert.match(compute, /secrets\.trace_api_key/);
    assert.doesNotMatch(validate, /secrets\.(?:workspace_api_key|model_api_key|trace_api_key|app_private_key)/);
    assert.doesNotMatch(publish, /secrets\.(?:workspace_api_key|model_api_key|trace_api_key)/);
    return;
  }
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const jobSections = sections(source);
    const workspaceJob =
      jobSections[mode === "review" ? "analyze" : "workspace"];
    const workspaceStep = stepContaining(
      workspaceJob,
      "run-workspace-agent",
      `${mode} workspace specialist`,
    );
    assert.match(workspaceStep.source, /CODEKEEPER_WORKSPACE_API_KEY/);
    assert.doesNotMatch(
      workspaceStep.source,
      /CODEKEEPER_(?:MODEL|TRACE)_API_KEY|secrets\.(?:model_api_key|trace_api_key)|APP_PRIVATE_KEY|create-github-app-token/,
      `${mode} workspace specialist must not see provider, trace, or App credentials`,
    );

    const modelJob = jobSections.analyze;
    const modelStep = stepContaining(
      modelJob,
      "run-agent",
      `${mode} coordinator`,
    );
    assert.match(
      modelStep.source,
      /CODEKEEPER_MODEL_API_KEY:\s*\$\{\{\s*secrets\.model_api_key\s*\}\}/,
    );
    assert.match(
      modelStep.source,
      /CODEKEEPER_TRACE_API_KEY:\s*\$\{\{\s*secrets\.trace_api_key\s*\}\}/,
    );
    assert.doesNotMatch(
      modelStep.source,
      /CODEKEEPER_WORKSPACE_API_KEY|secrets\.(?:workspace_api_key|openai_api_key)|APP_PRIVATE_KEY|create-github-app-token/,
      `${mode} coordinator must not see workspace or App credentials`,
    );
    if (mode === "review") {
      assertNoCredentialReference(
        modelJob,
        appPrivateKeyReference,
        "review analysis must not reference the App private key",
      );
      const analysisOutsideCoordinator = modelJob.replace(modelStep.source, "");
      assertNoCredentialReference(
        analysisOutsideCoordinator,
        modelCredentialReference,
        "review provider credentials must enter only the coordinator step",
      );
      assertNoCredentialReference(
        analysisOutsideCoordinator,
        traceCredentialReference,
        "review trace credentials must enter only the coordinator step",
      );
      assertNoCredentialReference(
        modelStep.source,
        workspaceCredentialReference,
        "review coordinator must not reference workspace or OpenAI workspace credentials",
      );
    } else {
      assertNoCredentialReference(
        workspaceJob,
        modelCredentialReference,
        `${mode} workspace job must not reference model credentials`,
      );
      assertNoCredentialReference(
        workspaceJob,
        traceCredentialReference,
        `${mode} workspace job must not reference trace credentials`,
      );
      assertNoCredentialReference(
        workspaceJob,
        appPrivateKeyReference,
        `${mode} workspace job must not reference the App private key`,
      );
      assertNoCredentialReference(
        modelJob,
        workspaceCredentialReference,
        `${mode} analysis must not reference workspace or OpenAI workspace credentials`,
      );
      assertNoCredentialReference(
        modelJob,
        appPrivateKeyReference,
        `${mode} analysis must not reference the App private key`,
      );
    }
    const publication =
      mode === "review" ? jobSections.gate : jobSections.publish;
    assertNoCredentialReference(
      publication,
      modelCredentialReference,
      `${mode} publication must not receive provider or trace credentials`,
    );
    assertNoCredentialReference(
      publication,
      traceCredentialReference,
      `${mode} publication must not receive trace credentials`,
    );
    assertNoCredentialReference(
      publication,
      workspaceCredentialReference,
      `${mode} publication must not receive workspace or OpenAI workspace credentials`,
    );
  }
});

test("workspace jobs close their instruction and credential isolation boundary", async () => {
  if (wrappersActive) {
    const compute = jobSection(genericRuntime, "compute", "validate");
    assert.match(compute, /CODEX_HOME/);
    assert.match(compute, /QUARANTINE/);
    assert.match(compute, /WORKSPACE_USER/);
    assert.match(compute, /stage compute \\\n\s+--operation workspace/);
    assert.ok(compute.indexOf("--operation workspace") < compute.indexOf("--operation analyze"));
    return;
  }
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const job = sections(source)[mode === "review" ? "analyze" : "workspace"];
    assert.match(job, /CODEX_HOME/);
    assert.match(job, /stage compute --operation workspace/);
    assert.match(job, /--mode (?:review|issues|fix|maintain)/);
    assert.match(job, /CODEKEEPER_WORKSPACE_API_KEY/);
    if (mode === "review") {
      assert.match(job, /WORKSPACE_USER: codekeeper-workspace/);
      assert.match(job, /WORKSPACE_TEMP/);
      assert.match(job, /TOOLING_PATH/);
    }
  }
});

test("repository validation is confined to credential-free verification jobs", async () => {
  if (wrappersActive) {
    const validate = jobSection(genericRuntime, "validate", "publish");
    assert.match(validate, /Verify the repair candidate without credentials/);
    assert.match(validate, /stage validate[\s\S]*--operation verify/);
    noCredentialSource(validate, "generic validation job");
    return;
  }
  for (const mode of ["fix", "maintain"]) {
    const source = await workflow(workflowFiles[mode]);
    const jobSections = sections(source);
    const verification = jobSections.verify;
    assert.match(
      verification,
      /Verify candidate without OpenAI or App credentials/,
    );
    assert.match(
      verification,
      new RegExp(
        `(?:verify-${effectiveModes[mode]}|stage validate --operation verify --mode ${mode})`,
      ),
    );
    noCredentialSource(verification, `${mode}.verify`);
    assert.doesNotMatch(verification, /run-agent|run-workspace-agent/);
    assert.match(verification, /permissions:\n\s+contents: read/);

    const verificationCommand = new RegExp(
      `(?:verify-${effectiveModes[mode]}|stage validate --operation verify --mode ${mode})`,
    );
    const outsideVerification = source.replace(verification, "");
    assert.doesNotMatch(
      outsideVerification,
      verificationCommand,
      `${mode} repository validation must not move into a compute or publication job`,
    );
  }
});

test("every runner verifies its exact package and relevant handoff before installation", async () => {
  if (wrappersActive) {
    const jobs = sections(genericRuntime);
    for (const [name, source] of Object.entries(jobs)) {
      assert.match(source, /name: Acquire exact Codekeeper package/, `${name} acquires package`);
      assert.match(source, /name: Install exact Codekeeper runtime/, `${name} installs runtime`);
      assert.ok(source.indexOf("Acquire exact Codekeeper package") < source.indexOf("Install exact Codekeeper runtime"));
    }
    return;
  }
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const jobSections = sections(source);
    for (const [index, job] of topologyFixture[mode].entries()) {
      const section = jobSections[job];
      assert.match(section, /name: Install exact Codekeeper runtime/);
      assert.match(
        section,
        /run: node \"\$GITHUB_WORKSPACE\/tooling\/tools\/codekeeper\/bin\/install-runtime\.mjs\"/,
      );
      assert.match(
        section,
        /package_version: \$\{\{ inputs\.package_version \}\}/,
      );
      assert.match(
        section,
        /package_integrity: \$\{\{ inputs\.package_integrity \}\}/,
      );
      if (index === 0) {
        assert.match(section, /name: Acquire exact Codekeeper package/);
      } else {
        assert.match(section, /name: Verify downloaded Codekeeper package/);
        assert.match(section, /package_source: artifact/);
        assert.match(section, /expected_manifest_sha256:/);
        assert.match(section, /expected_source_commit:/);
      }
    }
  }
});

test("publication does not execute validation, lifecycle hooks, or arbitrary candidate code", async () => {
  if (wrappersActive) {
    const publish = jobSection(genericRuntime, "publish");
    assert.doesNotMatch(publish, /npm (?:ci|install|test)|pnpm|yarn|git apply/);
    assert.doesNotMatch(publish, /--operation verify/);
    assert.match(publish, /--operation seal/);
    assert.match(publish, /--operation publish/);
    return;
  }
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const publication =
      sections(source)[mode === "review" ? "gate" : "publish"];
    assert.doesNotMatch(publication, /(?:^|\s)(?:validate|verify)-[a-z]+/);
    assert.doesNotMatch(
      publication,
      /(?:npm|npx)\s+(?:ci|install|run|exec)|preinstall|postinstall/,
    );
    assert.doesNotMatch(
      publication,
      /run-agent|run-workspace-agent|apply-workspace-patch/,
    );
    if (mode === "review") {
      const seal = stepContaining(
        publication,
        "seal-review",
        "review tokenless seal",
      );
      const candidateSteps = namedSteps(publication).filter((step) =>
        candidateReferencePattern.test(step.source),
      );
      assert.deepEqual(
        candidateSteps.map((step) => step.name),
        [
          "Restore verified package and candidate",
          "Seal review artifact without repository execution",
        ],
        "review candidate references must stay in the transport and tokenless seal steps",
      );
      assert.deepEqual(
        candidateReferenceViolations(publication),
        [],
        "review candidate references must match the narrow data-only allowlist",
      );
      assert.match(
        seal.source,
        /node tooling\/codekeeper-runtime\/src\/cli\.mjs (?:seal-review|stage validate --operation seal --mode review)/,
        "review sealing must invoke only the trusted Codekeeper runtime",
      );
      assert.match(
        seal.source,
        /--candidate "\$CANDIDATE"/,
        "review sealing must pass the candidate only as data",
      );
      const restore = candidateSteps.find(
        (step) => step.name === "Restore verified package and candidate",
      );
      assert.ok(restore);
      assert.notDeepEqual(
        candidateReferenceViolations(
          `${restore.source}\n          python3 "\$CANDIDATE"\n          python3 "\${CANDIDATE}"\n`,
        ),
        [],
        "an injected python3 candidate execution must fail the candidate allowlist",
      );
    } else {
      assert.deepEqual(
        candidateReferenceViolations(publication),
        [],
        `${mode} publication must not reference candidate paths or variables`,
      );
      assert.equal(
        namedSteps(publication).some((step) =>
          candidateReferencePattern.test(step.source),
        ),
        false,
        `${mode} publication must not contain candidate references`,
      );
    }
  }
});

test("coordinators run only after workspace teardown and workflows have no writable cross-run cache", async () => {
  if (wrappersActive) {
    const compute = jobSection(genericRuntime, "compute", "validate");
    assert.ok(compute.indexOf("--operation workspace") < compute.indexOf("--operation analyze"));
    assert.doesNotMatch(genericRuntime, /actions\/cache|save-always|github\.run_attempt/);
    return;
  }
  assertMeasurementClassifiers();
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const jobSections = sections(source);
    assert.doesNotMatch(
      source,
      /actions\/cache@|package-manager-cache:\s*true|cache-dependency-path:/,
    );
    if (mode === "review") {
      const analysis = jobSections.analyze;
      const close = analysis.indexOf("stage compute --operation workspace");
      const coordinator = analysis.indexOf(
        "Finalize review with configured Agents SDK model",
      );
      assert.ok(
        close >= 0 && coordinator > close,
        "review coordinator starts after the workspace stage",
      );
      assert.match(
        analysis.slice(0, coordinator),
        /CODEKEEPER_WORKSPACE_API_KEY/,
      );
    } else {
      assert.match(jobSections.analyze, /needs: workspace/);
      assert.ok(
        source.indexOf("  workspace:\n") < source.indexOf("  analyze:\n"),
      );
    }
  }
});

test("sealing completes before App-token creation", async () => {
  if (wrappersActive) {
    const publish = jobSection(genericRuntime, "publish");
    assert.ok(publish.indexOf("--operation seal") < publish.indexOf("secrets.app_private_key"));
    assert.ok(publish.indexOf("secrets.app_private_key") < publish.indexOf("create-github-app-token"));
    return;
  }
  for (const [mode, workflowName] of Object.entries(workflowFiles)) {
    const source = await workflow(workflowName);
    const jobSections = sections(source);
    const sealJob = mode === "review" ? jobSections.gate : jobSections.seal;
    const publishJob =
      mode === "review" ? jobSections.gate : jobSections.publish;
    const sealMarker = `(?:seal-${effectiveModes[mode]}|stage validate --operation seal --mode ${mode})`;
    assert.match(sealJob, new RegExp(sealMarker));
    const sealPosition = sealJob.search(new RegExp(sealMarker));
    if (mode === "review") {
      assert.ok(
        sealPosition < sealJob.indexOf("create-github-app-token"),
        `${mode} must seal before creating an App token`,
      );
    } else {
      assert.ok(
        source.indexOf("  seal:\n") < source.indexOf("  publish:\n"),
        `${mode} must run the seal job before the publication job`,
      );
      assert.match(publishJob, /create-github-app-token/);
    }
    assert.doesNotMatch(
      mode === "review"
        ? sealJob.slice(0, sealJob.indexOf("create-github-app-token"))
        : sealJob,
      /secrets\.app_private_key|APP_PRIVATE_KEY|create-github-app-token/,
      `${mode} sealing must remain tokenless`,
    );
    if (mode !== "review") {
      assert.match(publishJob, /needs: \[[^\]]*seal[^\]]*\]/);
    }
  }
});

test("callers pass explicit named secrets and never inherit the caller secret set", async () => {
  for (const mode of Object.keys(workflowFiles)) {
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${workflowFiles[mode]}.yml.example`,
    );
    assert.match(
      caller,
      /^    secrets:\n/m,
      `${mode} caller declares explicit secrets`,
    );
    assert.doesNotMatch(caller, /^\s+secrets:\s*inherit\s*$/m);
    for (const secret of [
      "model_api_key",
      "workspace_api_key",
      "trace_api_key",
      "app_private_key",
    ]) {
      assert.match(
        caller,
        new RegExp(`^      ${secret}:`, "m"),
        `${mode} caller maps ${secret}`,
      );
    }
    const reusable = await workflow(workflowFiles[mode]);
    assert.doesNotMatch(reusable, /^\s+secrets:\s*inherit\s*$/m);
    const secretsStart = reusable.indexOf("\n    secrets:\n");
    const permissionsStart = reusable.indexOf("\n\npermissions:", secretsStart);
    assert.notEqual(
      secretsStart,
      -1,
      `${mode} reusable workflow declares workflow_call secrets`,
    );
    assert.notEqual(
      permissionsStart,
      -1,
      `${mode} reusable workflow closes its workflow_call secrets block`,
    );
    assert.match(
      reusable.slice(secretsStart, permissionsStart),
      /^\s+app_private_key:/m,
    );
  }
});

test("review gate always runs and fails closed when analysis, sealing, or publication is incomplete", async () => {
  if (wrappersActive) {
    const publish = jobSection(genericRuntime, "publish");
    assert.match(publish, /name: \$\{\{ inputs\.mode == 'review' && 'Codekeeper review gate'/);
    assert.match(publish, /if: >-\n\s+always\(\)/);
    assert.match(publish, /Fail closed when review compute did not complete/);
    assert.match(publish, /Enforce the required review gate/);
    return;
  }
  const source = await workflow("review");
  const gate = sections(source).gate;
  assert.match(
    gate,
    /if: always\(\) && needs\.analyze\.outputs\.route != 'false'/,
  );
  const gateScript = stepRunScript(
    source,
    "Fail closed unless a current review was published",
  );
  const baseEnvironment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ENABLED: "true",
    AUTO_REVIEW: "true",
    AUTO_REVIEW_FEEDBACK: "true",
    IS_AUTOMATION_REPLY: "false",
    IS_REVIEW_FEEDBACK: "false",
    IS_COMMAND_REVIEW: "false",
    IS_OWNER_COMMAND_REVIEW: "false",
    HEAD_REPOSITORY: "octo/example",
    BASE_REPOSITORY: "octo/example",
    HEAD_SHA: "a".repeat(40),
    BASE_SHA: "b".repeat(40),
    REPOSITORY: "octo/example",
    BASE_REF: "main",
    DEFAULT_BRANCH: "main",
    ACTOR: "maintainer",
    AUTOMATION_BOT_LOGIN: "codekeeper[bot]",
    ANALYZE_RESULT: "success",
    SEAL_RESULT: "success",
    PUBLISH_DISPOSITION: "published",
    PUBLISH_BLOCKING: "false",
    GITHUB_STEP_SUMMARY: "/dev/null",
  };
  const runGate = (overrides = {}) =>
    execFileAsync("bash", ["-c", gateScript], {
      cwd: repositoryRoot,
      env: { ...baseEnvironment, ...overrides },
      maxBuffer: 16 * 1024,
    });

  assert.equal((await runGate()).stdout, "");
  for (const overrides of [
    { ANALYZE_RESULT: "failure" },
    { SEAL_RESULT: "failure" },
    { PUBLISH_DISPOSITION: "" },
    { PUBLISH_DISPOSITION: "published", PUBLISH_BLOCKING: "true" },
  ]) {
    await assert.rejects(
      () => runGate(overrides),
      (error) => error.code === 1,
    );
  }
});
