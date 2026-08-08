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
  "openai/codex-action": "52fe01ec70a42f454c9d2ebd47598f9fd6893d56",
  "reviewdog/action-actionlint": "50842263c20a7c46bd0065b9e624d3c569db061e"
};

async function repositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function workflow(mode) {
  return repositoryFile(`.github/workflows/codekeeper-${mode}.yml`);
}

function jobSection(source, name, nextName) {
  const start = source.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const next = nextName ? source.indexOf(`  ${nextName}:\n`, start + 1) : source.length;
  assert.notEqual(next, -1, `missing ${nextName} job after ${name}`);
  return source.slice(start, next);
}

test("self-test runs for every tracked-file change", async () => {
  const source = await workflow("self-test");
  const triggers = source.slice(0, source.indexOf("\npermissions:"));
  assert.match(triggers, /on:\n  pull_request:\n  push:\n  workflow_dispatch:/);
  assert.doesNotMatch(triggers, /\n\s+paths(?:-ignore)?:/);
});

test("four generic mode workflows expose workflow_call and caller templates remain non-executable", async () => {
  const files = await readdir(workflowDirectory);
  for (const mode of modes) {
    assert.ok(files.includes(`codekeeper-${mode}.yml`));
    const source = await workflow(mode);
    assert.match(source, /on:\n\s+workflow_call:/);
    assert.match(source, /job\.workflow_repository/);
    assert.match(source, /job\.workflow_sha/);

    const caller = await repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`);
    assert.match(caller, /OWNER\/REPOSITORY\/\.github\/workflows\/codekeeper-/);
    assert.match(caller, /@FULL_COMMIT_SHA/);
  }
  const reviewCaller = await repositoryFile("examples/workflows/codekeeper-review.yml.example");
  assert.match(reviewCaller, /on:\n\s+pull_request_target:/);
  assert.doesNotMatch(reviewCaller, /on:\n\s+pull_request:/);
  assert.match(reviewCaller, /pull-requests: read/);
  assert.match(reviewCaller, /run-name: "Codekeeper review #\$\{\{ github\.event\.pull_request\.number \}\} @\$\{\{ github\.event\.pull_request\.head\.sha \}\}"/);
  const issueCaller = await repositoryFile("examples/workflows/codekeeper-issues.yml.example");
  assert.match(issueCaller, /run-name: "Codekeeper issue triage #\$\{\{ github\.event\.issue\.number \}\}"/);
  assert.ok(!files.some((name) => name.startsWith("treebar-ai-")));
});

test("workflow and caller surfaces contain no Treebar or Cory-specific identity", async () => {
  const workflowFiles = await readdir(workflowDirectory);
  const workflowText = await Promise.all(
    workflowFiles.filter((name) => name.endsWith(".yml")).map((name) => repositoryFile(`.github/workflows/${name}`))
  );
  const callerText = await Promise.all(
    modes.map((mode) => repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`))
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
    const effectiveMode = mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode;
    const workspace = jobSection(source, "workspace", "analyze");
    const analyze = jobSection(source, "analyze", repairMode ? "verify" : "seal");
    const verify = repairMode ? jobSection(source, "verify", "seal") : null;
    const seal = jobSection(source, "seal", "publish");
    const publish = jobSection(source, "publish", mode === "review" ? "gate" : undefined);

    assert.match(workspace, /codekeeper-bundle/);
    assert.match(workspace, /codekeeper-config\.json/);
    assert.match(workspace, /cp "\$SOURCE_CONFIG" "\$CONFIG"/);
    assert.match(workspace, /Configured default branch does not match the repository default branch/);
    assert.match(workspace, new RegExp(`prepare-${effectiveMode}`));
    assert.match(workspace, /openai\/codex-action@/);
    assert.match(workspace, /outputs:\n\s+context_sha256: \$\{\{ steps\.prepare\.outputs\.context_sha256 \}\}/);
    if (repairMode) {
      assert.match(workspace, /capture-workspace-patch/);
      assert.match(workspace, /workspace\.patch/);
    } else {
      assert.doesNotMatch(workspace, /capture-workspace-patch|workspace\.patch/);
    }
    assert.doesNotMatch(workspace, /secrets\.(?:model_api_key|trace_api_key|app_private_key|app_client_id)/);
    assert.doesNotMatch(workspace, /CODEKEEPER_(?:MODEL|TRACE)_API_KEY/);
    assert.doesNotMatch(workspace, /create-github-app-token/);

    assert.match(analyze, /needs: workspace/);
    assert.match(analyze, /codekeeper-bundle/);
    assert.match(analyze, /codekeeper-config\.json/);
    assert.match(analyze, /cp "\$SOURCE_CONFIG" "\$CONFIG"/);
    assert.match(analyze, /Configured default branch does not match the repository default branch/);
    assert.match(analyze, /codekeeper-candidate/);
    assert.match(analyze, new RegExp(`prepare-${effectiveMode}`));
    assert.match(analyze, new RegExp(`validate-${effectiveMode}`));
    assert.match(analyze, /download-artifact@/);
    assert.match(analyze, /--workspace-result "\$WORKSPACE\/workspace-result\.json"/);
    assert.match(analyze, /Bind workspace evidence to frozen context/);
    assert.match(analyze, /needs\.workspace\.outputs\.context_sha256/);
    assert.match(analyze, /steps\.prepare\.outputs\.context_sha256/);
    assert.ok(analyze.indexOf("Bind workspace evidence to frozen context") < analyze.indexOf("run-agent"));
    if (repairMode) {
      assert.match(analyze, /apply-workspace-patch/);
    } else {
      assert.doesNotMatch(analyze, /apply-workspace-patch|workspace\.patch/);
    }
    assert.doesNotMatch(analyze, /openai\/codex-action@|secrets\.(?:workspace_api_key|openai_api_key|app_private_key)/);
    assert.doesNotMatch(analyze, /create-github-app-token/);

    if (verify) {
      assert.match(verify, new RegExp(`verify-${mode === "maintain" ? "audit" : mode}`));
      assert.match(verify, /expected-candidate-sha/);
      assert.match(verify, /without OpenAI or App credentials/);
      assert.doesNotMatch(verify, /openai\/codex-action@|create-github-app-token|secrets\./);
      assert.match(source, /needs: \[analyze, verify\]/);
    }

    assert.match(seal, /codekeeper-candidate/);
    assert.match(seal, /codekeeper-artifact/);
    assert.match(seal, new RegExp(`seal-${mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode}`));
    assert.match(seal, /manifest_sha256: \$\{\{ steps\.seal\.outputs\.manifest_sha256 \}\}/);
    assert.match(seal, /id: seal/);
    assert.doesNotMatch(seal, /openai\/codex-action@|create-github-app-token/);

    assert.match(publish, /create-github-app-token/);
    assert.match(publish, /CODEKEEPER_AUTOMATION_BOT_LOGIN/);
    assert.match(publish, /CODEKEEPER_AUTOMATION_BOT_ID/);
    assert.match(publish, /steps\.app-token\.outputs\.app-slug/);
    assert.match(publish, /curl --globoff/);
    assert.match(publish, /\$GITHUB_API_URL\/users\/\$\{APP_SLUG\}\[bot\]/);
    assert.doesNotMatch(publish, /\$GITHUB_API_URL\/user(?:["']|\))/);
    assert.match(publish, /codekeeper-artifact/);
    assert.match(
      publish,
      /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?path: repository/
    );
    assert.match(publish, /CONFIG: \$\{\{ github\.workspace \}\}\/repository\/\.github\/codekeeper\.json/);
    assert.match(publish, /--config "\$CONFIG"/);
    assert.match(publish, /--expected-manifest-sha "\$MANIFEST_SHA256"/);
    assert.doesNotMatch(publish, /openai\/codex-action@|validate-|seal-/);
  }
});

test("candidate and sealed artifact names include run id and retry attempt", async () => {
  for (const mode of modes) {
    const source = await workflow(mode);
    assert.match(source, new RegExp(`codekeeper-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}-candidate-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}`));
    assert.match(source, new RegExp(`codekeeper-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}-artifact-\\$\\{\\{ github\\.run_id \\}\\}-\\$\\{\\{ github\\.run_attempt \\}\\}`));
  }
});

test("maintenance and fix dry runs do not require App credentials, but publication fails closed without them", async () => {
  for (const mode of ["maintain", "fix"]) {
    const source = await workflow(mode);
    const caller = await repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`);
    const publish = jobSection(source, "publish");

    assert.match(
      source,
      /app_client_id:\n\s+description: GitHub App client ID\. Required only when dry_run=false\.\n\s+required: false\n\s+default: ""\n\s+type: string/
    );
    assert.match(
      source,
      /app_private_key:\n\s+description: GitHub App private key\. Required only when dry_run=false\.\n\s+required: false/
    );
    assert.match(source, /if: needs\.seal\.result == 'success' && !inputs\.dry_run/);
    assert.match(publish, /name: Require GitHub App publication credentials/);
    assert.match(publish, /APP_CLIENT_ID: \$\{\{ inputs\.app_client_id \}\}/);
    assert.match(publish, /APP_PRIVATE_KEY: \$\{\{ secrets\.app_private_key \}\}/);
    assert.match(publish, /test -n "\$APP_CLIENT_ID"/);
    assert.match(publish, /test -n "\$APP_PRIVATE_KEY"/);
    assert.match(publish, /app_client_id is required when dry_run=false/);
    assert.match(publish, /app_private_key is required when dry_run=false/);
    assert.ok(
      publish.indexOf("Require GitHub App publication credentials") < publish.indexOf("create-github-app-token"),
      `${mode} must check credentials before minting an App token`
    );
    assert.match(caller, /Optional for dry_run=true; required when dry_run=false publishes changes\./);
    assert.match(caller, /app_client_id: \$\{\{ vars\.CODEKEEPER_APP_CLIENT_ID \}\}/);
    assert.match(caller, /app_private_key: \$\{\{ secrets\.CODEKEEPER_APP_PRIVATE_KEY \}\}/);
  }
});

test("review and issue-triage retain mandatory App credentials", async () => {
  for (const mode of ["review", "issues"]) {
    const source = await workflow(mode);
    const caller = await repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`);

    assert.match(
      source,
      /app_client_id:\n\s+description: GitHub App client ID\. This identifier is not secret\.\n\s+required: true\n\s+type: string/
    );
    assert.match(source, /app_private_key:\n\s+required: true/);
    assert.match(caller, /app_client_id: \$\{\{ vars\.CODEKEEPER_APP_CLIENT_ID \}\}/);
    assert.match(caller, /app_private_key: \$\{\{ secrets\.CODEKEEPER_APP_PRIVATE_KEY \}\}/);
  }
});

test("review uses a PR-native fail-closed gate instead of a reusable commit status", async () => {
  const source = await workflow("review");
  const caller = await repositoryFile("examples/workflows/codekeeper-review.yml.example");
  const gate = jobSection(source, "gate");
  assert.match(gate, /name: Codekeeper review gate/);
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /fails closed/);
  assert.match(gate, /exit 1/);
  assert.match(source, /auto_review:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/);
  assert.match(jobSection(source, "workspace", "analyze"), /inputs\.auto_review/);
  assert.match(caller, /auto_review: true/);
  assert.doesNotMatch(source, /publish-review-status|pull_request_target|state="success"/);
});

test("issue triage allows only bounded automatic events while owner commands and fixes stay gated", async () => {
  const issue = await workflow("issues");
  const fix = await workflow("fix");
  const caller = await repositoryFile("examples/workflows/codekeeper-issues.yml.example");
  assert.match(issue, /auto_triage:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/);
  assert.match(issue, /inputs\.auto_triage &&\s+github\.event_name == 'issues'/);
  for (const action of ["opened", "reopened", "edited"]) assert.match(issue, new RegExp(`github\\.event\\.action == '${action}'`));
  assert.match(issue, /github\.event\.comment\.body == '\/codekeeper triage'/);
  assert.match(issue, /startsWith\(github\.event\.comment\.body, '\/codekeeper triage '\)/);
  assert.match(issue, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(issue, /TRIAGE_MODE: \$\{\{ github\.event_name == 'issues' && 'automatic' \|\| 'manual' \}\}/);
  assert.match(issue, /prepare-issue[\s\S]*--actor "\$GITHUB_ACTOR"/);
  assert.match(issue, /prepare-issue[\s\S]*--triage-mode "\$TRIAGE_MODE"/);
  assert.match(caller, /issues:\n\s+types: \[opened, reopened, edited\]/);
  assert.match(caller, /auto_triage: true/);
  assert.match(caller, /run-name: "Codekeeper issue triage #\$\{\{ github\.event\.issue\.number \}\}"/);

  assert.match(fix, /github\.event\.comment\.body == '\/codekeeper fix'/);
  assert.match(fix, /startsWith\(github\.event\.comment\.body, '\/codekeeper fix '\)/);
  assert.match(fix, /github\.event\.comment\.author_association == 'OWNER'/);
  assert.match(fix, /allow-users: \$\{\{ github\.actor \}\}/);
  assert.doesNotMatch(fix, /github\.event_name == 'issues'/);
});

test("Agents SDK coordinators use pinned dependencies and isolated credentials", async () => {
  const packageJson = JSON.parse(await repositoryFile("tools/codekeeper/package.json"));
  const packageLock = JSON.parse(await repositoryFile("tools/codekeeper/package-lock.json"));
  assert.deepEqual(packageJson.dependencies, { "@openai/agents": "0.14.2", zod: "4.4.3" });
  assert.equal(packageLock.lockfileVersion, 3);
  assert.equal(packageLock.packages[""].dependencies["@openai/agents"], "0.14.2");
  assert.equal(packageLock.packages[""].dependencies.zod, "4.4.3");

  for (const mode of modes) {
    const source = await workflow(mode);
    const caller = await repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`);
    const repairMode = mode === "maintain" || mode === "fix";
    const workspace = jobSection(source, "workspace", "analyze");
    const analyze = jobSection(source, "analyze", repairMode ? "verify" : "seal");
    const effectiveMode = mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode;
    assert.match(source, /model_api_key:\n[\s\S]*required: true/);
    assert.match(source, /trace_api_key:\n\s+description:[^\n]*\n\s+required: false/);
    assert.doesNotMatch(workspace, /npm ci --ignore-scripts --no-audit --no-fund/);
    assert.match(workspace, new RegExp(`agent-settings[\\s\\S]*--mode ${effectiveMode}`));
    assert.match(workspace, /secrets\.workspace_api_key \|\| secrets\.openai_api_key/);
    assert.doesNotMatch(workspace, /secrets\.(?:model_api_key|trace_api_key|app_private_key)/);
    assert.match(analyze, /npm ci --ignore-scripts --no-audit --no-fund/);
    assert.match(analyze, /run-agent/);
    assert.match(analyze, /CODEKEEPER_MODEL_API_KEY: \$\{\{ secrets\.model_api_key \}\}/);
    assert.doesNotMatch(analyze, /CODEKEEPER_MODEL_API_KEY: \$\{\{ secrets\.model_api_key \|\| secrets\.openai_api_key \}\}/);
    assert.match(analyze, /CODEKEEPER_TRACE_API_KEY: \$\{\{ secrets\.trace_api_key \}\}/);
    assert.match(analyze, /workspace-result\.json/);
    assert.match(analyze, /agent-result\.json/);
    assert.match(caller, /model_api_key:/);
    assert.match(caller, /trace_api_key: \$\{\{ secrets\.OPENAI_TRACE_API_KEY \}\}/);
  }

  const selfTest = await workflow("self-test");
  assert.match(selfTest, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(selfTest, /npm run check/);
});

test("self-test reports through annotations with read-only repository permissions", async () => {
  const selfTest = await workflow("self-test");
  assert.match(selfTest, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(selfTest, /checks: write/);
  assert.match(selfTest, /reporter: github-annotations/);
  assert.match(selfTest, /fail_level: any/);
});
