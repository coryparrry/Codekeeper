import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import {
  renderRivetIssueTriageWorkflow,
  renderRivetIssueTriageWorkflowV013,
  renderRivetIssueTriageWorkflowV013Array,
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
  assert.match(
    source,
    /issues:\n    types: \[opened\]\n  issue_comment:\n    types: \[created\]\n  roles: all\n  needs: \[issue_context\][\s\S]*checkout: false\nif: needs\.issue_context\.outputs\.eligible == 'true'/,
  );
  assert.match(source, /permissions:\n  contents: read\n  issues: read/);
  assert.match(source, /engine: codex\nmodel: gpt-5\.6-luna/);
  assert.match(
    source,
    /inlined-imports: true\nimports:\n  - \.github\/rivet\/agents\/issue-triager\.md/,
  );
  assert.match(source, /tools:\n  bash: \[\]\n  cli-proxy: false/);
  assert.match(
    source,
    /github:\n    toolsets: \[issues\]\n    allowed-repos:\n      - "\$\{\{ github\.repository \}\}"\n    min-integrity: none\n    allowed:\n      - name: issue_read\n        max-calls: 2\n      - name: search_issues\n        max-calls: 3/,
  );
  assert.match(source, /report-incomplete:\n    create-issue: false/);
  assert.match(
    source,
    /jobs:\n    publish-triage-comment:[\s\S]*permissions: \{\}[\s\S]*permission-issues: write/,
  );
  assert.match(
    source,
    /jobs:\n  issue_context:[\s\S]*eligible: \$\{\{ steps\.snapshot\.outputs\.eligible \}\}[\s\S]*uses: \.\/\.github\/rivet\/actions\/prepare-issue-context/,
  );
  assert.match(
    source,
    /safe_outputs:\n    if: needs\.agent\.result == 'success'/,
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
  assert.match(source, /<untrusted-issue-context>/);
  assert.match(
    source,
    /missing_information:[\s\S]*previous_marker_comment_id:/,
  );
  assert.match(source, /For every follow-up, publish a new state/);
  assert.match(
    source,
    /missing material reporter evidence is a useful response:[\s\S]*Call only `noop` when there is no material question/,
  );
  assert.match(source, /issue_number: issueNumber/);
  assert.ok(
    RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT.split("\n").every((line) =>
      source.includes(line),
    ),
  );
  assert.match(source, /Call only `noop`/);

  assert.doesNotMatch(
    source,
    /^  (?:add-comment|create-issue|update-issue|close-issue|add-labels|remove-labels|create-pull-request|push-to-pull-request-branch|merge-pull-request):/m,
  );
});

test("freezes the scalar repository guard used before the gateway fix", () => {
  const source = renderRivetIssueTriageWorkflowV013();
  assert.match(
    source,
    /allowed-repos: "\$\{\{ github\.repository \}\}"\n    min-integrity: none/,
  );
  assert.doesNotMatch(source, /allowed-repos:\n      -/);
  assert.match(source, /opened event with no useful response/);
  assert.doesNotMatch(source, /missing material reporter evidence/);
});

test("freezes the array guard before missing-information comments", () => {
  const source = renderRivetIssueTriageWorkflowV013Array();
  assert.match(source, /allowed-repos:\n      -/);
  assert.match(source, /opened event with no useful response/);
  assert.doesNotMatch(source, /missing material reporter evidence/);
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

test("binds opened and follow-up publication to fresh App-owned state", async () => {
  const publish = new (Object.getPrototypeOf(async function () {}).constructor)(
    "require",
    "process",
    "context",
    "github",
    "Buffer",
    RIVET_ISSUE_TRIAGE_PUBLISH_SCRIPT,
  );
  const calls = [];
  const issue = {
    id: 101,
    number: 12,
    state: "open",
    user: { login: "reporter", type: "User" },
    comments: 0,
  };
  let comments = [];
  const run = (items, context) =>
    publish(
      () => ({
        readFileSync: () => JSON.stringify({ items, errors: [] }),
      }),
      {
        env: {
          GH_AW_AGENT_OUTPUT: "/agent-output.json",
          RIVET_APP_BOT_LOGIN: "rivet-test",
        },
      },
      context,
      {
        rest: {
          issues: {
            get: async () => ({
              data: { ...issue, comments: comments.length },
            }),
            listComments: async () => ({ data: comments }),
            createComment: async (request) => calls.push(request),
          },
        },
      },
      Buffer,
    );

  const openedContext = {
    eventName: "issues",
    payload: {
      action: "opened",
      issue: { id: 101, number: 12, user: { login: "reporter" } },
      sender: { login: "reporter", type: "User" },
    },
    repo: { owner: "owner", repo: "repository" },
  };
  await run(
    [
      {
        type: "publish_triage_comment",
        comment: "Need a repro.",
        missing_information: '["Exact reproduction steps?"]',
        previous_marker_comment_id: "0",
      },
    ],
    openedContext,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].issue_number, 12);
  assert.equal(
    calls[0].body,
    'Need a repro.\n\n<!-- rivet-triage-state:v1 {"missingInformation":["Exact reproduction steps?"]} -->',
  );

  comments = [
    {
      id: 50,
      body: calls[0].body,
      user: { login: "rivet-test[bot]", type: "Bot" },
      author_association: "NONE",
      performed_via_github_app: { id: 7 },
    },
    {
      id: 51,
      body: "Click Save twice.",
      user: { login: "reporter", type: "User" },
      author_association: "NONE",
      performed_via_github_app: null,
    },
  ];
  const followupContext = {
    eventName: "issue_comment",
    payload: {
      action: "created",
      issue: { id: 101, number: 12, user: { login: "reporter" } },
      comment: comments[1],
      sender: { login: "reporter", type: "User" },
    },
    repo: { owner: "owner", repo: "repository" },
  };
  await run(
    [
      {
        type: "publish_triage_comment",
        comment: "Thanks, this is actionable.",
        missing_information: "[]",
        previous_marker_comment_id: "50",
      },
    ],
    followupContext,
  );
  assert.equal(
    calls[1].body,
    'Thanks, this is actionable.\n\n<!-- rivet-triage-state:v1 {"missingInformation":[]} -->',
  );

  comments.push({
    id: 52,
    body: "It also fails after restart.",
    user: { login: "reporter", type: "User" },
    author_association: "NONE",
    performed_via_github_app: null,
  });
  await assert.rejects(
    run(
      [
        {
          type: "publish_triage_comment",
          comment: "Stale response.",
          missing_information: "[]",
          previous_marker_comment_id: "50",
        },
      ],
      followupContext,
    ),
    /invalid bound comment output/,
  );

  await assert.rejects(
    run(
      [
        {
          type: "publish_triage_comment",
          comment: "redirect",
          missing_information: "[]",
          previous_marker_comment_id: "0",
          item_number: 99,
        },
      ],
      openedContext,
    ),
    /invalid bound comment output/,
  );
  await assert.rejects(
    run(
      [
        {
          type: "publish_triage_comment",
          comment: "stale",
          missing_information: '["bad --!>"]',
          previous_marker_comment_id: "50",
        },
      ],
      followupContext,
    ),
    /invalid bound comment output/,
  );
  await assert.rejects(
    run(
      [
        {
          type: "publish_triage_comment",
          comment: "stale",
          missing_information: "[]",
          previous_marker_comment_id: "49",
        },
      ],
      followupContext,
    ),
    /invalid bound comment output/,
  );
});
