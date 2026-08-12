import test from "node:test";
import assert from "node:assert/strict";
import { frozenPullRepairSubject, frozenPullRepairSubjectSha256 } from "../src/lib/pull-repair-state.mjs";

const pull = {
  number: 42,
  title: "Repair this PR",
  body: "b".repeat(13000),
  user: { login: "contributor" },
  html_url: "https://github.com/acme/example/pull/42"
};

const evidencePolicy = {
  authorizationMode: "owner",
  actor: "repository-owner",
  ownerLogins: ["repository-owner"]
};

function comment(author, body, day) {
  return { body, created_at: `2026-08-${day}T09:00:00Z`, user: { login: author, type: "User" } };
}

test("PR repair freshness hashes exactly the bounded evidence shown to the fixer", () => {
  const comments = [
    ...Array.from({ length: 21 }, (_, index) => comment("contributor", `untrusted-${index}`, String(index + 1).padStart(2, "0"))),
    ...Array.from({ length: 6 }, (_, index) => comment("repository-owner", `owner-${index + 1}`, String(index + 22).padStart(2, "0")))
  ];
  const subject = frozenPullRepairSubject(pull, comments, [], evidencePolicy);
  assert.deepEqual(subject.comments.map((item) => item.body), ["owner-2", "owner-3", "owner-4", "owner-5", "owner-6"]);
  assert.equal(subject.body.length, 12000);

  const baseline = frozenPullRepairSubjectSha256(pull, comments, [], evidencePolicy);
  const unseenCommentChanged = structuredClone(comments);
  unseenCommentChanged[0].body = "changed outside the fixer context";
  assert.equal(frozenPullRepairSubjectSha256(pull, unseenCommentChanged, [], evidencePolicy), baseline);
  const omittedOwnerCommentChanged = structuredClone(comments);
  omittedOwnerCommentChanged[21].body = "changed older owner instruction";
  assert.equal(frozenPullRepairSubjectSha256(pull, omittedOwnerCommentChanged, [], evidencePolicy), baseline);

  const visibleCommentChanged = structuredClone(comments);
  visibleCommentChanged.at(-1).body = "changed owner instruction";
  assert.notEqual(frozenPullRepairSubjectSha256(pull, visibleCommentChanged, [], evidencePolicy), baseline);

  const unseenBodyChanged = { ...pull, body: `${pull.body.slice(0, 12000)}changed outside the fixer context` };
  assert.equal(frozenPullRepairSubjectSha256(unseenBodyChanged, comments, [], evidencePolicy), baseline);
});
