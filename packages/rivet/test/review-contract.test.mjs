import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectCompiledWorkflow } from "../src/gh-aw/inspect.mjs";

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
  assert.match(contract, /50-file, 32-KiB model-context budget/);
  assert.match(
    contract,
    /\$\{\{ needs\.review_context\.outputs\.snapshot \}\}/,
  );
  assert.match(contract, /If `complete` is false, call `report_incomplete`/);
  assert.match(
    contract,
    /GitHub read tools are unavailable, and the agent job has no repository checkout/,
  );
  assert.match(contract, /Do not fetch repository files/);
  assert.match(
    contract,
    /Never infer omitted ordinary-file content; call `report_incomplete`/,
  );
  assert.match(contract, /bash: \[\]/);
  assert.match(contract, /github: false/);
  assert.doesNotMatch(contract, /get_diff|perPage|page 2/);
});

test("compiled review disables model-driven repository reads", async () => {
  const lock = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test/fixtures/review/.github/workflows/rivet-review.lock.yml",
    ),
    "utf8",
  );
  const authority = inspectCompiledWorkflow(lock);
  assert.equal(authority.metadata.agent_model, "gpt-5.6-luna");
  assert.match(lock, /GH_AW_MODEL_AGENT_CODEX: gpt-5\.6-luna/);
  assert.doesNotMatch(lock, /\?effort=low|model_reasoning_effort/);
  assert.match(lock, /features\.shell_tool=false/);
  assert.match(
    lock,
    /GH_AW_NEEDS_REVIEW_CONTEXT_OUTPUTS_SNAPSHOT: \$\{\{ needs\.review_context\.outputs\.snapshot \}\}/,
  );
  assert.doesNotMatch(lock, /\[mcp_servers\.github\]|github-mcp-server/);
  assert.equal(authority.jobConditions.review_context.needs, null);
  assert.equal(authority.jobConditions.pre_activation.needs, "review_context");
  assert.deepEqual(authority.jobConditions.activation.needs, [
    "pre_activation",
    "review_context",
    "review_tags_pending",
  ]);
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
