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

async function withFixture({ trigger, marker = botMarker(), issue = currentIssue(), extraComments = [], laterComments = [] }, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-issue-conversation-"));
  const eventPath = path.join(root, "event.json");
  const comments = [
    comment({ id: 1, login: appLogin, body: marker, createdAt: "2026-08-17T10:00:00Z", type: "Bot" }),
    ...extraComments,
    trigger,
    ...laterComments
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
    } else if (target.includes("/issues/comments/")) {
      body = comments.find((item) => String(item.id) === target.split("/").at(-1)) ?? {};
    } else if (target.includes("/issues/7/comments")) {
      const page = Number(new URL(target).searchParams.get("page") ?? "1");
      const perPage = Number(new URL(target).searchParams.get("per_page") ?? "40");
      const start = (page - 1) * perPage;
      body = comments.slice(start, start + perPage);
      const lastPage = Math.ceil(comments.length / perPage);
      const links = [];
      if (page > 1) links.push(`<https://api.github.com/repos/acme/example/issues/7/comments?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
      if (page < lastPage) {
        links.push(`<https://api.github.com/repos/acme/example/issues/7/comments?per_page=${perPage}&page=${page + 1}>; rel="next"`);
        links.push(`<https://api.github.com/repos/acme/example/issues/7/comments?per_page=${perPage}&page=${lastPage}>; rel="last"`);
      }
      return new Response(JSON.stringify(body), { status: 200, headers: links.length ? { link: links.join(", ") } : {} });
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

test("comment-triggered triage retains the triggering reply and its prior marker beyond the first 40 comments", async () => {
  const extraComments = Array.from({ length: 39 }, (_, index) => comment({
    id: index + 2,
    login: "participant",
    body: `Unrelated discussion ${index + 2}`,
    createdAt: `2026-08-17T10:${String(index + 1).padStart(2, "0")}:00Z`
  }));
  const trigger = comment({
    id: 41,
    login: "reporter",
    body: "The failure reproduces with the requested diagnostic details.",
    createdAt: "2026-08-17T10:41:00Z"
  });
  await withFixture({ trigger, issue: currentIssue({ comments: 41 }), extraComments }, async (fixture) => {
    const prepared = await prepare(fixture);
    const conversation = prepared.issue.conversation;
    assert.deepEqual(conversation.comments.map((item) => item.id), Array.from({ length: 41 }, (_, index) => String(index + 1)));
    assert.equal(conversation.includedComments, 41);
    assert.equal(conversation.truncatedBefore, false);
    assert.equal(conversation.truncated, false);
    assert.equal(prepared.issue.triageTrigger.commentId, "41");
    assert.equal(prepared.issue.previousTriage.markerCommentId, "1");
  });
});

test("comment-triggered triage accepts a delayed event after more than 121 newer comments", async () => {
  const trigger = comment({
    id: 2,
    login: "reporter",
    body: "The failure reproduces with the requested diagnostic details.",
    createdAt: "2026-08-17T10:01:00Z"
  });
  const laterComments = Array.from({ length: 121 }, (_, index) => comment({
    id: index + 3,
    login: "participant",
    body: `Newer discussion ${index + 3}`,
    createdAt: "2026-08-17T10:02:00Z"
  }));
  await withFixture({ trigger, issue: currentIssue({ comments: 123 }), laterComments }, async (fixture) => {
    const prepared = await prepare(fixture);
    assert.deepEqual(prepared.issue.conversation.comments.map((item) => item.id), ["1", "2"]);
    assert.equal(prepared.issue.conversation.truncatedBefore, false);
    assert.equal(prepared.issue.triageTrigger.commentId, "2");
    assert.equal(prepared.issue.previousTriage.markerCommentId, "1");
  });
});

test("comment-triggered triage retains a current triggering reply and its prior marker in the bounded tail window", async () => {
  const extraComments = Array.from({ length: 159 }, (_, index) => {
    const id = index + 2;
    return comment({
      id,
      login: id === 140 ? appLogin : "participant",
      body: id === 140 ? botMarker() : `Earlier discussion ${id}`,
      createdAt: id === 140 ? "2026-08-17T10:02:00Z" : id > 140 ? "2026-08-17T10:02:01Z" : "2026-08-17T10:01:00Z",
      type: id === 140 ? "Bot" : "User"
    });
  });
  const trigger = comment({
    id: 161,
    login: "reporter",
    body: "The requested diagnostic details are attached.",
    createdAt: "2026-08-17T10:03:00Z"
  });
  await withFixture({ trigger, issue: currentIssue({ comments: 161 }), extraComments }, async (fixture) => {
    const prepared = await prepare(fixture);
    assert.deepEqual(prepared.issue.conversation.comments.map((item) => item.id), Array.from({ length: 22 }, (_, index) => String(index + 140)));
    assert.equal(prepared.issue.conversation.truncatedBefore, true);
    assert.equal(prepared.issue.triageTrigger.commentId, "161");
    assert.equal(prepared.issue.previousTriage.markerCommentId, "140");
  });
});

test("comment-triggered triage fails closed when a trigger falls between the bounded head and tail windows", async () => {
  const marker = comment({ id: 100, login: appLogin, body: botMarker(), createdAt: "2026-08-17T10:01:00Z", type: "Bot" });
  const extraComments = Array.from({ length: 99 }, (_, index) => {
    const id = index + 2;
    return id === 100
      ? marker
      : comment({ id, login: "participant", body: `Earlier discussion ${id}`, createdAt: "2026-08-17T10:01:00Z" });
  });
  const trigger = comment({
    id: 101,
    login: "reporter",
    body: "The requested diagnostic details are attached.",
    createdAt: "2026-08-17T10:02:00Z"
  });
  const laterComments = Array.from({ length: 100 }, (_, index) => comment({
    id: index + 102,
    login: "participant",
    body: `Newer discussion ${index + 102}`,
    createdAt: "2026-08-17T10:03:00Z"
  }));
  await withFixture({ trigger, issue: currentIssue({ comments: 201 }), extraComments, laterComments }, async (fixture) => {
    await assert.rejects(prepare(fixture), /bounded comment-retrieval budget before reaching the triggering comment/);
  });
});

test("comment-triggered triage fails closed when its bounded reverse window cannot reach the prior marker", async () => {
  const extraComments = Array.from({ length: 159 }, (_, index) => comment({
    id: index + 2,
    login: "participant",
    body: `Unrelated discussion ${index + 2}`,
    createdAt: "2026-08-17T10:01:00Z"
  }));
  const trigger = comment({
    id: 161,
    login: "reporter",
    body: "The requested diagnostic details are attached.",
    createdAt: "2026-08-17T10:02:00Z"
  });
  await withFixture({ trigger, issue: currentIssue({ comments: 161 }), extraComments }, async (fixture) => {
    await assert.rejects(prepare(fixture), /current Codekeeper triage marker/);
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
