import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_COMMAND_DEFINITIONS,
  OWNER_COMMANDS,
  commandsForSurface,
  normalizeOwnerCommand,
  ownerCommandAvailableOnSurface,
  ownerCommandSurface,
  parseAnyMentionOwnerCommand,
  parseDirectOwnerCommand,
  renderOwnerCommandHelp,
  renderOwnerCommandStatus,
} from "../src/lib/owner-commands.mjs";

test("owner command definitions expose one canonical vocabulary and aliases", () => {
  assert.deepEqual(
    OWNER_COMMAND_DEFINITIONS.map((definition) => definition.command),
    ["help", "status", "review", "implement", "repair", "defer", "pause"],
  );
  assert.equal(normalizeOwnerCommand("rerun"), "review");
  assert.equal(normalizeOwnerCommand("triage"), "review");
  assert.equal(normalizeOwnerCommand("fix"), "repair");
  assert.equal(normalizeOwnerCommand("stop"), "pause");
  assert.equal(OWNER_COMMANDS.includes("help"), true);
  assert.equal(OWNER_COMMANDS.includes("fix"), true);
  assert.equal(normalizeOwnerCommand("review now"), null);
  assert.equal(ownerCommandAvailableOnSurface("rerun", "issue"), false);
  assert.equal(ownerCommandAvailableOnSurface("rerun", "pull-request"), true);
});

test("help parsing is exact while compatibility aliases remain accepted", () => {
  assert.equal(parseDirectOwnerCommand("/codekeeper help"), "help");
  assert.equal(parseDirectOwnerCommand(" /CODEKEEPER HELP "), "help");
  assert.equal(parseDirectOwnerCommand("/codekeeper help please"), null);
  assert.equal(parseDirectOwnerCommand("Please /codekeeper help"), null);
  assert.equal(parseDirectOwnerCommand("/codekeeper fix"), "fix");
  assert.equal(parseAnyMentionOwnerCommand("@unverified-login fix"), "fix");
  assert.equal(parseAnyMentionOwnerCommand("@unverified-login fix now"), null);
});

test("owner help is scoped to issue, pull request, and review-thread surfaces", () => {
  const issueHelp = renderOwnerCommandHelp("issue");
  const pullHelp = renderOwnerCommandHelp("pull-request");
  const threadHelp = renderOwnerCommandHelp("review-thread");

  assert.match(issueHelp, /Commands available on this issue/);
  assert.match(issueHelp, /`\/codekeeper implement`/);
  assert.doesNotMatch(issueHelp, /`\/codekeeper repair`/);
  assert.doesNotMatch(issueHelp, /`\/codekeeper rerun`/);
  assert.match(pullHelp, /Commands available on this pull request/);
  assert.match(pullHelp, /`\/codekeeper repair`/);
  assert.doesNotMatch(pullHelp, /`\/codekeeper implement`/);
  assert.match(threadHelp, /Commands available on this review thread/);
  assert.match(threadHelp, /`\/codekeeper defer`/);
  assert.match(threadHelp, /`\/codekeeper repair`/);
  assert.match(threadHelp, /`\/codekeeper fix` → `\/codekeeper repair`/);
  assert.match(threadHelp, /Free-form requests are ignored/);
  assert.deepEqual(
    commandsForSurface("not-a-surface").map((definition) => definition.command),
    ["help", "status", "review", "implement", "pause"],
  );
});

test("surface detection distinguishes issues, pull requests, and review threads", () => {
  assert.equal(ownerCommandSurface({ issue: { number: 1 } }), "issue");
  assert.equal(
    ownerCommandSurface({ issue: { number: 1, pull_request: {} } }),
    "pull-request",
  );
  assert.equal(
    ownerCommandSurface({
      issue: { number: 1, pull_request: {} },
      comment: { pull_request_review_id: 22 },
    }),
    "review-thread",
  );
});

test("status uses the same canonical commands and reports the active surface", () => {
  const status = renderOwnerCommandStatus({
    issue: { labels: [{ name: "codekeeper:paused" }] },
    command: "stop",
    outcome: "Automatic work is paused.",
    config: { labels: { "codekeeper:paused": {} } },
    surface: "pull-request",
  });
  assert.match(status, /\| Surface \| pull request \|/);
  assert.match(status, /\| Command \| `\/codekeeper pause` \|/);
  assert.match(status, /`codekeeper:paused`/);
  assert.match(status, /`\/codekeeper stop` → `\/codekeeper pause`/);
  assert.doesNotMatch(status, /Available commands:.*triage/);
});
