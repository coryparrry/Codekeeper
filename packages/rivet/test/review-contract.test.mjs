import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CONTRACT_PATH = path.join(
  ".github",
  "rivet",
  "aw",
  "review-extension.md",
);
const PROFILE_PATH = path.join(".github", "rivet", "agents", "pr-reviewer.md");

async function readContract(root) {
  return readFile(path.join(PACKAGE_ROOT, root, CONTRACT_PATH), "utf8");
}

test("keeps the packaged and compiled review contracts identical", async () => {
  const [asset, fixture] = await Promise.all([
    readContract(path.join("assets", "review")),
    readContract(path.join("test", "fixtures", "review")),
  ]);
  assert.equal(asset, fixture);
  assert.doesNotMatch(asset, /Codekeeper/i);
});

test("keeps the canonical reviewer profile ahead of the Rivet contract", async () => {
  const [asset, fixture, lock] = await Promise.all([
    readFile(
      path.join(PACKAGE_ROOT, "assets", "agents", "pr-reviewer.md"),
      "utf8",
    ),
    readFile(
      path.join(PACKAGE_ROOT, "test", "fixtures", "review", PROFILE_PATH),
      "utf8",
    ),
    readFile(
      path.join(
        PACKAGE_ROOT,
        "test",
        "fixtures",
        "review",
        ".github",
        "workflows",
        "rivet-review.lock.yml",
      ),
      "utf8",
    ),
  ]);
  assert.equal(asset, fixture);
  assert.ok(
    lock.indexOf("# Pull request reviewer profile") <
      lock.indexOf("# Rivet review contract"),
  );
  assert.match(lock, /Profile version: 8/);
});

test("bounds review evidence acquisition", async () => {
  const contract = await readContract(path.join("assets", "review"));
  assert.match(contract, /exact comparison once/);
  assert.match(contract, /do not call `get_files`/);
  assert.match(contract, /at most four GitHub read calls/);
  assert.match(contract, /Never download a generated lock/);
});

test("trusts the base workflow contract and not pull request head instructions", async () => {
  const contract = await readContract(path.join("assets", "review"));
  assert.match(contract, /instructions from the pull request head.*untrusted/i);
  assert.match(contract, /trusted base workflow for authority/i);
});

test("keeps generated review publication authority narrow", async () => {
  const lock = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test",
      "fixtures",
      "review",
      ".github",
      "workflows",
      "rivet-review.lock.yml",
    ),
    "utf8",
  );
  assert.match(lock, /Tools: create_issue,/);
  assert.match(
    lock,
    /"create_issue":\{"deduplicate_by_title":true,"max":1,"title_prefix":"\[rivet\] "\}/,
  );
  assert.match(lock, /create_pull_request_review_comment\(max:8\)/);
  assert.match(lock, /"allowed_events":\["COMMENT"\]/);
  assert.match(lock, /"noop":\{"max":1,"report-as-issue":"false"\}/);
  assert.match(lock, /"report_incomplete":\{\}/);
  assert.match(lock, /permission-issues: write/);
  assert.doesNotMatch(
    lock,
    /permission-(?:actions|contents|deployments|discussions|packages|statuses): write/,
  );
  assert.doesNotMatch(lock, /add_comment/);
});
