import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const workflowDirectory = path.join(repositoryRoot, ".github/workflows");
const modes = ["review", "maintain", "issues", "fix"];
const actionPins = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/create-github-app-token": "bcd2ba49218906704ab6c1aa796996da409d3eb1",
  "openai/codex-action": "10cb888d2ed3b99867f7e7ccff174a861a75aeb6",
  "reviewdog/action-actionlint": "50842263c20a7c46bd0065b9e624d3c569db061e"
};

async function repositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function workflow(mode) {
  return repositoryFile(`.github/workflows/ai-maintainer-${mode}.yml`);
}

function jobSection(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const next = nextName ? source.indexOf(`  ${nextName}:\n`, start + 1) : source.length;
  assert.notEqual(next, -1, `missing ${nextName} job after ${name}`);
  return source.slice(start, next);
}

test("four generic mode workflows expose workflow_call and caller templates remain non-executable", async () => {
  const files = await readdir(workflowDirectory);
  for (const mode of modes) {
    assert.ok(files.includes(`ai-maintainer-${mode}.yml`));
    const source = await workflow(mode);
    assert.match(source, /on:\n\s+workflow_call:/);
    assert.match(source, /job\.workflow_repository/);
    assert.match(source, /job\.workflow_sha/);

    const caller = await repositoryFile(`examples/workflows/ai-maintainer-${mode}.yml.example`);
    assert.match(caller, /OWNER\/REPOSITORY\/\.github\/workflows\/ai-maintainer-/);
    assert.match(caller, /@FULL_COMMIT_SHA/);
  }
  const reviewCaller = await repositoryFile("examples/workflows/ai-maintainer-review.yml.example");
  assert.match(reviewCaller, /on:\n\s+pull_request_target:/);
  assert.doesNotMatch(reviewCaller, /on:\n\s+pull_request:/);
  assert.match(reviewCaller, /pull-requests: read/);
  assert.ok(!files.some((name) => name.startsWith("treebar-ai-")));
});

test("workflow and caller surfaces contain no Treebar or Cory-specific identity", async () => {
  const workflowFiles = await readdir(workflowDirectory);
  const workflowText = await Promise.all(
    workflowFiles.filter((name) => name.endsWith(".yml")).map((name) => repositoryFile(`.github/workflows/${name}`))
  );
  const callerText = await Promise.all(
    modes.map((mode) => repositoryFile(`examples/workflows/ai-maintainer-${mode}.yml.example`))
  );
  for (const source of [...workflowText, ...callerText]) {
    assert.doesNotMatch(source, /treebar|coryparr?y/i);
  }
});

test("all executable actions are pinned to known immutable commits", async () => {
  const workflowFiles = await readdir(workflowDirectory);
  const executable = await Promise.all(
    workflowFiles.filter((name) => name.endsWith(".yml")).map((name) => repositoryFile(`.github/workflows/${name}`))
  );
  const usesPattern = /^\s*uses:\s*([^\s#]+)@([^\s#]+)(?:\s+#.*)?$/gm;
  for (const source of executable) {
    for (const match of source.matchAll(usesPattern)) {
      const [, action, reference] = match;
      assert.match(reference, /^[0-9a-f]{40}$/, `${action} must use a full commit SHA`);
      assert.equal(reference, actionPins[action], `${action} pin changed without this contract update`);
    }
  }
});

test("all checkouts discard persisted credentials and tool versions are exact", async () => {
  for (const mode of [...modes, "self-test"]) {
    const source = await workflow(mode);
    const checkoutCount = [...source.matchAll(/uses: actions\/checkout@/g)].length;
    const protectedCount = [...source.matchAll(/persist-credentials: false/g)].length;
    assert.equal(protectedCount, checkoutCount, `${mode} leaves a checkout credential persisted`);
    assert.match(source, /node-version: 24\.19\.0/);
  }
  for (const mode of modes) {
    const source = await workflow(mode);
    assert.match(source, /codex-version: 0\.146\.0/);
  }
});

test("every mode isolates untrusted candidate creation, tokenless sealing, and App publication", async () => {
  for (const mode of modes) {
    const source = await workflow(mode);
    const repairMode = mode === "maintain" || mode === "fix";
    const analyze = jobSection(source, "analyze", repairMode ? "verify" : "seal");
    const verify = repairMode ? jobSection(source, "verify", "seal") : null;
    const seal = jobSection(source, "seal", "publish");
    const publish = jobSection(source, "publish", mode === "review" ? "gate" : undefined);

    assert.match(analyze, /ai-maintainer-bundle/);
    assert.match(analyze, /ai-maintainer-config\.json/);
    assert.match(analyze, /cp "\$SOURCE_CONFIG" "\$CONFIG"/);
    assert.match(analyze, /Configured default branch does not match the repository default branch/);
    assert.match(analyze, /ai-maintainer-candidate/);
    assert.match(analyze, new RegExp(`prepare-${mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode}`));
    assert.match(analyze, new RegExp(`validate-${mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode}`));
    assert.match(analyze, /openai\/codex-action@/);
    assert.doesNotMatch(analyze, /create-github-app-token/);

    if (verify) {
      assert.match(verify, new RegExp(`verify-${mode === "maintain" ? "audit" : mode}`));
      assert.match(verify, /expected-candidate-sha/);
      assert.match(verify, /without OpenAI or App credentials/);
      assert.doesNotMatch(verify, /openai\/codex-action@|create-github-app-token|secrets\./);
      assert.match(source, /needs: \[analyze, verify\]/);
    }

    assert.match(seal, /ai-maintainer-candidate/);
    assert.match(seal, /ai-maintainer-artifact/);
    assert.match(seal, new RegExp(`seal-${mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode}`));
    assert.doesNotMatch(seal, /openai\/codex-action@|create-github-app-token/);

    assert.match(publish, /create-github-app-token/);
    assert.match(publish, /AI_MAINTAINER_AUTOMATION_BOT_LOGIN/);
    assert.match(publish, /AI_MAINTAINER_AUTOMATION_BOT_ID/);
    assert.match(publish, /steps\.app-token\.outputs\.app-slug/);
    assert.match(publish, /curl --globoff/);
    assert.match(publish, /\$GITHUB_API_URL\/users\/\$\{APP_SLUG\}\[bot\]/);
    assert.doesNotMatch(publish, /\$GITHUB_API_URL\/user(?:["']|\))/);
    assert.match(publish, /ai-maintainer-artifact/);
    assert.doesNotMatch(publish, /openai\/codex-action@|validate-|seal-/);
  }
});

test("candidate and sealed artifact names include run id and retry attempt", async () => {
  for (const mode of modes) {
    const source = await workflow(mode);
    assert.match(source, new RegExp(`ai-maintainer-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}-candidate-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}`));
    assert.match(source, new RegExp(`ai-maintainer-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}-artifact-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}`));
  }
});

test("review uses a PR-native fail-closed gate instead of a reusable commit status", async () => {
  const source = await workflow("review");
  const gate = jobSection(source, "gate");
  assert.match(gate, /name: AI Maintainer review gate/);
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /fails closed/);
  assert.match(gate, /exit 1/);
  assert.doesNotMatch(source, /publish-review-status|pull_request_target|state="success"/);
});

test("issue triage and fixes require exact maintainer commands before Codex can run", async () => {
  const issue = await workflow("issues");
  const fix = await workflow("fix");
  for (const [source, command] of [[issue, "triage"], [fix, "fix"]]) {
    assert.match(source, new RegExp(`github\\.event\\.comment\\.body == '/ai-maintainer ${command}'`));
    assert.match(source, new RegExp(`startsWith\\(github\\.event\\.comment\\.body, '/ai-maintainer ${command} '\\)`));
    assert.match(source, /github\.event\.comment\.author_association == 'OWNER'/);
    assert.match(source, /allow-users: \$\{\{ github\.actor \}\}/);
    assert.doesNotMatch(source, /issues:\n\s+types: \[opened/);
  }
  assert.match(issue, /prepare-issue[\s\S]*--actor "\$GITHUB_ACTOR"/);
});
