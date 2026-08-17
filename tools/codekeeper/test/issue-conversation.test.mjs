import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareIssue } from "../src/lib/prepare.mjs";
import { ISSUE_TRIAGE_MARKER, issueTriageStateMarker } from "../src/lib/markers.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const config = JSON.parse(await readFile(path.join(projectRoot, ".github/codekeeper.json"), "utf8"));
const appLogin = "codekeeper-app[bot]";
const appId = "12345";
const clientId = "Iv1.example_client";

function triageResult({ missingInformation = ["Please include steps to reproduce the failure."] } = {}) {
  return {
    mode: "issue",
    summary: "More information is needed.",
    type: "bug",
    priority: "p3",
    labels: [],
    actionable: false,
    missingInformation,
    duplicateOf: null,
    duplicateConfidence: "none",
    implementationRecommendation: "no",
    decision: { required: false, question: "", rationale: "", options: [] },
    comment: "Please provide the missing reproduction details."
  };
}

function botMarker(result = triageResult()) {
  return `## Codekeeper triage\n\n${issueTriageStateMarker(result)}\n${ISSUE_TRIAGE_MARKER}`;
}

function currentIssue({ comments = 2 } = {}) {
  return {
    number: 7,
    title: "Export crashes",
    body: "Exporting a report crashes.",
    html_url: "https://github.com/acme/example/issues/7",
    updated_at: "2026-08-17T10:02:00Z",
    user: { login: "reporter" },
    labels: [{ name: "bug" }],
    comments
  };
}

function comment({ id, login, body, createdAt, association = "NONE", type = "User" }) {
  return {
    id,
    body,
    created_at: createdAt,
    updated_at: createdAt,
    author_association: association,
    user: { login, id: login === appLogin ? appId : String(Number(id) + 100), type }
  };
}

async function withFixture({ trigger, marker = botMarker(), issue = currentIssue(), extraComments = [] }, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-conversation-"));
  const eventPath = path.join(root, "event.json");
  const comments = [
    comment({ id: 1, login: appLogin, body: marker, createdAt: "2026-08-17T10:00:00Z", type: "Bot" }),
    trigger,
    ...extraComments
  ];
  await writeFile(eventPath, JSON.stringify({
    action: "created",
    repository: { full_name: "acme/example" },
    issue: { number: 7 },
    comment: { id: trigger.id, body: trigger.body, user: { login: trigger.user.login } }
  }), "utf8");
  const originalFetch = globalThis.fetch;
  const saved = Object.fromEntries([
    "CODEKEEPER_AUTOMATION_BOT_LOGIN",
    "CODEKEEPER_APP_CLIENT_ID"
  ].map((name) => [name, process.env[name]]));
  process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN = appLogin;
  process.env.CODEKEEPER_APP_CLIENT_ID = clientId;
  globalThis.fetch = async (url) => {
    const target = String(url);
    let body = [];
    if (target.endsWith("/graphql")) {
      body = { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } } } } } };
    } else if (target.includes("/apps/codekeeper-app")) {
      body = { slug: "codekeeper-app", client_id: clientId };
    } else if (target.includes("/users/codekeeper-app%5Bbot%5D")) {
      body = { login: appLogin, id: appId, type: "Bot" };
    } else if (target.includes("/issues/7/comments?sort=created&direction=desc")) {
      body = [...comments].reverse();
    } else if (target.endsWith("/issues/7")) {
      body = issue;
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    await run({ root, eventPath });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function prepare({ root, eventPath }) {
  return prepareIssue({
    eventPath,
    actor: "reporter",
    triageMode: "automatic",
    directory: path.join(root, "bundle"),
    config: structuredClone(config),
    token: "read-token",
    agentProfileSource: "package",
    agentProfileSourceSha: "a".repeat(40)
  });
}

test("comment-triggered triage freezes the bounded live issue conversation after an App-owned missing-information marker", async () => {
  await withFixture({
    trigger: comment({
      id: 2,
      login: "reporter",
      body: "It fails on version 2.4.1 with the attached CSV.",
      createdAt: "2026-08-17T10:01:00Z"
    })
  }, async (fixture) => {
    const prepared = await prepare(fixture);
    assert.deepEqual(prepared.issue.labels, ["bug"]);
    assert.equal(prepared.issue.originalBody, "Exporting a report crashes.");
    assert.equal(prepared.issue.triageTrigger.commentId, "2");
    assert.equal(prepared.issue.conversation.includedComments, 2);
    assert.equal(prepared.issue.conversation.truncated, false);
    assert.equal(prepared.issue.previousTriage.missingInformation.length, 1);
    assert.match(await readFile(path.join(fixture.root, "bundle", "prompt.md"), "utf8"), /bounded follow-up/);
  });
});

for (const [name, overrides, pattern] of [
  ["Codekeeper's own comment", {
    trigger: comment({ id: 2, login: appLogin, body: "status", createdAt: "2026-08-17T10:01:00Z", type: "Bot" })
  }, /Codekeeper comments cannot trigger/],
  ["an exact owner command", {
    trigger: comment({ id: 2, login: "reporter", body: "/codekeeper triage", createdAt: "2026-08-17T10:01:00Z" })
  }, /Exact owner commands/],
  ["an untrusted commenter", {
    trigger: comment({ id: 2, login: "outsider", body: "I have details", createdAt: "2026-08-17T10:01:00Z" })
  }, /reporter or a trusted maintainer/],
  ["a stale reply", {
    trigger: comment({ id: 2, login: "reporter", body: "I have details", createdAt: "2026-08-17T09:59:00Z" })
  }, /stale relative/],
  ["a malformed latest marker", {
    trigger: comment({ id: 2, login: "reporter", body: "I have details", createdAt: "2026-08-17T10:01:00Z" }),
    marker: `## Codekeeper triage\n\n${ISSUE_TRIAGE_MARKER}`
  }, /validated Codekeeper missing-information result/]
]) {
  test(`comment-triggered triage rejects ${name}`, async () => {
    await withFixture(overrides, async (fixture) => {
      await assert.rejects(prepare(fixture), pattern);
    });
  });
}
