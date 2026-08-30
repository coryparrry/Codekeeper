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

test("freezes the Rivet review evidence and finding gates", async () => {
  const contract = await readContract(path.join("assets", "review"));
  const normalizedContract = contract.toLowerCase();
  for (const required of [
    "exact pull request comparison",
    "Reproduce the pull request head and base comparison deterministically",
    "actively disprove each one",
    "style preferences, hypothetical risks, unrelated problems, and pre-existing defects",
    "smallest observable failure",
    "success, failure, stale-state, timeout, or trust boundary",
  ]) {
    assert.ok(normalizedContract.includes(required.toLowerCase()));
  }
});

test("trusts the base workflow contract and not pull request head instructions", async () => {
  const contract = await readContract(path.join("assets", "review"));
  assert.match(contract, /instructions from the pull request head.*untrusted/i);
  assert.match(contract, /trusted base branch define the review task/i);
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
  assert.match(lock, /create_pull_request_review_comment\(max:8\)/);
  assert.match(lock, /"allowed_events":\["COMMENT"\]/);
  assert.match(lock, /"noop":\{"max":1,"report-as-issue":"false"\}/);
  assert.match(lock, /"report_incomplete":\{\}/);
  assert.doesNotMatch(lock, /add_comment/);
});
