import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  "reviewdog/action-actionlint": "d63ba7532e0942965320cd8d73cbae4c7b3c5283"
};
const toolingManifestPath = "tools/codekeeper/tooling-manifest.json";
const toolingManifestSha256 = "9a88ebd0fb1012f53b0556133de10436fd458db1b33a5f8896b30d739ff39e4a";
const bootstrapToolingArtifactName = "codekeeper-tooling-${{ github.run_id }}";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

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
    assert.match(source, /job\.workflow_sha/);

    const caller = await repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`);
    assert.match(caller, /OWNER\/REPOSITORY\/\.github\/workflows\/codekeeper-/);
    assert.match(caller, /@FULL_COMMIT_SHA/);
  }
  const reviewCaller = await repositoryFile("examples/workflows/codekeeper-review.yml.example");
  assert.match(reviewCaller, /on:\n\s+pull_request_target:/);
  assert.match(reviewCaller, /pull_request_review:\n\s+types: \[submitted, edited, dismissed\]/);
  assert.match(reviewCaller, /pull_request_review_comment:\n\s+types: \[created, edited, deleted\]/);
  assert.doesNotMatch(reviewCaller, /on:\n\s+pull_request:/);
  assert.match(reviewCaller, /pull-requests: read/);
  assert.match(reviewCaller, /run-name: "Codekeeper review #\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.client_payload\.number \}\}"/);
  assert.match(reviewCaller, /const route = !commandIntent && !automationReply/);
  assert.match(reviewCaller, /const automationReply = eventName === "pull_request_review_comment" && automationBot && author === automationBot/);
  const issueCaller = await repositoryFile("examples/workflows/codekeeper-issues.yml.example");
  assert.match(issueCaller, /run-name: "Codekeeper issue triage #\$\{\{ github\.event\.issue\.number \|\| github\.event\.client_payload\.number \}\}"/);
  assert.ok(!files.some((name) => name.startsWith("treebar-ai-")));
});

test("caller bootstrap fetches the same immutable private action release as its reusable workflow", async () => {
  const releaseSha = "a".repeat(40);
  for (const mode of modes) {
    const template = await repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`);
    const generated = template.replaceAll("OWNER/REPOSITORY", "octo/private-codekeeper").replaceAll("FULL_COMMIT_SHA", releaseSha);
    const pins = [...generated.matchAll(/uses:\s+octo\/private-codekeeper\/(?:tools\/codekeeper|\.github\/workflows\/codekeeper-[a-z-]+\.yml)@([0-9a-f]{40})/g)]
      .map((match) => match[1]);
    assert.deepEqual(pins, [releaseSha, releaseSha], `${mode} caller must pin bootstrap and reusable workflow identically`);
    assert.match(template, /bootstrap:\n(?:\s+(?:needs|if): [^\n]+\n)*\s+name: Codekeeper pinned tooling bootstrap\n(?:\s+(?:needs|if): [^\n]+\n)*\s+runs-on: ubuntu-latest/);
    assert.match(template, new RegExp(`(?:maintain|fix|triage|review):\\n\\s+needs: (?:bootstrap|\\[[^\\n]*bootstrap[^\\n]*\\])\\n(?:\\s+if: [^\\n]+\\n)?\\s+uses: OWNER/REPOSITORY/\\.github/workflows/codekeeper-${mode}\\.yml@FULL_COMMIT_SHA`));
    const bootstrap = template.slice(template.indexOf("  bootstrap:\n"), template.indexOf(`  ${mode === "issues" ? "triage" : mode === "maintain" ? "maintain" : mode}:\n`));
    const bootstrapArtifactNames = [...bootstrap.matchAll(/^ {10}artifact-name: ([^\n]+)$/gm)].map((match) => match[1]);
    assert.deepEqual(
      bootstrapArtifactNames,
      [bootstrapToolingArtifactName],
      `${mode} caller must produce exactly the run-scoped bootstrap artifact`
    );
    assert.doesNotMatch(bootstrap, /secrets:|GITHUB_TOKEN|GH_TOKEN|APP_PRIVATE_KEY/);
  }
});

test("reusable workflows consume only a source-manifest-bound bootstrap artifact", async () => {
  const manifest = await readFile(path.join(repositoryRoot, toolingManifestPath));
  assert.equal(sha256(manifest), toolingManifestSha256);
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.version, 1);
  assert.ok(parsedManifest.files.some((entry) => entry.path === "src/cli.mjs"));
  assert.ok(parsedManifest.files.some((entry) => entry.path === "scripts/verify-tooling-artifact.mjs"));
  assert.ok(parsedManifest.files.every((entry) => !entry.path.startsWith("test/") && !entry.path.startsWith("evals/")));

  const expectedConsumers = { maintain: 5, fix: 5, issues: 4, review: 4 };
  for (const [mode, count] of Object.entries(expectedConsumers)) {
    const source = await workflow(mode);
    assert.equal([...source.matchAll(/name: Download bootstrap Codekeeper tooling/g)].length, count);
    assert.equal([...source.matchAll(/name: Verify bootstrap Codekeeper tooling against pinned manifest/g)].length, count);
    assert.equal([...source.matchAll(/name: Check out frozen maintainer tooling/g)].length, 0);
    assert.match(source, new RegExp(`CODEKEEPER_TOOLING_MANIFEST_SHA256: ${toolingManifestSha256}`));
    assert.match(source, /node --input-type=module -e/);
    assert.match(source, /manifest does not match the pinned workflow/);
    assert.match(source, /verifier does not match the pinned manifest/);
    assert.match(source, /verify-tooling-artifact\.mjs/);
    assert.equal(
      [...source.matchAll(/import \{ lstat, readFile \} from "node:fs\/promises"; import \{ join \} from "node:path";/g)].length,
      count
    );
    assert.doesNotMatch(source, /^\s*import \{ join \} from "node:path";$/m);
    assert.doesNotMatch(source, /\$\{(?:root|label)\}/);
    const bootstrapArtifactNames = [...source.matchAll(/^ {10}name: (codekeeper-tooling-[^\n]+)$/gm)]
      .map((match) => match[1]);
    assert.deepEqual(
      bootstrapArtifactNames,
      Array(count).fill(bootstrapToolingArtifactName),
      `${mode} must consume the caller bootstrap artifact by run ID only so failed-job reruns reuse verified tooling`
    );
    const workspaceArtifactName = `codekeeper-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}-workspace-\${{ github.run_id }}-\${{ github.run_attempt }}`;
    const workspaceArtifactNames = [...source.matchAll(/^ {10}name: (codekeeper-[^\n]*-workspace-[^\n]+)$/gm)]
      .map((match) => match[1]);
    assert.deepEqual(
      workspaceArtifactNames,
      [workspaceArtifactName, workspaceArtifactName],
      `${mode} workspace handoff must remain attempt-scoped`
    );
    assert.doesNotMatch(source, /job\.workflow_repository/);
    assert.doesNotMatch(source, /repository: \$\{\{ job\.workflow_repository \}\}/);
  }
});

test("private-action bootstrap stages only the production runtime and retains it for one day", async () => {
  const action = await repositoryFile("tools/codekeeper/action.yml");
  assert.match(action, /using: composite/);
  assert.match(action, /ACTION_PATH: \$\{\{ github\.action_path \}\}/);
  assert.match(action, /for file in package\.json package-lock\.json tooling-manifest\.json/);
  assert.match(action, /for directory in agents presets src/);
  assert.match(action, /scripts\/verify-tooling-artifact\.mjs/);
  assert.match(action, /find "\$target" -type l/);
  assert.match(action, /if find "\$target" -type l -print -quit \| grep -q \.; then/);
  assert.doesNotMatch(action, /grep -q \. &&/);
  assert.match(action, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(action, /description: Exact run-scoped bootstrap artifact name derived from github\.run_id; reruns replace this verified tooling artifact\./);
  assert.match(action, /name: \$\{\{ inputs\.artifact-name \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/codekeeper-tooling\n\s+retention-days: 1\n\s+if-no-files-found: error\n\s+overwrite: true/);
  assert.match(action, /retention-days: 1/);
  assert.doesNotMatch(action, /secrets\.|GITHUB_TOKEN|GH_TOKEN|actions\/checkout/);
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
    assert.match(workspace, /output-schema-file: \$\{\{ runner\.temp \}\}\/codekeeper-bundle\/schema\.json/);
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
    if (mode === "fix") {
      assert.match(publish, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?path: policy/);
      assert.match(publish, /ref: \$\{\{ needs\.analyze\.outputs\.base_sha \}\}[\s\S]*?path: repository/);
      assert.match(publish, /CONFIG: \$\{\{ github\.workspace \}\}\/policy\/\.github\/codekeeper\.json/);
    } else {
      assert.match(
        publish,
        /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?path: repository/
      );
      assert.match(publish, /CONFIG: \$\{\{ github\.workspace \}\}\/repository\/\.github\/codekeeper\.json/);
    }
    assert.match(publish, /--config "\$CONFIG"/);
    assert.match(publish, /--agent-profile "\$AGENT_PROFILE"/);
    assert.match(publish, /--expected-manifest-sha "\$MANIFEST_SHA256"/);
    assert.doesNotMatch(publish, /openai\/codex-action@|validate-|seal-/);
  }
});

test("candidate and sealed artifact handoffs retain exact run-and-attempt names", async () => {
  for (const mode of modes) {
    const source = await workflow(mode);
    const artifactPrefix = `codekeeper-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}`;
    const candidateArtifactName = `${artifactPrefix}-candidate-\${{ github.run_id }}-\${{ github.run_attempt }}`;
    const sealedArtifactName = `${artifactPrefix}-artifact-\${{ github.run_id }}-\${{ github.run_attempt }}`;
    const candidateHandoffCount = mode === "maintain" || mode === "fix" ? 3 : 2;
    const candidateArtifactNames = [...source.matchAll(/^ {10}name: (codekeeper-[^\n]*-candidate-[^\n]+)$/gm)]
      .map((match) => match[1]);
    const sealedArtifactNames = [...source.matchAll(/^ {10}name: (codekeeper-[^\n]*-artifact-[^\n]+)$/gm)]
      .map((match) => match[1]);
    assert.deepEqual(
      candidateArtifactNames,
      Array(candidateHandoffCount).fill(candidateArtifactName),
      `${mode} candidate producer and consumer must use the same run-and-attempt artifact name`
    );
    assert.deepEqual(
      sealedArtifactNames,
      [sealedArtifactName, sealedArtifactName],
      `${mode} sealed artifact producer and consumer must use the same run-and-attempt artifact name`
    );
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

test("live maintenance runs use the enabled repair capability without a second approval", async () => {
  const source = await workflow("maintain");
  const caller = await repositoryFile("examples/workflows/codekeeper-maintain.yml.example");
  const workspace = jobSection(source, "workspace", "analyze");

  assert.doesNotMatch(source, /repair_authorized:\n\s+description:/);
  assert.match(workspace, /--actor "\$GITHUB_ACTOR"/);
  assert.match(workspace, /--repair-authorized "\$REPAIR_AUTHORIZED"/);
  assert.match(workspace, /--mutation-authorized "\$REPAIR_AUTHORIZED"/);
  assert.equal(
    [...source.matchAll(/REPAIR_AUTHORIZED: \$\{\{ !inputs\.dry_run \}\}/g)].length,
    3,
    "every maintenance stage must bind repair authority to a live run"
  );
  assert.doesNotMatch(caller, /repair_authorized:/);
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
  const publisher = await repositoryFile("tools/codekeeper/src/lib/publish.mjs");
  const caller = await repositoryFile("examples/workflows/codekeeper-review.yml.example");
  const gate = jobSection(source, "gate");
  assert.match(source, /cancel-in-progress: \$\{\{ github\.actor != inputs\.automation_bot_login \}\}/);
  assert.match(gate, /name: Codekeeper review gate/);
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /fails closed/);
  assert.match(gate, /exit 1/);
  assert.match(source, /auto_review:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/);
  assert.match(source, /feedback_triage:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/);
  assert.match(source, /owner_command:\n\s+description:[^\n]*\n\s+required: false\n\s+default: false\n\s+type: boolean/);
  assert.match(jobSection(source, "workspace", "analyze"), /inputs\.auto_review/);
  assert.match(
    jobSection(source, "workspace", "analyze"),
    /github\.event_name == 'repository_dispatch'[\s\S]*github\.event\.action == 'codekeeper_review'[\s\S]*github\.actor == inputs\.automation_bot_login/
  );
  assert.match(
    jobSection(source, "workspace", "analyze"),
    /feedback_triage[\s\S]*github\.actor != inputs\.automation_bot_login/
  );
  assert.match(
    publisher,
    /createRepositoryDispatch\("codekeeper_fix", \{[\s\S]*authorization_mode: "policy"/
  );
  assert.doesNotMatch(jobSection(source, "workspace", "analyze"), /inputs\.auto_review &&\s*\(\(github\.event_name/);
  assert.match(gate, /IS_COMMAND_REVIEW/);
  assert.match(gate, /IS_OWNER_COMMAND_REVIEW: \$\{\{ inputs\.owner_command \}\}/);
  assert.match(gate, /Owner review command is intentionally routed by the repository assistant/);
  assert.match(
    jobSection(source, "workspace", "analyze"),
    /contains\(fromJSON\('\["\/codekeeper status"[\s\S]*"\/codekeeper stop"\]'\), github\.event\.comment\.body\)/
  );
  assert.match(gate, /Codekeeper-authored review feedback is intentionally ignored/);
  assert.match(caller, /auto_review: true/);
  assert.match(caller, /feedback_triage: true/);
  assert.match(caller, /const mentioned = mentionBot && new RegExp\(`/);
  assert.match(caller, /appendFileSync\(process\.env\.GITHUB_OUTPUT, `owner_command=\$\{commandIntent\}\\nroute=\$\{route\}\\n`\)/);
  assert.match(caller, /owner_command: \$\{\{ needs\.intent\.outputs\.owner_command == 'true' \}\}/);
  assert.match(caller, /intent:\n\s+name: Detect Codekeeper review feedback/);
  assert.match(caller, /const commandIntent = eventName === "pull_request_review_comment" && trustedAssociation && \(slash \|\| mentioned\)/);
  assert.match(caller, /bootstrap:\n\s+needs: intent\n\s+if: needs\.intent\.outputs\.route == 'true'/);
  assert.match(caller, /review:\n\s+needs: \[intent, bootstrap\]\n\s+if: needs\.intent\.outputs\.route == 'true' && needs\.bootstrap\.result == 'success'/);
  assert.match(source, /!\(github\.event_name == 'pull_request_review_comment'[\s\S]*github\.event\.comment\.user\.login == inputs\.automation_bot_login\)/);
  assert.doesNotMatch(source, /publish-review-status|on:\n\s+pull_request_target|state="success"/);
});

test("issue triage can start enabled issue implementation while owner PR repair stays gated", async () => {
  const issue = await workflow("issues");
  const fix = await workflow("fix");
  const caller = await repositoryFile("examples/workflows/codekeeper-issues.yml.example");
  assert.match(issue, /auto_triage:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/);
  assert.match(issue, /inputs\.auto_triage &&\s+github\.event_name == 'issues'/);
  for (const action of ["opened", "reopened", "edited"]) assert.match(issue, new RegExp(`github\\.event\\.action == '${action}'`));
  assert.doesNotMatch(issue, /owner_requests|github\.event\.comment\.body/);
  assert.match(issue, /TRIAGE_MODE: \$\{\{ github\.event_name == 'issues' && 'automatic' \|\| 'manual' \}\}/);
  assert.match(issue, /codekeeper_issue[\s\S]*github\.actor == inputs\.automation_bot_login/);
  assert.match(issue, /prepare-issue[\s\S]*--actor "\$REQUESTED_BY"/);
  assert.match(issue, /prepare-issue[\s\S]*--triage-mode "\$TRIAGE_MODE"/);
  assert.match(caller, /issues:\n\s+types: \[opened, reopened, edited\]/);
  assert.doesNotMatch(caller, /issue_comment:/);
  assert.match(caller, /auto_triage: true/);
  assert.match(caller, /run-name: "Codekeeper issue triage #\$\{\{ github\.event\.issue\.number \|\| github\.event\.client_payload\.number \}\}"/);

  assert.doesNotMatch(fix, /owner_requests|github\.event\.comment\.body/);
  assert.match(fix, /allow-users: \$\{\{ github\.actor \}\}/);
  assert.match(fix, /--target-number "\$TARGET_NUMBER"/);
  assert.match(fix, /fromJSON\(steps\.prepare\.outputs\.result\)\.baseSha/);
  assert.match(fix, /ref: \$\{\{ needs\.analyze\.outputs\.base_sha \}\}/);
  assert.match(fix, /Check out frozen repair target/);
  assert.match(fix, /github\.event_name == 'issues'/);
  assert.match(fix, /github\.event\.action == 'labeled'/);
  assert.match(fix, /github\.event\.label\.name == 'codekeeper:ready'/);
  assert.match(fix, /automation_bot_login:/);
  assert.match(fix, /github\.event\.sender\.login == inputs\.automation_bot_login/);
  assert.match(fix, /github\.event_name == 'repository_dispatch'[\s\S]*github\.event\.action == 'codekeeper_fix'[\s\S]*github\.actor == inputs\.automation_bot_login/);
  assert.match(fix, /github\.event\.client_payload\.authorization_mode/);
  assert.match(fix, /--review-thread-ids "\$REVIEW_THREAD_IDS"/);
  assert.match(fix, /--authorization-mode "\$AUTHORIZATION_MODE"/);
  assert.doesNotMatch(fix, /planner_model_api_key|prepare-plan|plan-result|plan-context/);
  assert.doesNotMatch(fix, /\n  command:/);
  const fixCaller = await repositoryFile("examples/workflows/codekeeper-fix.yml.example");
  assert.match(fixCaller, /issues:\n\s+types: \[labeled\]/);
  assert.doesNotMatch(fixCaller, /issue_comment:/);
  assert.match(fixCaller, /automation_bot_login: \$\{\{ vars\.CODEKEEPER_AUTOMATION_BOT_LOGIN \}\}/);
  const commands = await repositoryFile("tools/codekeeper/src/lib/commands.mjs");
  assert.match(commands, /pull\.base\?\.ref !== defaultBranch/);
  assert.match(commands, /removeLabel\(number, "codekeeper:paused"\)/);
});

test("owner-commanded pull request repair can update only the frozen existing head", async () => {
  const fix = await workflow("fix");
  const assistant = await workflow("assistant");
  const assistantCaller = await repositoryFile("examples/workflows/codekeeper-assistant.yml.example");
  const publisher = await repositoryFile("tools/codekeeper/src/lib/pr-repair.mjs");
  assert.match(assistant, /owner_requests:/);
  assert.match(assistant, /installed_modes:/);
  assert.match(assistant, /owner-command/);
  assert.match(assistant, /--installed-modes "\$INSTALLED_MODES"/);
  assert.match(assistantCaller, /issue_comment:[\s\S]*pull_request_review_comment:/);
  assert.match(assistantCaller, /intent:\n[\s\S]*route=/);
  assert.match(assistantCaller, /bootstrap:\n\s+needs: intent\n\s+if: needs\.intent\.outputs\.route == 'true'/);
  assert.match(assistantCaller, /installed_modes: review,maintain,issues,fix/);
  assert.match(assistantCaller, /codekeeper-assistant\.yml@FULL_COMMIT_SHA/);
  assert.doesNotMatch(fix, /\n  command:|github\.event\.comment\.body/);
  assert.doesNotMatch(fix, /!github\.event\.issue\.pull_request/);
  assert.match(fix, /target_kind: \$\{\{ fromJSON\(steps\.prepare\.outputs\.result\)\.target\.kind \}\}/);
  assert.equal([...fix.matchAll(/Check out frozen repair target/g)].length, 4);
  assert.match(publisher, /createCommitOnCurrentHead/);
  assert.match(publisher, /pushHeadToBranch\(target\.headRef/);
  assert.match(publisher, /expectedHeadSha: commitSha/);
  assert.match(publisher, /resolveReviewThread/);
  assert.match(publisher, /listPullReviewThreads/);
  assert.doesNotMatch(publisher, /createPull|createBranchAndCommit|pushBranch|enableAutoMerge|updateIssue|deleteBranch/);
});

test("documentation uses the live feedback input and owner-authorized defer contract", async () => {
  const configuration = await repositoryFile("docs/CONFIGURATION.md");
  const install = await repositoryFile("INSTALL.md");
  assert.match(configuration, /`feedback_triage` defaults to `true`/);
  assert.doesNotMatch(configuration, /auto_review_feedback/);
  assert.match(install, /owner-authorized deferral/i);
  assert.doesNotMatch(install, /asks the assistant to verify the claim/);
});

test("Fixer repository dispatches retain their target and explicit policy authorization", async () => {
  const fix = await workflow("fix");
  const analyze = jobSection(fix, "analyze", "verify");
  const publisher = await repositoryFile("tools/codekeeper/src/lib/publish.mjs");
  assert.match(analyze, /EVENT_ISSUE: \$\{\{ github\.event\.issue\.number \|\| github\.event\.client_payload\.number \}\}/);
  assert.match(publisher, /createRepositoryDispatch\("codekeeper_fix", \{[\s\S]*authorization_mode: "policy"/);
  assert.match(publisher, /createRepositoryDispatch\("codekeeper_fix", \{[\s\S]*requested_by: automationIdentity\.login/);
});

test("Agents SDK coordinators use pinned dependencies and isolated credentials", async () => {
  const packageJson = JSON.parse(await repositoryFile("tools/codekeeper/package.json"));
  const packageLock = JSON.parse(await repositoryFile("tools/codekeeper/package-lock.json"));
  assert.deepEqual(packageJson.dependencies, { "@openai/agents": "0.14.3", zod: "4.4.3" });
  assert.equal(packageLock.lockfileVersion, 3);
  assert.equal(packageLock.packages[""].dependencies["@openai/agents"], "0.14.3");
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
    assert.match(workspace, /codex-home: \$\{\{ runner\.temp \}\}\/codekeeper-codex-home/);
    assert.match(workspace, /project_doc_max_bytes = 0/);
    assert.match(workspace, /project_doc_fallback_filenames = \[\]/);
    assert.match(workspace, /include_instructions = false/);
    assert.match(workspace, /bundled = \{ enabled = false \}/);
    assert.match(workspace, /Refusing symlinked \.agents instruction root/);
    assert.match(workspace, /Refusing symlinked \.codex instruction root/);
    assert.match(workspace, /\.agents\/skills \.codex\/skills/);
    assert.match(workspace, /if \[ -e "\$surface" \] \|\| \[ -L "\$surface" \]; then[\s\S]*contaminated=true[\s\S]*if \[ -e "\$QUARANTINE\/\$surface" \]/);
    assert.match(workspace, /workspace-prompt\.md/);
    assert.doesNotMatch(workspace, /prompt-file: .*\/prompt\.md/);
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

test("pull request repair runs reviewer then one-pass fixer roles", async () => {
  const source = await workflow("fix");
  assert.doesNotMatch(source, /\n  plan:|maintenance-planner\.md|--mode plan|plan-result\.json/);
  assert.match(jobSection(source, "workspace", "analyze"), /fixer\.md[\s\S]*workspace-prompt\.md/);
  assert.match(jobSection(source, "analyze", "verify"), /fixer\.md[\s\S]*--mode fix/);
});
