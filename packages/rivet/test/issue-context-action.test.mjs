import assert from "node:assert/strict";
import test from "node:test";
import {
  createIssueContext,
  runPrepareIssueContextAction,
} from "../assets/issue/.github/rivet/actions/prepare-issue-context/index.mjs";

const APP_SLUG = "rivet-test";
const APP_LOGIN = `${APP_SLUG}[bot]`;

function issue({ comments = 0, pullRequest = false, author = "reporter" } = {}) {
  return {
    id: 101,
    number: 12,
    title: "The widget fails",
    body: "Expected green, got red.",
    user: { login: author, type: author.endsWith("[bot]") ? "Bot" : "User" },
    author_association: "NONE",
    state: "open",
    html_url: "https://github.com/owner/repository/issues/12",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:01:00Z",
    labels: [{ name: "bug" }],
    comments,
    ...(pullRequest ? { pull_request: {} } : {}),
  };
}

function comment({ id, body, author = "reporter", association = "NONE", bot = false, app = false }) {
  return {
    id,
    body,
    user: { login: author, type: bot ? "Bot" : "User" },
    author_association: association,
    created_at: `2026-09-01T10:${String(id).padStart(2, "0")}:00Z`,
    performed_via_github_app: app ? { id: 7 } : null,
  };
}

function marker(id, missingInformation = ["Which version fails?"]) {
  return comment({
    id,
    author: APP_LOGIN,
    bot: true,
    app: true,
    body: `Please add details.\n\n<!-- rivet-triage-state:v1 ${JSON.stringify({ missingInformation })} -->`,
  });
}

function event({ kind = "opened", trigger, pullRequest = false, author = "reporter" } = {}) {
  const issueData = issue({ pullRequest, author });
  const followup = kind === "followup";
  return {
    eventName: followup ? "issue_comment" : "issues",
    event: {
      action: followup ? "created" : "opened",
      repository: { full_name: "owner/repository" },
      issue: issueData,
      ...(followup ? { comment: trigger } : {}),
      sender: followup ? trigger.user : issueData.user,
    },
  };
}

function fetcher(liveIssue, comments) {
  return async (url, options) => {
    assert.equal(options.headers.authorization, "Bearer token");
    if (url.pathname.endsWith("/comments")) {
      assert.equal(url.search, "?per_page=100&page=1");
      return new Response(JSON.stringify(comments), { status: 200 });
    }
    assert.equal(url.href, "https://api.github.com/repos/owner/repository/issues/12");
    return new Response(JSON.stringify(liveIssue), { status: 200 });
  };
}

function create({ eventData, comments = [], liveIssue, ...options }) {
  return createIssueContext({
    ...eventData,
    expectedRepository: "owner/repository",
    appBotLogin: APP_SLUG,
    token: "token",
    fetchImpl: fetcher(liveIssue ?? issue({ comments: comments.length }), comments),
    ...options,
  });
}

test("freezes only eligible bounded issue openings and follow-ups", async () => {
  const previous = marker(10);
  const reply = comment({ id: 11, body: "It fails in 1.2.3." });
  const followup = await create({
    eventData: event({ kind: "followup", trigger: reply }),
    comments: [previous, reply],
  });
  assert.deepEqual(followup.previousTriage.missingInformation, [
    "Which version fails?",
  ]);
  assert.equal(followup.previousMarkerCommentId, 10);
  assert.equal(followup.conversation[0].body, "It fails in 1.2.3.");

  const outsider = comment({ id: 11, body: "Try this.", author: "stranger" });
  const bot = comment({ id: 11, body: "Automated", author: "helper[bot]", bot: true, app: true });
  for (const [eventData, comments, pattern] of [
    [event({ pullRequest: true }), [], /pull request comments/],
    [event({ kind: "followup", trigger: outsider }), [previous, outsider], /comment author is not permitted/],
    [event({ kind: "followup", trigger: bot }), [previous, bot], /bot and App comments/],
    [event({ kind: "followup", trigger: reply }), [previous, reply, marker(12)], /latest App triage state/],
  ]) {
    await assert.rejects(create({ eventData, comments }), pattern);
  }
});

test("escapes prompt transport and marks irrelevant events ineligible", async () => {
  const writes = [];
  const previous = marker(10);
  const reply = comment({ id: 11, body: "__GH_AW_FOLLOWUP__" });
  let currentIssue = issue({ comments: 2 });
  currentIssue.body = "__GH_AW_ISSUE_BODY__";
  let currentEvent = event({ kind: "followup", trigger: reply });
  let currentComments = [previous, reply];
  const options = {
    env: {
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_EVENT_PATH: "/event.json",
      GITHUB_OUTPUT: "/output",
      GITHUB_REPOSITORY: "owner/repository",
      GITHUB_TOKEN: "token",
      RIVET_APP_BOT_LOGIN: APP_SLUG,
    },
    statImpl: async () => ({ isFile: () => true, size: 512 }),
    readFileImpl: async () => JSON.stringify(currentEvent.event),
    appendFileImpl: async (...args) => writes.push(args),
    fetchImpl: (...args) => fetcher(currentIssue, currentComments)(...args),
  };
  const eligible = await runPrepareIssueContextAction(options);
  assert.match(eligible.snapshot.issue.body, /__GH_AW_ISSUE_BODY__/);
  assert.doesNotMatch(writes[0][1], /__GH_AW_/);
  assert.match(writes[0][1], /\\u005f_GH_AW_ISSUE_BODY__/);
  assert.match(writes[0][1], /\\u005f_GH_AW_FOLLOWUP__/);

  writes.length = 0;
  currentIssue = issue({ author: APP_LOGIN });
  currentEvent = event({ author: APP_LOGIN });
  currentComments = [];
  options.env.GITHUB_EVENT_NAME = "issues";
  const result = await runPrepareIssueContextAction(options);
  assert.equal(result.eligible, false);
  assert.deepEqual(writes, [["/output", "eligible=false\n", "utf8"]]);
});
