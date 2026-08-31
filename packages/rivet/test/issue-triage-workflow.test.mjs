import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import {
  renderRivetIssueTriageWorkflow,
  RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS,
  RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  RIVET_ISSUE_TRIAGE_WORKFLOW_ID,
} from "../src/workflows/issue-triage.mjs";

test("renders bounded incoming issue triage", () => {
  const source = renderRivetIssueTriageWorkflow();

  assert.equal(RIVET_ISSUE_TRIAGE_WORKFLOW_ID, "rivet-issue-triage");
  assert.deepEqual(RIVET_ISSUE_TRIAGE_NATIVE_IMPORTS, [
    ".github/rivet/agents/issue-triager.md",
  ]);
  assert.match(source, /issues:\n    types: \[opened\]\n  roles: all/);
  assert.match(source, /permissions:\n  contents: read\n  issues: read/);
  assert.match(source, /engine: codex\nmodel: gpt-5\.6-luna/);
  assert.match(
    source,
    /inlined-imports: true\nimports:\n  - \.github\/rivet\/agents\/issue-triager\.md/,
  );
  assert.match(source, /tools:\n  bash: \[\]\n  cli-proxy: false/);
  assert.match(
    source,
    /github:\n    toolsets: \[issues\]\n    allowed-repos: "\$\{\{ github\.repository \}\}"\n    min-integrity: none\n    allowed:\n      - name: issue_read\n        max-calls: 2\n      - name: search_issues\n        max-calls: 3/,
  );
  assert.match(source, /report-incomplete:\n    create-issue: false/);
  assert.match(
    source,
    /jobs:\n    publish-triage-comment:[\s\S]*permissions: \{\}[\s\S]*permission-issues: write/,
  );
  assert.match(
    source,
    /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/,
  );
  assert.match(
    source,
    /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/,
  );
  assert.match(source, /call `publish_triage_comment` once/);
  assert.match(source, /issue_number: context\.payload\.issue\.number/);
  assert.ok(
    RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT.split("\n").every((line) =>
      source.includes(line),
    ),
  );
  assert.match(source, /call only `noop`/);

  assert.doesNotMatch(
    source,
    /^  (?:add-comment|create-issue|update-issue|close-issue|add-labels|remove-labels|create-pull-request|push-to-pull-request-branch|merge-pull-request):/m,
  );
});

test("projects the configured review model and requires automatic triage", () => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.models.review.engine = "claude";
  configuration.models.review.model = "claude-sonnet-5";
  assert.match(
    renderRivetIssueTriageWorkflow({ configuration }),
    /engine: claude\nmodel: claude-sonnet-5/,
  );

  configuration.issues.triage = "disabled";
  assert.throws(
    () => renderRivetIssueTriageWorkflow({ configuration }),
    /requires automatic triage/,
  );
});

test("rejects unmanaged profile imports", () => {
  assert.throws(
    () => renderRivetIssueTriageWorkflow({ nativeImports: ["../agent.md"] }),
    /must be a managed local Markdown path/,
  );
});

test("binds comment publication to the triggering issue", async () => {
  const publish = new (Object.getPrototypeOf(async function () {}).constructor)(
    "require",
    "process",
    "context",
    "github",
    "Buffer",
    RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  );
  const calls = [];
  const run = (items) =>
    publish(
      () => ({
        readFileSync: () => JSON.stringify({ items, errors: [] }),
      }),
      { env: { GH_AW_AGENT_OUTPUT: "/agent-output.json" } },
      {
        eventName: "issues",
        payload: { action: "opened", issue: { number: 12 } },
        repo: { owner: "owner", repo: "repository" },
      },
      {
        rest: {
          issues: {
            createComment: async (request) => calls.push(request),
          },
        },
      },
      Buffer,
    );

  await run([{ type: "publish_triage_comment", comment: "Need a repro." }]);
  assert.deepEqual(calls, [
    {
      owner: "owner",
      repo: "repository",
      issue_number: 12,
      body: "Need a repro.",
    },
  ]);
  await assert.rejects(
    run([
      {
        type: "publish_triage_comment",
        comment: "redirect",
        item_number: 99,
      },
    ]),
    /invalid bound comment output/,
  );
});
