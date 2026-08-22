import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("resolved and duplicate issue closure comments are marker-idempotent", async () => {
  const [issueSource, commentSource] = await Promise.all([
    readFile(new URL("../src/lib/publish/issue.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/github/comments.mjs", import.meta.url), "utf8")
  ]);

  assert.match(issueSource, /const ISSUE_RESOLUTION_MARKER = "<!-- codekeeper:issue-resolution -->"/);
  assert.match(issueSource, /const ISSUE_DUPLICATE_CLOSURE_MARKER = "<!-- codekeeper:issue-duplicate-closure -->"/);
  assert.match(
    issueSource,
    /createOwnedIssueComment\(\s*issue\.number,\s*resolvedBody,\s*automationIdentity,\s*ISSUE_RESOLUTION_MARKER/
  );
  assert.match(
    issueSource,
    /createOwnedIssueComment\(\s*issue\.number,\s*duplicateBody,\s*automationIdentity,\s*ISSUE_DUPLICATE_CLOSURE_MARKER/
  );
  assert.match(
    commentSource,
    /async createOwnedIssueComment\(number, body, authorIdentity, marker = null\)/
  );
  assert.match(
    commentSource,
    /return this\.upsertOwnedIssueMarker\(number, marker, body, expectedAuthor\)/
  );
});
