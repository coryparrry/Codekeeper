import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FIXTURE_ALLOWED_FIX_PATHS,
  WORKFLOW_COMPLETION_POLL_ATTEMPTS,
  WORKFLOW_COMPLETION_TIMEOUT_MS,
  createGhRunner,
  formatUsage,
  parseCommandLine,
  parseEventCallerRunName,
  parsePinnedWorkflowUses,
  preflight,
  recoverControlledFix,
  redact,
  runScenario,
  safeEnvironment
} from "../src/harness.mjs";
import { EvidenceError, prepareEvidenceDestination, validateEvidence, writeEvidenceAtomically } from "../src/evidence.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const DISPATCH_REF = `codekeeper-acceptance/dispatch-controlled-fix-${HEAD.slice(0, 12)}-9b635c89-b4c7-4316-b704-af6a81585ddb`;
const REPO = "owner/codekeeper-acceptance-fixture";
const APP = { login: "codekeeper-acceptance[bot]", graphqlLogin: "codekeeper-acceptance", id: "99" };
const NOW = "2026-08-08T00:00:00.000Z";
const RUN_CREATED = "2026-08-08T00:00:00.001Z";
const RUN_STARTED = "2026-08-08T00:00:00.002Z";
const SUBJECT_UPDATED = "2026-08-08T00:00:00.003Z";
const MARKER_UPDATED = "2026-08-08T00:00:00.004Z";
const RUN_UPDATED = "2026-08-08T00:00:00.005Z";
const LATE_PUBLICATION = "2026-08-08T00:00:00.006Z";
const TEMP_ROOT = await realpath(tmpdir());
const FIXTURE = await mkdtemp(path.join(TEMP_ROOT, "codekeeper-acceptance-fixture-"));

function encoded(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function response(stdout, exitCode = 0, stderr = "") {
  return { stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr, exitCode };
}

function metadata() {
  return {
    full_name: REPO,
    name: "codekeeper-acceptance-fixture",
    private: true,
    visibility: "private",
    html_url: `https://github.com/${REPO}`,
    default_branch: "main"
  };
}

function callerSource(workflow, {
  bootstrapRepository = "owner/codekeeper",
  bootstrapPath = "tools/codekeeper",
  bootstrapSha = SHA,
  reusableRepository = "owner/codekeeper",
  reusablePath = `.github/workflows/${workflow}`,
  reusableSha = SHA,
  bootstrapJobIf = null,
  bootstrapStepIf = null,
  reusableJobIf = null,
  reusableNeeds = "bootstrap",
  extraUses = ""
} = {}) {
  const reusableJob = {
    "codekeeper-maintain.yml": "maintain",
    "codekeeper-review.yml": "review",
    "codekeeper-issues.yml": "triage",
    "codekeeper-fix.yml": "fix"
  }[workflow];
  assert.ok(reusableJob, `Unexpected caller workflow ${workflow}`);
  const runName = workflow === "codekeeper-review.yml"
    ? 'run-name: "Codekeeper review #${{ github.event.pull_request.number }} @${{ github.event.pull_request.head.sha }}"\n'
    : workflow === "codekeeper-issues.yml"
      ? 'run-name: "Codekeeper issue triage #${{ github.event.issue.number }}"\n'
      : "";
  const bootstrapJobGate = bootstrapJobIf === null ? "" : `    if: ${bootstrapJobIf}\n`;
  const bootstrapStep = bootstrapStepIf === null
    ? `      - uses: ${bootstrapRepository}/${bootstrapPath}@${bootstrapSha}\n`
    : `      - if: ${bootstrapStepIf}\n        uses: ${bootstrapRepository}/${bootstrapPath}@${bootstrapSha}\n`;
  const reusableJobGate = reusableJobIf === null ? "" : `    if: ${reusableJobIf}\n`;
  const needs = reusableNeeds === null ? "" : `    needs: ${reusableNeeds}\n`;
  return `${runName}jobs:\n  bootstrap:\n${bootstrapJobGate}    steps:\n${bootstrapStep}  ${reusableJob}:\n${reusableJobGate}${needs}    uses: ${reusableRepository}/${reusablePath}@${reusableSha}\n${extraUses}`;
}

function workflowPin(workflow, options) {
  return encoded(callerSource(workflow, options));
}

async function freshEvidencePath(name = "evidence") {
  const parent = await mkdtemp(path.join(TEMP_ROOT, "codekeeper-evidence-"));
  return path.join(parent, `${name}.json`);
}

async function scenarioOptions(extra = {}) {
  return {
    repo: REPO,
    "source-sha": SHA,
    "acknowledge-private-acceptance": true,
    "fixture-checkout": FIXTURE,
    evidence: await freshEvidencePath(),
    ...extra
  };
}

async function manualRunOptions(extra = {}) {
  return scenarioOptions({ "run-created-after": NOW, ...extra });
}

async function recoveryOptions(extra = {}) {
  return scenarioOptions({
    issue: "14",
    "run-id": "77",
    pr: "14",
    "dispatch-ref": DISPATCH_REF,
    "app-login": APP.login,
    "app-id": APP.id,
    ...extra
  });
}

function createRepairFingerprint(issueNumber) {
  return createHash("sha256").update(`issue|${REPO}|${issueNumber}`).digest("hex");
}

function fakeClock(start = NOW) {
  const started = Date.parse(start);
  let current = started;
  return {
    now: () => new Date(current),
    sleep: async (milliseconds) => { current += milliseconds; },
    advance: (milliseconds) => { current += milliseconds; },
    elapsed: () => current - started
  };
}

function fakeGh({ scenario, recoveryDispatchRef = null, duplicateRecoveredRun = false, publicRepository = false, currentDefaultBranch = "main", markerHasPreviousPage = false, fixDraft = false, fixFork = false, fixRetarget = false, invalidFixHead = false, alteredFixHead = false, multipleFixCommits = false, foreignFixCommit = false, lateFixCommit = false, lateFixPull = false, lateMarker = false, missingPublicationParent = false, multiplePublicationParents = false, malformedPublicationParent = false, mismatchedPublicationParent = false, wrongRunActor = false, wrongAttributedActor = false, jobTotalCount = null, staleMarker = false, concurrentDispatch = false, concurrentDispatchAfterCompletion = false, invalidFixPolicy = false, commandFailure = false, workflowSource = null, wrongRepairMarker = false, foreignAppMarker = false, wrongDisplayTitle = false, wrongReviewGateName = false, reviewDraft = false, reviewRetarget = false, reviewHeadChanges = false, wrongReviewRunBaseBranch = false, baselineRun = false, baselineRerun = false, tagMismatch = false, tagCreationFailure = false, completionAfterRunView = 0, neverCompletes = false, onRunMetadata = null } = {}) {
  const calls = [];
  let workflowListCount = 0;
  let runViewCount = 0;
  let pullListCount = 0;
  let pullViewCount = 0;
  let tag = recoveryDispatchRef;
  const detail = {
    "maintenance-dry-run": ["codekeeper-maintain.yml", "Codekeeper maintenance", "workflow_dispatch"],
    "review-introduced-defect": ["codekeeper-review.yml", "Codekeeper review", "pull_request_target"],
    "issue-triage-related": ["codekeeper-issues.yml", "Codekeeper issue triage", "issues"],
    "controlled-fix": ["codekeeper-fix.yml", "Codekeeper issue implementation", "workflow_dispatch"]
  }[scenario];
  const issueNumber = 14;
  const fingerprint = createRepairFingerprint(issueNumber);
  const branch = `codekeeper/fix/fix-${fingerprint}`;
  const reviewHead = SHA;
  const reviewHeadBranch = "codekeeper/review-introduced-defect";
  const displayTitle = scenario === "review-introduced-defect"
    ? `Codekeeper review #12 @${reviewHead}`
    : scenario === "issue-triage-related"
      ? "Codekeeper issue triage #13"
      : detail[1];
  const runHead = HEAD;
  const runBranch = scenario === "maintenance-dry-run" || scenario === "controlled-fix"
    ? () => tag
    : scenario === "review-introduced-defect"
      ? () => (wrongReviewRunBaseBranch ? "release" : "main")
      : () => "main";
  const runEntry = (id = 77, overrides = {}) => ({
    databaseId: id,
    attempt: 1,
    status: "completed",
    createdAt: RUN_CREATED,
    updatedAt: RUN_UPDATED,
    headSha: runHead,
    headBranch: runBranch(),
    displayTitle: wrongDisplayTitle ? `${displayTitle} stale` : displayTitle,
    ...overrides
  });
  const workflowRunPayload = (runs) => ({
    total_count: runs.length,
    workflow_runs: runs.map((run) => ({
      id: run.databaseId,
      run_attempt: run.attempt,
      status: run.status,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      head_sha: run.headSha,
      head_branch: run.headBranch,
      display_title: run.displayTitle
    }))
  });
  const runner = async (args) => {
    calls.push(args);
    const text = args.join(" ");
    if (commandFailure) return response("ghp_abcdefghi token=leak https://user:password@example.invalid", 1, "GH_TOKEN=leak");
    if (text === "auth status --hostname github.com") return response("");
    if (text === `api --hostname github.com repos/${REPO}`) return response(publicRepository ? { ...metadata(), private: false, visibility: "public", default_branch: currentDefaultBranch } : { ...metadata(), default_branch: currentDefaultBranch });
    if (text === "api --hostname github.com user --jq .login") return response("dispatcher\n");
    if (text === `api --hostname github.com repos/${REPO}/git/ref/heads/main`) return response({ object: { sha: HEAD } });
    if (args[0] === "api" && args.includes("--method") && args.includes("POST") && args.includes(`repos/${REPO}/git/refs`)) {
      const ref = args.find((item) => item.startsWith("ref=refs/tags/"));
      const sha = args.find((item) => item.startsWith("sha="));
      tag = ref?.slice("ref=refs/tags/".length);
      if (tagCreationFailure) return response("creation failed", 1);
      if (!tag || sha !== `sha=${HEAD}`) throw new Error(`Unexpected acceptance tag creation: ${text}`);
      return response({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: HEAD } });
    }
    if (text.includes(`/git/ref/tags/`)) {
      const encodedTag = text.slice(text.indexOf("/git/ref/tags/") + "/git/ref/tags/".length);
      if (decodeURIComponent(encodedTag) !== tag) throw new Error(`Unexpected acceptance tag lookup: ${text}`);
      return response({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: tagMismatch ? SHA : HEAD } });
    }
    if (text.includes(`/contents/.github/workflows/${detail?.[0]}`)) return response(workflowSource ? encoded(workflowSource) : workflowPin(detail[0]));
    if (text.includes("/contents/.github/codekeeper.json")) {
      return response(encoded(JSON.stringify({
        repository: { defaultBranch: "main", automationBranchPrefix: "codekeeper/fix/" },
        issues: { allowAiImplementation: !invalidFixPolicy },
        audit: { repair: { allowedPaths: invalidFixPolicy ? ["README.md"] : [...FIXTURE_ALLOWED_FIX_PATHS], validationCommands: invalidFixPolicy ? [] : ["node --test test/*.test.mjs"] } },
        merge: { enabled: false }
      })));
    }
    if (new RegExp(`^api --hostname github\\.com repos/${REPO}/pulls/\\d+/commits\\?per_page=2$`).test(text)) {
      const actor = foreignFixCommit
        ? { login: "other-app[bot]", id: 100, type: "Bot" }
        : { login: APP.login, id: Number(APP.id), type: "Bot" };
      const publication = {
        sha: HEAD,
        commit: {
          author: { date: lateFixCommit ? LATE_PUBLICATION : SUBJECT_UPDATED },
          committer: { date: lateFixCommit ? LATE_PUBLICATION : SUBJECT_UPDATED }
        },
        author: actor,
        committer: actor,
        ...(missingPublicationParent ? {} : {
          parents: malformedPublicationParent
            ? [{ sha: "main" }]
            : multiplePublicationParents
              ? [{ sha: HEAD }, { sha: SHA }]
              : [{ sha: mismatchedPublicationParent ? SHA : HEAD }]
        })
      };
      return response(multipleFixCommits ? [publication, { ...publication, sha: SHA }] : [publication]);
    }
    if (text === `api --hostname github.com repos/${REPO}/actions/workflows/codekeeper-fix.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(tag)}&per_page=100`) {
      const recovered = {
        id: 77,
        name: detail[1],
        display_title: wrongDisplayTitle ? `${displayTitle} stale` : displayTitle,
        event: detail[2],
        status: "completed",
        conclusion: "success",
        head_sha: runHead,
        head_branch: runBranch(),
        run_attempt: 1,
        created_at: RUN_CREATED,
        updated_at: RUN_UPDATED,
        actor: { login: wrongAttributedActor ? "other-dispatcher" : "dispatcher" }
      };
      return response({ total_count: duplicateRecoveredRun ? 2 : 1, workflow_runs: duplicateRecoveredRun ? [recovered, { ...recovered, id: 78 }] : [recovered] });
    }
    if (args[0] === "api" && args[3] === `repos/${REPO}/actions/workflows/${detail[0]}/runs?event=${detail[2]}&per_page=100&page=1`) {
      workflowListCount += 1;
      if (scenario === "issue-triage-related") {
        const runs = [runEntry()];
        return response(workflowRunPayload(runs));
      }
      if (workflowListCount === 1) return response(workflowRunPayload(baselineRun || baselineRerun ? [runEntry(66, { createdAt: "2026-08-07T23:59:59.000Z", updatedAt: "2026-08-07T23:59:59.001Z", headBranch: "main" })] : []));
      const runs = [runEntry()];
      if (baselineRun || baselineRerun) runs.unshift(runEntry(66, { createdAt: "2026-08-07T23:59:59.000Z", updatedAt: baselineRerun ? RUN_UPDATED : "2026-08-07T23:59:59.001Z", headBranch: "main", attempt: baselineRerun ? 2 : 1 }));
      if (concurrentDispatch || (concurrentDispatchAfterCompletion && runViewCount > 0)) runs.push(runEntry(78));
      return response(workflowRunPayload(runs));
    }
    if (args[0] === "workflow" && args[1] === "run") return response("");
    if (args[0] === "run" && args[1] === "view") {
      runViewCount += 1;
      const completed = !neverCompletes && runViewCount > completionAfterRunView;
      return response({
        databaseId: 77,
        url: `https://github.com/${REPO}/actions/runs/77`,
        status: completed ? "completed" : "in_progress",
        conclusion: completed ? (scenario === "review-introduced-defect" ? "failure" : "success") : null,
        workflowName: detail[1],
        headSha: runHead,
        headBranch: runBranch(),
        createdAt: RUN_CREATED,
        startedAt: RUN_STARTED,
        updatedAt: RUN_UPDATED,
        attempt: 1,
        displayTitle: wrongDisplayTitle ? `${displayTitle} stale` : displayTitle
      });
    }
    if (new RegExp(`^api --hostname github\\.com repos/${REPO}/actions/runs/(?:66|77)$`).test(text)) {
      const runId = Number(text.slice(text.lastIndexOf("/") + 1));
      const baseline = runId === 66;
      if (!baseline && onRunMetadata) await onRunMetadata();
      return response({
        id: runId,
        html_url: `https://github.com/${REPO}/actions/runs/${runId}`,
        event: detail[2],
        head_sha: baseline ? runHead : runHead,
        head_branch: baseline ? "main" : runBranch(),
        created_at: baseline ? "2026-08-07T23:59:59.000Z" : RUN_CREATED,
        updated_at: baseline ? (baselineRerun ? RUN_UPDATED : "2026-08-07T23:59:59.001Z") : RUN_UPDATED,
        run_attempt: baseline ? (baselineRerun ? 2 : 1) : 1,
        status: "completed",
        display_title: baseline ? displayTitle : (wrongDisplayTitle ? `${displayTitle} stale` : displayTitle),
        actor: { login: wrongRunActor ? "other-dispatcher" : "dispatcher" }
      });
    }
    if (text.includes("/actions/runs/77/jobs")) {
      const jobs = scenario === "maintenance-dry-run"
        ? [{ name: "publish", conclusion: "skipped" }]
        : [{ name: "fix / Codekeeper implementation verification", conclusion: "success" }];
      return response({ total_count: jobTotalCount ?? jobs.length, jobs });
    }
    if (args[0] === "pr" && args[1] === "view") {
      pullViewCount += 1;
      return response({
        number: 12,
        url: `https://github.com/${REPO}/pull/12`,
        state: "OPEN",
        isDraft: reviewDraft,
        isCrossRepository: false,
        baseRefName: reviewRetarget ? "release" : "main",
        headRefOid: reviewHeadChanges && pullViewCount > 1 ? HEAD : reviewHead,
        headRefName: reviewHeadBranch,
        labels: [{ name: "codekeeper:blocked" }],
        updatedAt: SUBJECT_UPDATED
      });
    }
    if (args[0] === "pr" && args[1] === "checks") return response([{ name: wrongReviewGateName ? "Codekeeper review gate" : "review / Codekeeper review gate", bucket: "fail" }]);
    if (args[0] === "issue" && args[1] === "view") return response({ number: scenario === "issue-triage-related" ? 13 : issueNumber, url: `https://github.com/${REPO}/issues/${scenario === "issue-triage-related" ? 13 : issueNumber}`, state: "OPEN", labels: [{ name: "codekeeper:ready" }], updatedAt: SUBJECT_UPDATED });
    if (args[0] === "pr" && args[1] === "list") {
      pullListCount += 1;
      return response(pullListCount === 1 ? [] : [{ number: 14, url: `https://github.com/${REPO}/pull/14`, headRefName: branch, createdAt: lateFixPull ? LATE_PUBLICATION : SUBJECT_UPDATED }]);
    }
    if (args[0] === "api" && args[1] === "graphql") {
      if (text.includes("comments(last:100)")) {
        assert.match(text, /pageInfo\{hasPreviousPage hasNextPage\}/);
        const isReview = text.includes("pullRequest(number:$number)");
        const marker = isReview ? "<!-- codekeeper:review -->" : scenario === "controlled-fix" ? `<!-- codekeeper:repair-notification=${wrongRepairMarker ? "0".repeat(64) : fingerprint} -->` : "<!-- codekeeper:issue-triage -->";
        const object = isReview ? "pullRequest" : "issue";
        const runEvidence = (isReview || scenario === "issue-triage-related")
          ? `\n<sub>Codekeeper workflow run: https://github.com/${REPO}/actions/runs/${staleMarker ? 78 : 77}</sub>`
          : "";
        const controlledFixBody = `Codekeeper opened a repair pull request: https://github.com/${REPO}/pull/14\n${marker}`;
        return response({
          data: {
            repository: {
              [object]: {
                comments: {
                  nodes: [{ body: scenario === "controlled-fix" ? controlledFixBody : `summary${runEvidence}\n${marker}`, updatedAt: staleMarker ? RUN_CREATED : lateMarker ? LATE_PUBLICATION : MARKER_UPDATED, author: { login: APP.graphqlLogin, databaseId: foreignAppMarker ? 100 : Number(APP.id) } }],
                  pageInfo: { hasPreviousPage: markerHasPreviousPage, hasNextPage: false }
                }
              }
            }
          }
        });
      }
      if (text.includes("files(first:100)")) {
        return response({
          data: {
            repository: {
              pullRequest: {
                files: { nodes: FIXTURE_ALLOWED_FIX_PATHS.map((file) => ({ path: file })), pageInfo: { hasNextPage: false } }
              }
            }
          }
        });
      }
      if (text.includes("body author")) {
        assert.match(text, /autoMergeRequest\{enabledAt\}/);
        assert.match(text, /isDraft baseRefName headRefOid headRefName headRepository\{nameWithOwner\}/);
        return response({
          data: {
            repository: {
              pullRequest: {
                number: 14,
                url: `https://github.com/${REPO}/pull/14`,
                state: "OPEN",
                isDraft: fixDraft,
                baseRefName: fixRetarget ? "release" : "main",
                headRefOid: invalidFixHead ? "main" : alteredFixHead ? SHA : HEAD,
                headRepository: { nameWithOwner: fixFork ? "owner/codekeeper-acceptance-other" : REPO },
                mergedAt: null,
                autoMergeRequest: null,
                headRefName: branch,
                createdAt: lateFixPull ? LATE_PUBLICATION : SUBJECT_UPDATED,
                body: `Closes #${issueNumber}\n<!-- codekeeper:repair=${wrongRepairMarker ? "0".repeat(64) : fingerprint} -->`,
                author: { login: APP.graphqlLogin, databaseId: Number(APP.id) }
              }
            }
          }
        });
      }
    }
    throw new Error(`Unexpected fake gh command: ${text}`);
  };
  return {
    runner,
    calls,
    get runViewCount() { return runViewCount; },
    get workflowListCount() { return workflowListCount; }
  };
}

test("source pin parser requires exact matching bootstrap and reusable workflow pins", () => {
  const workflow = "codekeeper-maintain.yml";
  const bootstrap = `owner/codekeeper/tools/codekeeper@${SHA}`;
  const reusable = `owner/codekeeper/.github/workflows/${workflow}@${SHA}`;
  const exact = callerSource(workflow);
  const quoted = exact
    .replace(`- uses: ${bootstrap}`, `- uses: "${bootstrap}"`)
    .replace(`uses: ${reusable}`, `uses: '${reusable}'`);
  assert.equal(parsePinnedWorkflowUses(exact, workflow, SHA), true);
  assert.equal(parsePinnedWorkflowUses(quoted, workflow, SHA), true);
  assert.equal(parsePinnedWorkflowUses(`# - uses: ${bootstrap}\n# uses: ${reusable}\n${exact}`, workflow, SHA), true);

  for (const source of [
    exact.replace(`- uses: ${bootstrap}`, `# - uses: ${bootstrap}`),
    exact.replace(`uses: ${reusable}`, `# uses: ${reusable}`),
    exact.replace(bootstrap, `owner/other/tools/codekeeper@${SHA}`),
    exact.replace(bootstrap, `owner/codekeeper/tools/other@${SHA}`),
    exact.replace(bootstrap, `owner/codekeeper/tools/codekeeper@${"f".repeat(40)}`),
    exact.replace(reusable, `owner/codekeeper/.github/workflows/${workflow}@${"f".repeat(40)}`),
    exact.replace(reusable, `owner/codekeeper/.github/workflows/codekeeper-fix.yml@${SHA}`),
    exact.replace("/tools/codekeeper@", "/Tools/codekeeper@"),
    exact.replace("/.github/workflows/", "/.github/Workflows/"),
    exact.replace(bootstrap, "*bootstrap"),
    exact.replace(bootstrap, `\${{ github.repository }}/tools/codekeeper@${SHA}`),
    exact.replace(bootstrap, "owner/codekeeper/tools/codekeeper@main"),
    callerSource(workflow, { bootstrapJobIf: "always()" }),
    callerSource(workflow, { bootstrapStepIf: "always()" }),
    callerSource(workflow, { reusableJobIf: "always()" }),
    callerSource(workflow, { reusableNeeds: null }),
    callerSource(workflow, { reusableNeeds: "other" }),
    callerSource(workflow, { reusableNeeds: '"bootstrap"' }),
    callerSource(workflow, { reusableNeeds: "${{ github.job }}" }),
    callerSource(workflow, { reusableNeeds: "[bootstrap]" }),
    callerSource(workflow, { reusableNeeds: "*bootstrap" }),
    `${exact}  extra:\n    uses: owner/codekeeper/.github/workflows/${workflow}@${SHA}`,
    `${exact}  bootstrap:\n    uses: ${bootstrap}`,
    exact.replace(`- uses: ${bootstrap}`, `- uses: ${bootstrap}\n        if: always()`),
    exact.replace(`- uses: ${bootstrap}`, `- name: bootstrap\n        with:\n          uses: ${bootstrap}`),
    `${exact}notes: |\n  - uses: ${bootstrap}\n  uses: ${reusable}`,
    `jobs:\n  note: ${reusable}`
  ]) {
    assert.throws(() => parsePinnedWorkflowUses(source, "codekeeper-maintain.yml", SHA), /Caller workflow/);
  }
});

test("event caller run-name parser accepts only the exact active durable expressions", () => {
  const review = 'run-name: "Codekeeper review #${{ github.event.pull_request.number }} @${{ github.event.pull_request.head.sha }}"';
  const issue = 'run-name: "Codekeeper issue triage #${{ github.event.issue.number }}"';
  assert.equal(parseEventCallerRunName(review, "review-introduced-defect"), true);
  assert.equal(parseEventCallerRunName(issue, "issue-triage-related"), true);
  for (const source of [
    `# ${review}`,
    'run-name: "Codekeeper review #${{ github.event.pull_request.number }}"',
    `${issue}\nrun-name: "another title"`,
    `  ${issue}`,
    'run-name: ${{ github.event.issue.title }}'
  ]) {
    assert.throws(() => parseEventCallerRunName(source, source.includes("review") ? "review-introduced-defect" : "issue-triage-related"), /deterministic run-name/);
  }
});

test("preflight refuses implicit, unauthenticated, public, wrong-host, and mismatched targets without exposing CLI output", async () => {
  await assert.rejects(() => preflight({ repo: ".", gh: async () => response("") }), /explicit --repo/);
  await assert.rejects(() => preflight({ repo: "owner/unrelated", gh: async () => response("") }), /must begin/);
  await assert.rejects(() => preflight({ repo: REPO, gh: async () => response("token=leak ghp_abcdefghi", 1) }), (error) => error.message === "GitHub CLI command failed");
  await assert.rejects(() => preflight({ repo: REPO, gh: async (args) => args[0] === "auth" ? response("") : response({ ...metadata(), private: false, visibility: "public" }) }), /explicit private GitHub.com/);
  await assert.rejects(() => preflight({ repo: REPO, gh: async (args) => args[0] === "auth" ? response("") : response({ ...metadata(), html_url: "https://ghe.example/owner/codekeeper-acceptance-fixture" }) }), /explicit private GitHub.com/);
  await assert.rejects(() => preflight({ repo: REPO, gh: async (args) => args[0] === "auth" ? response("") : response({ ...metadata(), full_name: "owner/codekeeper-acceptance-other" }) }), /explicit private GitHub.com/);
});

test("scenario gates reject acknowledgements, non-SHAs, missing App identity, and unknown evidence parents before gh", async () => {
  const never = async () => { throw new Error("gh must not run"); };
  const missingAcknowledgement = await scenarioOptions({ "acknowledge-private-acceptance": false });
  const branchRef = await scenarioOptions({ "source-sha": "main" });
  const missingAppId = await manualRunOptions({ pr: "12", "run-id": "77", "app-login": APP.login });
  const nonBotAppLogin = await manualRunOptions({ pr: "12", "run-id": "77", "app-login": APP.graphqlLogin, "app-id": APP.id });
  const missingRunBoundary = await scenarioOptions({ pr: "12", "run-id": "77", "app-login": APP.login, "app-id": APP.id });
  const missingParent = await scenarioOptions({ evidence: path.join(TEMP_ROOT, "not-created-parent", "evidence.json") });
  const oversizedRepository = await scenarioOptions({ repo: `${"o".repeat(40)}/codekeeper-acceptance-fixture` });
  await assert.rejects(() => runScenario({ scenario: "maintenance-dry-run", options: missingAcknowledgement, gh: never }), /acknowledge/);
  await assert.rejects(() => runScenario({ scenario: "maintenance-dry-run", options: branchRef, gh: never }), /40-character/);
  await assert.rejects(() => runScenario({ scenario: "review-introduced-defect", options: missingAppId, gh: never }), /--app-id/);
  await assert.rejects(() => runScenario({ scenario: "review-introduced-defect", options: nonBotAppLogin, gh: never }), /ending in \[bot\]/);
  await assert.rejects(() => runScenario({ scenario: "review-introduced-defect", options: missingRunBoundary, gh: never }), /--run-created-after/);
  await assert.rejects(() => runScenario({ scenario: "maintenance-dry-run", options: missingParent, gh: never }), /output parent must already exist/);
  await assert.rejects(() => runScenario({ scenario: "maintenance-dry-run", options: oversizedRepository, gh: never }), /bounded repository limits/);
});

test("a malformed two-pin source caller fails before a scenario can dispatch", async () => {
  const source = callerSource("codekeeper-maintain.yml", { reusableSha: "main" });
  const fake = fakeGh({ scenario: "maintenance-dry-run", workflowSource: source });
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(result.passed, false);
  assert.equal(result.evidence.dispatchRef, null);
  assert.equal(fake.calls.some((args) => args.includes(`repos/${REPO}/git/refs`)), false);
  assert.equal(fake.calls.some((args) => args[0] === "workflow"), false);
});

test("block-scalar, misplaced, and gated caller pins fail before an acceptance tag can be created", async () => {
  const bootstrap = `owner/codekeeper/tools/codekeeper@${SHA}`;
  const reusable = `owner/codekeeper/.github/workflows/codekeeper-maintain.yml@${SHA}`;
  for (const source of [
    `${callerSource("codekeeper-maintain.yml")}notes: |\n  - uses: ${bootstrap}\n  uses: ${reusable}`,
    `${callerSource("codekeeper-maintain.yml")}  observer:\n    steps:\n      - uses: ${bootstrap}`,
    callerSource("codekeeper-maintain.yml", { bootstrapJobIf: "always()" }),
    callerSource("codekeeper-maintain.yml", { bootstrapStepIf: "always()" }),
    callerSource("codekeeper-maintain.yml", { reusableJobIf: "always()" }),
    callerSource("codekeeper-maintain.yml", { reusableNeeds: null }),
    callerSource("codekeeper-maintain.yml", { reusableNeeds: "other" })
  ]) {
    const fake = fakeGh({ scenario: "maintenance-dry-run", workflowSource: source });
    const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: () => new Date(NOW), sleep: async () => {} });
    assert.equal(result.passed, false);
    assert.equal(result.evidence.dispatchRef, null);
    assert.equal(fake.calls.some((args) => args.includes(`repos/${REPO}/git/refs`)), false);
    assert.equal(fake.calls.some((args) => args[0] === "workflow"), false);
  }
});

test("dispatch refuses tag creation or tag-to-SHA verification failures before workflow dispatch", async () => {
  for (const option of [{ tagCreationFailure: true }, { tagMismatch: true }]) {
    const fake = fakeGh({ scenario: "maintenance-dry-run", ...option });
    const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: () => new Date(NOW), sleep: async () => {} });
    assert.equal(result.passed, false);
    if (option.tagMismatch) assert.match(result.evidence.dispatchRef, /^codekeeper-acceptance\/dispatch-maintenance-dry-run-fedcba987654-[0-9a-f-]{36}$/);
    assert.equal(fake.calls.some((args) => args[0] === "workflow" && args[1] === "run"), false);
  }
});

test("fix policy prevalidation fails before an immutable acceptance tag is created", async () => {
  const fake = fakeGh({ scenario: "controlled-fix", invalidFixPolicy: true });
  const result = await runScenario({ scenario: "controlled-fix", options: await scenarioOptions({ issue: "14", "app-login": APP.login, "app-id": APP.id }), gh: fake.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(result.passed, false);
  assert.equal(result.evidence.dispatchRef, null);
  assert.equal(fake.calls.some((args) => args.includes(`repos/${REPO}/git/refs`)), false);
  assert.equal(fake.calls.some((args) => args[0] === "workflow" && args[1] === "run"), false);
});

test("maintenance dry-run uses a quiescent, actor-bound dispatch boundary and only records skipped publication", async () => {
  const { runner, calls } = fakeGh({ scenario: "maintenance-dry-run" });
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(result.passed, true);
  const dispatch = calls.find((args) => args[0] === "workflow" && args[1] === "run");
  assert.match(dispatch[6], /^codekeeper-acceptance\/dispatch-maintenance-dry-run-fedcba987654-[0-9a-f-]{36}$/);
  assert.equal(dispatch[6], result.evidence.dispatchRef);
  assert.deepEqual(result.evidence.assertions.map((item) => item.passed), [true, true, true]);
  assert.ok(calls.some((args) => args[3] === `repos/${REPO}/contents/.github/workflows/codekeeper-maintain.yml?ref=${encodeURIComponent(result.evidence.dispatchRef)}`));
  assert.ok(calls.some((args) => args[3] === `repos/${REPO}/contents/.github/workflows/codekeeper-maintain.yml?ref=${HEAD}`));
  assert.ok(calls.findIndex((args) => args[3] === `repos/${REPO}/contents/.github/workflows/codekeeper-maintain.yml?ref=${HEAD}`) < calls.findIndex((args) => args.includes(`repos/${REPO}/git/refs`)));
  assert.ok(calls.every((args) => !args.join(" ").match(/\b(secret|token|password|api[_-]?key)\b/i)));
});

test("maintenance refuses an incomplete bounded workflow-run inventory", async () => {
  const fake = fakeGh({ scenario: "maintenance-dry-run" });
  const runner = async (args) => {
    if (args[0] === "api" && args[3]?.includes("/actions/workflows/codekeeper-maintain.yml/runs?")) {
      return response({ total_count: 1_001, workflow_runs: [] });
    }
    return fake.runner(args);
  };
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(result.passed, false);
  assert.equal(fake.calls.some((args) => args[0] === "workflow" && args[1] === "run"), false);
});

test("dispatch revalidates stable baseline runs from each bounded workflow inventory", async () => {
  const clock = fakeClock();
  const fake = fakeGh({ scenario: "maintenance-dry-run", baselineRun: true, completionAfterRunView: 2 });
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: clock.now, sleep: clock.sleep });
  assert.equal(result.passed, true);
  assert.equal(fake.runViewCount, 3);
  assert.equal(fake.calls.filter((args) => args[3] === `repos/${REPO}/actions/runs/66`).length, 0);
  assert.equal(fake.workflowListCount, fake.runViewCount + 3);
});

test("maintenance accepts a selected run that completes after the former 60-second wait", async () => {
  const clock = fakeClock();
  const fake = fakeGh({ scenario: "maintenance-dry-run", completionAfterRunView: 13 });
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: clock.now, sleep: clock.sleep });
  assert.equal(result.passed, true);
  assert.equal(fake.runViewCount, 14);
  assert.equal(clock.elapsed(), 65_000);
});

test("maintenance fails closed when selected workflow completion exceeds the bounded wait", async () => {
  const clock = fakeClock();
  const fake = fakeGh({ scenario: "maintenance-dry-run", neverCompletes: true });
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: clock.now, sleep: clock.sleep });
  assert.equal(result.passed, false);
  assert.equal(fake.runViewCount, WORKFLOW_COMPLETION_POLL_ATTEMPTS);
  assert.equal(clock.elapsed(), WORKFLOW_COMPLETION_TIMEOUT_MS);
});

test("maintenance rejects completion metadata that crosses the bounded deadline", async () => {
  const clock = fakeClock();
  const fake = fakeGh({
    scenario: "maintenance-dry-run",
    completionAfterRunView: WORKFLOW_COMPLETION_POLL_ATTEMPTS - 1,
    onRunMetadata: async () => clock.advance(1)
  });
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: clock.now, sleep: clock.sleep });
  assert.equal(result.passed, false);
  assert.equal(fake.runViewCount, WORKFLOW_COMPLETION_POLL_ATTEMPTS);
  assert.equal(clock.elapsed(), WORKFLOW_COMPLETION_TIMEOUT_MS + 1);
});

test("maintenance rejects a second matching run that appears after completion", async () => {
  const clock = fakeClock();
  const fake = fakeGh({ scenario: "maintenance-dry-run", concurrentDispatchAfterCompletion: true });
  const result = await runScenario({ scenario: "maintenance-dry-run", options: await scenarioOptions(), gh: fake.runner, now: clock.now, sleep: clock.sleep });
  assert.equal(result.passed, false);
  assert.equal(fake.runViewCount, 1);
});

test("review accepts a pull_request_target base SHA while binding the current PR head through title evidence and the run to the base branch", async () => {
  const good = fakeGh({ scenario: "review-introduced-defect" });
  const pass = await runScenario({ scenario: "review-introduced-defect", options: await manualRunOptions({ pr: "12", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: good.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(pass.passed, true);
  assert.ok(good.calls.some((args) => args[3] === `repos/${REPO}/contents/.github/workflows/codekeeper-review.yml?ref=${HEAD}`));
  const stale = fakeGh({ scenario: "review-introduced-defect", staleMarker: true });
  const staleResult = await runScenario({ scenario: "review-introduced-defect", options: await manualRunOptions({ pr: "12", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: stale.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(staleResult.passed, false);
  const foreign = fakeGh({ scenario: "review-introduced-defect", foreignAppMarker: true });
  const foreignResult = await runScenario({ scenario: "review-introduced-defect", options: await manualRunOptions({ pr: "12", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: foreign.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(foreignResult.passed, false);
  for (const option of [{ wrongDisplayTitle: true }, { wrongReviewGateName: true }, { reviewDraft: true }, { reviewRetarget: true }, { reviewHeadChanges: true }, { wrongReviewRunBaseBranch: true }]) {
    const falsePositive = fakeGh({ scenario: "review-introduced-defect", ...option });
    const result = await runScenario({ scenario: "review-introduced-defect", options: await manualRunOptions({ pr: "12", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: falsePositive.runner, now: () => new Date(NOW), sleep: async () => {} });
    assert.equal(result.passed, false);
  }
});

test("review rejects an explicitly selected run created before the supplied trigger boundary", async () => {
  const fake = fakeGh({ scenario: "review-introduced-defect" });
  const runner = async (args) => {
    const result = await fake.runner(args);
    if (args[0] === "run" && args[1] === "view") {
      const payload = JSON.parse(result.stdout);
      payload.createdAt = "2026-08-07T23:59:59.999Z";
      return response(payload);
    }
    if (args[3] === `repos/${REPO}/actions/runs/77`) {
      const payload = JSON.parse(result.stdout);
      payload.created_at = "2026-08-07T23:59:59.999Z";
      return response(payload);
    }
    return result;
  };
  const result = await runScenario({ scenario: "review-introduced-defect", options: await manualRunOptions({ pr: "12", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(result.passed, false);
});

test("review requires a complete timezone-qualified trigger instant", async () => {
  for (const boundary of ["1", "2026-08-08", "2026-08-08T00:00:00"]) {
    await assert.rejects(
      runScenario({
        scenario: "review-introduced-defect",
        options: await manualRunOptions({
          pr: "12",
          "run-id": "77",
          "run-created-after": boundary,
          "app-login": APP.login,
          "app-id": APP.id
        }),
        gh: fakeGh({ scenario: "review-introduced-defect" }).runner,
        now: () => new Date(NOW),
        sleep: async () => {}
      }),
      /--run-created-after must be an ISO-8601 timestamp/
    );
  }
});

test("issue triage rejects stale publisher-run evidence and wrong durable titles", async () => {
  const good = fakeGh({ scenario: "issue-triage-related" });
  const pass = await runScenario({ scenario: "issue-triage-related", options: await manualRunOptions({ issue: "13", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: good.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(pass.passed, true);
  assert.ok(good.calls.some((args) => args[3] === `repos/${REPO}/contents/.github/workflows/codekeeper-issues.yml?ref=${HEAD}`));
  const stale = fakeGh({ scenario: "issue-triage-related", staleMarker: true });
  const staleResult = await runScenario({ scenario: "issue-triage-related", options: await manualRunOptions({ issue: "13", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: stale.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(staleResult.passed, false);
  const wrongTitle = fakeGh({ scenario: "issue-triage-related", wrongDisplayTitle: true });
  const wrongTitleResult = await runScenario({ scenario: "issue-triage-related", options: await manualRunOptions({ issue: "13", "run-id": "77", "app-login": APP.login, "app-id": APP.id }), gh: wrongTitle.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(wrongTitleResult.passed, false);
});

test("controlled fix rejects concurrent runs and accepts exactly one current canonical repair PR", async () => {
  const good = fakeGh({ scenario: "controlled-fix" });
  const pass = await runScenario({ scenario: "controlled-fix", options: await scenarioOptions({ issue: "14", "app-login": APP.login, "app-id": APP.id }), gh: good.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(pass.passed, true);
  assert.deepEqual(pass.evidence.assertions.map((item) => item.passed), [true, true, true, true, true, true, true]);
  assert.ok(good.calls.some((args) => args[3] === `repos/${REPO}/contents/.github/codekeeper.json?ref=${encodeURIComponent(pass.evidence.dispatchRef)}`));
  assert.ok(good.calls.some((args) => args[3] === `repos/${REPO}/contents/.github/codekeeper.json?ref=${HEAD}`));
  assert.ok(good.calls.findIndex((args) => args[3] === `repos/${REPO}/contents/.github/codekeeper.json?ref=${HEAD}`) < good.calls.findIndex((args) => args.includes(`repos/${REPO}/git/refs`)));
  const concurrent = fakeGh({ scenario: "controlled-fix", concurrentDispatch: true });
  const failed = await runScenario({ scenario: "controlled-fix", options: await scenarioOptions({ issue: "14", "app-login": APP.login, "app-id": APP.id }), gh: concurrent.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(failed.passed, false);
  assert.equal(concurrent.calls.some((args) => args[0] === "workflow"), true);
  const wrongMarker = fakeGh({ scenario: "controlled-fix", wrongRepairMarker: true });
  const wrongMarkerResult = await runScenario({ scenario: "controlled-fix", options: await scenarioOptions({ issue: "14", "app-login": APP.login, "app-id": APP.id }), gh: wrongMarker.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(wrongMarkerResult.passed, false);
  const rerun = fakeGh({ scenario: "controlled-fix", baselineRerun: true });
  const rerunResult = await runScenario({ scenario: "controlled-fix", options: await scenarioOptions({ issue: "14", "app-login": APP.login, "app-id": APP.id }), gh: rerun.runner, now: () => new Date(NOW), sleep: async () => {} });
  assert.equal(rerunResult.passed, false);
  assert.equal(rerun.calls.some((args) => args[0] === "workflow" && args[1] === "run"), true);
  for (const option of [{ fixDraft: true }, { fixFork: true }, { fixRetarget: true }, { invalidFixHead: true }, { alteredFixHead: true }, { multipleFixCommits: true }, { foreignFixCommit: true }, { lateFixCommit: true }, { lateFixPull: true }, { lateMarker: true }, { missingPublicationParent: true }, { multiplePublicationParents: true }, { malformedPublicationParent: true }, { mismatchedPublicationParent: true }]) {
    const unsafeShape = fakeGh({ scenario: "controlled-fix", ...option });
    const unsafeResult = await runScenario({ scenario: "controlled-fix", options: await scenarioOptions({ issue: "14", "app-login": APP.login, "app-id": APP.id }), gh: unsafeShape.runner, now: () => new Date(NOW), sleep: async () => {} });
    assert.equal(unsafeResult.passed, false);
  }
});

test("controlled-fix recovery proves retained evidence with a parent anchored to the run SHA, without dispatch, mutation, or log reads", async () => {
  const fake = fakeGh({ scenario: "controlled-fix", recoveryDispatchRef: DISPATCH_REF, currentDefaultBranch: "release" });
  const result = await recoverControlledFix({ options: await recoveryOptions(), gh: fake.runner, now: () => new Date(NOW) });
  assert.equal(result.passed, true);
  assert.equal(result.evidence.scenario, "controlled-fix");
  assert.equal(result.evidence.dispatchRef, DISPATCH_REF);
  assert.equal(result.evidence.workflow.id, 77);
  assert.equal(result.evidence.resource.number, 14);
  assert.deepEqual(result.evidence.assertions.map((item) => item.passed), Array(9).fill(true));
  assert.ok(fake.calls.some((args) => args[3] === `repos/${REPO}/git/ref/tags/${encodeURIComponent(DISPATCH_REF)}`));
  assert.ok(fake.calls.some((args) => args[3] === `repos/${REPO}/actions/workflows/codekeeper-fix.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(DISPATCH_REF)}&per_page=100`));
  assert.ok(fake.calls.some((args) => args[3] === `repos/${REPO}/contents/.github/workflows/codekeeper-fix.yml?ref=${encodeURIComponent(DISPATCH_REF)}`));
  assert.ok(fake.calls.some((args) => args[3] === `repos/${REPO}/contents/.github/workflows/codekeeper-fix.yml?ref=${HEAD}`));
  assert.equal(fake.calls.some((args) => args[0] === "workflow" || args.includes("POST") || args.includes("PATCH") || args.includes("PUT") || args.includes("DELETE")), false);
  assert.equal(fake.calls.some((args) => args.some((argument) => /(?:^|\/)logs(?:$|\?)/.test(argument)) || args.includes("--log")), false);
});

test("controlled-fix recovery fails closed for non-private targets and wrong retained evidence", async () => {
  const cases = [
    { fake: { publicRepository: true }, options: {} },
    { fake: { tagMismatch: true }, options: {} },
    { fake: {}, options: { "run-id": "78" } },
    { fake: {}, options: { pr: "15" } },
    { fake: { wrongRepairMarker: true }, options: {} },
    { fake: { duplicateRecoveredRun: true }, options: {} },
    { fake: { markerHasPreviousPage: true }, options: {} },
    { fake: { fixDraft: true }, options: {} },
    { fake: { fixFork: true }, options: {} },
    { fake: { fixRetarget: true }, options: {} },
    { fake: { invalidFixHead: true }, options: {} },
    { fake: { alteredFixHead: true }, options: {} },
    { fake: { multipleFixCommits: true }, options: {} },
    { fake: { foreignFixCommit: true }, options: {} },
    { fake: { lateFixCommit: true }, options: {} },
    { fake: { lateFixPull: true }, options: {} },
    { fake: { lateMarker: true }, options: {} },
    { fake: { missingPublicationParent: true }, options: {} },
    { fake: { multiplePublicationParents: true }, options: {} },
    { fake: { malformedPublicationParent: true }, options: {} },
    { fake: { mismatchedPublicationParent: true }, options: {} },
    { fake: { wrongRunActor: true }, options: {} },
    { fake: { wrongAttributedActor: true }, options: {} },
    { fake: { jobTotalCount: 2 }, options: {} },
    { fake: { jobTotalCount: 101 }, options: {} }
  ];
  for (const item of cases) {
    const fake = fakeGh({ scenario: "controlled-fix", recoveryDispatchRef: DISPATCH_REF, ...item.fake });
    const result = await recoverControlledFix({ options: await recoveryOptions(item.options), gh: fake.runner, now: () => new Date(NOW) });
    assert.equal(result.passed, false);
    assert.equal(result.evidence.scenario, "controlled-fix");
    assert.equal(result.evidence.dispatchRef, DISPATCH_REF);
    assert.equal(fake.calls.some((args) => args[0] === "workflow" || args.includes("POST") || args.includes("PATCH") || args.includes("PUT") || args.includes("DELETE")), false);
    assert.equal(fake.calls.some((args) => args.some((argument) => /(?:^|\/)logs(?:$|\?)/.test(argument)) || args.includes("--log")), false);
  }
});

test("controlled-fix recovery requires every explicit immutable identity before gh", async () => {
  const required = ["repo", "source-sha", "acknowledge-private-acceptance", "fixture-checkout", "evidence", "issue", "run-id", "pr", "dispatch-ref", "app-login", "app-id"];
  for (const option of required) {
    const options = await recoveryOptions();
    delete options[option];
    let called = false;
    await assert.rejects(() => recoverControlledFix({ options, gh: async () => { called = true; return response(""); } }));
    assert.equal(called, false, option);
  }
  const malformed = await recoveryOptions({ "dispatch-ref": "main" });
  await assert.rejects(() => recoverControlledFix({ options: malformed, gh: async () => { throw new Error("gh must not run"); } }), /exact retained controlled-fix acceptance tag/);
  for (const dispatchRef of [
    DISPATCH_REF.replace("-4316-", "-5316-"),
    DISPATCH_REF.replace("-b704-", "-7704-")
  ]) {
    const malformedUuid = await recoveryOptions({ "dispatch-ref": dispatchRef });
    await assert.rejects(() => recoverControlledFix({ options: malformedUuid, gh: async () => { throw new Error("gh must not run"); } }), /exact retained controlled-fix acceptance tag/);
  }
  const recoveryOnlyOptions = await recoveryOptions();
  await assert.rejects(() => runScenario({ scenario: "controlled-fix", options: recoveryOnlyOptions, gh: async () => { throw new Error("gh must not run"); } }), /does not apply/);
});

test("evidence rejects fixture containment and an external-directory symlink into the fixture, then writes atomically with private permissions", async () => {
  const evidence = {
    schemaVersion: 1,
    targetRepository: REPO,
    scenario: "maintenance-dry-run",
    sourceSha: SHA,
    dispatchRef: null,
    workflow: { id: 77, url: `https://github.com/${REPO}/actions/runs/77`, conclusion: "success" },
    resource: null,
    assertions: [{ expectation: "publication skipped", passed: true }],
    passed: true,
    startedAt: NOW,
    completedAt: RUN_CREATED
  };
  const outputParent = await mkdtemp(path.join(TEMP_ROOT, "codekeeper-evidence-parent-"));
  await assert.rejects(() => prepareEvidenceDestination({ evidencePath: path.join(FIXTURE, "evidence.json"), fixtureCheckout: FIXTURE }), /outside/);
  const external = await mkdtemp(path.join(TEMP_ROOT, "codekeeper-external-"));
  await symlink(FIXTURE, path.join(external, "points-into-fixture"));
  await assert.rejects(() => prepareEvidenceDestination({ evidencePath: path.join(external, "points-into-fixture", "evidence.json"), fixtureCheckout: FIXTURE }), /symbolic-link/);
  const output = path.join(outputParent, "evidence.json");
  const destination = await prepareEvidenceDestination({ evidencePath: output, fixtureCheckout: FIXTURE });
  await writeEvidenceAtomically({ evidence, destination });
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(outputParent)).sort(), ["evidence.json"]);
  assert.equal(JSON.parse(await readFile(output, "utf8")).passed, true);
  await assert.rejects(() => writeEvidenceAtomically({ evidence, destination }), /refusing to overwrite/);
});

test("redaction handles credential forms and command failures never include raw gh output", async () => {
  const probes = [
    "GH_TOKEN=github-token-value",
    "GITHUB_TOKEN: github-token-value",
    "ghr_abcdefghijklmno",
    "ghp_abcdefghijklmno",
    "github_pat_abcdefghijklmno",
    "Bearer bearer-secret-value",
    "https://user:password@example.invalid/path",
    "-----BEGIN PRIVATE KEY-----\nprivate-key-value\n-----END PRIVATE KEY-----"
  ];
  for (const probe of probes) {
    const output = redact(probe);
    assert.equal(output.includes("github-token-value") || output.includes("bearer-secret-value") || output.includes("password") || output.includes("private-key-value") || output.includes("abcdefghijklmno"), false, probe);
  }
  const { runner } = fakeGh({ scenario: "maintenance-dry-run", commandFailure: true });
  await assert.rejects(() => preflight({ repo: REPO, gh: runner }), (error) => error.message === "GitHub CLI command failed");
  assert.deepEqual(safeEnvironment({ PATH: "/bin", HOME: "/tmp/home", GH_TOKEN: "no", GITHUB_TOKEN: "no", OPENAI_API_KEY: "no" }), { PATH: "/bin", HOME: "/tmp/home" });
});

test("process runner terminates a non-closing child with SIGTERM then SIGKILL and removes listeners", async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.signals = [];
    }
    kill(signal) {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new FakeChild();
  const runner = createGhRunner({ spawn: () => child, timeoutMs: 2, killGraceMs: 2 });
  await assert.rejects(() => runner(["auth", "status"]), /GitHub CLI command failed/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("evidence schema remains bounded and command parsing requires explicit options", () => {
  const evidence = {
    schemaVersion: 1,
    targetRepository: REPO,
    scenario: "maintenance-dry-run",
    sourceSha: SHA,
    dispatchRef: null,
    workflow: null,
    resource: null,
    assertions: [{ expectation: "failed safely", passed: false }],
    passed: false,
    startedAt: NOW,
    completedAt: RUN_CREATED
  };
  assert.equal(validateEvidence(evidence), evidence);
  assert.throws(() => validateEvidence({ ...evidence, logs: "forbidden" }), EvidenceError);
  assert.throws(() => validateEvidence({ ...evidence, targetRepository: `${"o".repeat(40)}/codekeeper-acceptance-fixture` }), /targetRepository/);
  assert.throws(() => validateEvidence({
    ...evidence,
    workflow: { id: 77, url: `https://github.com/${"x".repeat(2048)}`, conclusion: "success" }
  }), /workflow.url/);
  const boundedUrl = `https://github.com/${"x".repeat(2028)}`;
  assert.throws(() => validateEvidence({
    ...evidence,
    workflow: { id: 77, url: boundedUrl, conclusion: "success" },
    resource: { kind: "issue", number: 1, url: boundedUrl },
    assertions: Array.from({ length: 12 }, () => ({ expectation: "x".repeat(180), passed: true }))
  }), /serialized size/);
  assert.deepEqual(parseCommandLine(["preflight", "--repo", REPO]), { command: "preflight", options: { repo: REPO } });
  assert.equal(parseCommandLine(["recover-controlled-fix", "--repo", REPO]).command, "recover-controlled-fix");
  const usage = formatUsage();
  assert.equal(usage.match(/--app-login 'APP\[bot\]'/g)?.length, 4);
  assert.doesNotMatch(usage, /--app-login APP\[bot\]/);
  assert.throws(() => parseCommandLine(["maintenance-dry-run", "--repo", REPO, "--repo", REPO]), /Duplicate/);
  assert.throws(() => parseCommandLine(["maintenance-dry-run", "--current-repo", "true"]), /unsupported/);
});
