import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_COMMANDS } from "../src/lib/owner-commands.mjs";
import {
  execFileAsync,
  jobSection,
  modes,
  repositoryFile,
  repositoryRoot,
  stepRunScript,
  workflow,
} from "./workflow-test-helpers.mjs";

const stagedModes = modes.filter((mode) => mode !== "review");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("workflow owner-command lists stay synchronized with the canonical definition", async () => {
  await execFileAsync(
    process.execPath,
    ["tools/codekeeper/scripts/sync-owner-command-lists.mjs", "--check"],
    { cwd: repositoryRoot },
  );

  const expectedCondition = `contains(fromJSON('${JSON.stringify(
    OWNER_COMMANDS.map((command) => `/codekeeper ${command}`),
  )}'), github.event.comment.body)`;
  const expectedActions = `const actions = ${JSON.stringify(OWNER_COMMANDS)};`;
  const reviewCaller = await repositoryFile(
    "examples/workflows/codekeeper-review.yml.example",
  );
  const packagedReviewCaller = await repositoryFile(
    "packages/codekeeper/assets/workflows/review.yml",
  );
  const reviewRuntime = await workflow("review");

  assert.match(reviewCaller, new RegExp(escapeRegExp(expectedCondition)));
  assert.equal(packagedReviewCaller, reviewCaller);
  assert.match(reviewRuntime, new RegExp(escapeRegExp(expectedActions)));
});

test("issue comment routing keeps one balanced GitHub expression", async () => {
  const source = await workflow("issues");
  const expression = jobSection(source, "workspace", "analyze").match(
    /if: >-\n([\s\S]*?)\n\s+# CODEKEEPER_OWNER_COMMANDS_END/,
  )?.[1];
  assert.ok(expression, "issue workspace expression is present");
  let depth = 0;
  for (const character of expression) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    assert.ok(
      depth >= 0,
      "issue workspace expression never closes before it opens",
    );
  }
  assert.equal(depth, 0, "issue workspace expression has balanced parentheses");
});

test("staged modes isolate untrusted candidate creation, tokenless sealing, and App publication", async () => {
  for (const mode of stagedModes) {
    const source = await workflow(mode);
    const repairMode = mode === "maintain" || mode === "fix";
    const workspace = jobSection(source, "workspace", "analyze");
    const analyze = jobSection(
      source,
      "analyze",
      repairMode ? "verify" : "seal",
    );
    const verify = repairMode ? jobSection(source, "verify", "seal") : null;
    const seal = jobSection(
      source,
      "seal",
      mode === "review" ? "gate" : "publish",
    );
    const publish = jobSection(source, "publish");

    assert.match(workspace, /codekeeper-bundle/);
    assert.match(workspace, /codekeeper-config\.json/);
    assert.match(workspace, /--source-config "\$SOURCE_CONFIG"/);
    assert.match(workspace, /--default-branch "\$DEFAULT_BRANCH"/);
    assert.match(
      workspace,
      new RegExp(`stage compute --operation prepare --mode ${mode}`),
    );
    assert.match(
      workspace,
      new RegExp(`stage compute --operation workspace --mode ${mode}`),
    );
    assert.match(workspace, /--result "\$BUNDLE\/workspace-result\.json"/);
    assert.match(
      workspace,
      /outputs:\n\s+context_sha256: \$\{\{ steps\.prepare\.outputs\.context_sha256 \}\}/,
    );
    for (const preparation of [workspace, analyze]) {
      assert.match(preparation, /--agent-profile "\$AGENT_PROFILE"/);
      assert.match(
        preparation,
        /--agent-profile-source-sha "\$\(git(?: -C [^\n]+)? rev-parse HEAD\)"/,
      );
      assert.doesNotMatch(
        preparation,
        /PROFILE_ARGS|\[\[ -[Lef] "\$AGENT_PROFILE" \]\]/,
      );
    }
    if (repairMode) {
      assert.match(workspace, /--patch "\$BUNDLE\/workspace\.patch"/);
    } else {
      assert.doesNotMatch(
        workspace,
        /capture-workspace-patch|workspace\.patch/,
      );
    }
    assert.doesNotMatch(
      workspace,
      /secrets\.(?:model_api_key|trace_api_key|app_private_key|app_client_id)/,
    );
    assert.doesNotMatch(workspace, /CODEKEEPER_(?:MODEL|TRACE)_API_KEY/);
    assert.doesNotMatch(workspace, /create-github-app-token/);

    assert.match(analyze, /needs: workspace/);
    assert.match(analyze, /codekeeper-bundle/);
    assert.match(analyze, /codekeeper-config\.json/);
    assert.match(analyze, /--source-config "\$SOURCE_CONFIG"/);
    assert.match(analyze, /--default-branch "\$DEFAULT_BRANCH"/);
    assert.match(analyze, /codekeeper-candidate/);
    assert.match(
      analyze,
      new RegExp(`stage compute --operation prepare --mode ${mode}`),
    );
    assert.match(
      analyze,
      new RegExp(`stage validate --operation candidate --mode ${mode}`),
    );
    assert.match(analyze, /download-artifact@/);
    assert.match(
      analyze,
      /--workspace-result "\$WORKSPACE\/workspace-result\.json"/,
    );
    assert.match(
      analyze,
      /--expected-context-sha "\$\{\{ needs\.workspace\.outputs\.context_sha256 \}\}"/,
    );
    assert.match(analyze, /steps\.prepare\.outputs\.context_sha256/);
    if (repairMode) {
      assert.match(
        analyze,
        /--workspace-patch "\$WORKSPACE\/workspace\.patch"/,
      );
    } else {
      assert.doesNotMatch(analyze, /apply-workspace-patch|workspace\.patch/);
    }
    assert.doesNotMatch(
      analyze,
      /openai\/codex-action@|secrets\.(?:workspace_api_key|openai_api_key|app_private_key)/,
    );
    assert.doesNotMatch(analyze, /create-github-app-token/);

    if (mode === "fix") {
      assert.match(
        workspace,
        /repository_sha: \$\{\{ steps\.repository-source\.outputs\.sha \}\}/,
      );
      assert.match(
        workspace,
        /id: repository-source[\s\S]*echo "sha=\$\(git rev-parse HEAD\)"/,
      );
      assert.match(
        workspace,
        /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/,
      );
      assert.doesNotMatch(workspace, /ref: \$\{\{ github\.sha \}\}/);
      assert.match(
        analyze,
        /ref: \$\{\{ needs\.workspace\.outputs\.repository_sha \}\}/,
      );
      assert.doesNotMatch(workspace, /agentProfile\.sourceSha/);
    }

    if (verify) {
      assert.match(
        verify,
        new RegExp(`stage validate --operation verify --mode ${mode}`),
      );
      assert.match(verify, /expected-candidate-sha/);
      assert.match(verify, /without OpenAI or App credentials/);
      assert.doesNotMatch(
        verify,
        /openai\/codex-action@|create-github-app-token|secrets\.|github\.token|GITHUB_TOKEN|(?:CODEKEEPER_)?APP_PRIVATE_KEY|CODEKEEPER_(?:MODEL|TRACE|WORKSPACE)_API_KEY/,
      );
      assert.match(verify, /permissions:\n\s+contents: read/);
      assert.match(source, /needs: \[workspace, analyze, verify\]/);
    }

    assert.match(seal, /codekeeper-candidate/);
    assert.match(seal, /codekeeper-artifact/);
    assert.match(
      seal,
      new RegExp(`stage validate --operation seal --mode ${mode}`),
    );
    assert.match(
      seal,
      /manifest_sha256: \$\{\{ steps\.seal\.outputs\.manifest_sha256 \}\}/,
    );
    assert.match(seal, /id: seal/);
    assert.doesNotMatch(seal, /openai\/codex-action@|create-github-app-token/);

    assert.match(publish, /create-github-app-token/);
    assert.match(
      publish,
      /permission-contents: \$\{\{ inputs\.app_contents_permission \}\}/,
    );
    assert.match(
      publish,
      /permission-issues: \$\{\{ inputs\.app_issues_permission \}\}/,
    );
    assert.match(
      publish,
      /permission-pull-requests: \$\{\{ inputs\.app_pull_requests_permission \}\}/,
    );
    assert.match(publish, /CODEKEEPER_AUTOMATION_BOT_LOGIN/);
    assert.match(publish, /CODEKEEPER_AUTOMATION_BOT_ID/);
    assert.match(publish, /steps\.app-token\.outputs\.app-slug/);
    assert.match(publish, /stage publish --operation bot/);
    assert.match(publish, /--app-slug "\$APP_SLUG"/);
    assert.doesNotMatch(publish, /curl --globoff|\/user(?:["']|\))/);
    assert.match(publish, /codekeeper-artifact/);
    if (mode === "issues") {
      assert.match(
        publish,
        /node codekeeper-runtime\/src\/cli\.mjs stage publish --operation publish --mode issues/,
      );
      assert.doesNotMatch(
        publish,
        /node tools\/codekeeper\/src\/cli\.mjs publish-issue/,
      );
    }
    if (mode === "fix") {
      assert.match(
        publish,
        /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?path: policy/,
      );
      assert.match(
        publish,
        /ref: \$\{\{ needs\.analyze\.outputs\.base_sha \}\}[\s\S]*?path: repository/,
      );
      assert.match(
        publish,
        /CONFIG: \$\{\{ github\.workspace \}\}\/policy\/\.github\/codekeeper\.json/,
      );
    } else {
      assert.match(
        publish,
        /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?path: repository/,
      );
      assert.match(
        publish,
        /CONFIG: \$\{\{ github\.workspace \}\}\/repository\/\.github\/codekeeper\.json/,
      );
    }
    assert.match(publish, /--config "\$CONFIG"/);
    assert.match(
      publish,
      /CODEKEEPER_TOOLING_SHA: \$\{\{ needs\.workspace\.outputs\.package_source_commit \}\}/,
    );
    assert.match(publish, /--agent-profile "\$AGENT_PROFILE"/);
    assert.match(
      publish,
      /--agent-profile-source-sha "\$\(git -C [^\n]+ rev-parse HEAD\)"/,
    );
    assert.doesNotMatch(
      publish,
      /PROFILE_ARGS|\[\[ -[Lef] "\$AGENT_PROFILE" \]\]/,
    );
    assert.match(publish, /--expected-manifest-sha "\$MANIFEST_SHA256"/);
    assert.doesNotMatch(publish, /openai\/codex-action@|validate-|seal-/);
  }
});

test("workflow handoff artifacts survive failed-job reruns and producers replace full reruns", async () => {
  for (const mode of stagedModes) {
    const source = await workflow(mode);
    const artifactPrefix = `codekeeper-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}`;
    const workspaceArtifactName = `${artifactPrefix}-workspace-\${{ github.run_id }}`;
    const candidateArtifactName = `${artifactPrefix}-candidate-\${{ github.run_id }}`;
    const validationReceiptArtifactName = `${artifactPrefix}-validation-receipt-\${{ github.run_id }}`;
    const sealedArtifactName = `${artifactPrefix}-artifact-\${{ github.run_id }}`;
    const repairMode = mode === "maintain" || mode === "fix";
    const candidateArtifactNames = [
      ...source.matchAll(
        /^ {10}name: (codekeeper-(?![^\n]*-verified-candidate-)[^\n]*-candidate-[^\n]+)$/gm,
      ),
    ].map((match) => match[1]);
    const validationReceiptArtifactNames = [
      ...source.matchAll(
        /^ {10}name: (codekeeper-[^\n]*-validation-receipt-[^\n]+)$/gm,
      ),
    ].map((match) => match[1]);
    const sealedArtifactNames = [
      ...source.matchAll(/^ {10}name: (codekeeper-[^\n]*-artifact-[^\n]+)$/gm),
    ].map((match) => match[1]);
    assert.deepEqual(
      candidateArtifactNames,
      Array(repairMode ? 3 : 2).fill(candidateArtifactName),
      `${mode} candidate producer and consumers must use the same run-stable artifact name`,
    );
    assert.deepEqual(
      validationReceiptArtifactNames,
      repairMode
        ? [validationReceiptArtifactName, validationReceiptArtifactName]
        : [],
      `${mode} validation receipt producer and consumer must use the same run-stable artifact name`,
    );
    assert.deepEqual(
      sealedArtifactNames,
      [sealedArtifactName, sealedArtifactName],
      `${mode} sealed artifact producer and consumer must use the same run-stable artifact name`,
    );
    const replaceableUploads = [
      ...source.matchAll(
        /uses: actions\/upload-artifact@[^\n]+\n\s+with:\n\s+name: (codekeeper-[^\n]+)\n[\s\S]*?\n\s+retention-days: 1\n\s+if-no-files-found: error\n\s+overwrite: true/g,
      ),
    ].map((match) => match[1]);
    assert.deepEqual(
      replaceableUploads,
      [
        `codekeeper-tooling-\${{ github.run_id }}`,
        workspaceArtifactName,
        candidateArtifactName,
        ...(repairMode ? [validationReceiptArtifactName] : []),
        sealedArtifactName,
      ],
      `${mode} must replace each run-stable handoff when every job is rerun`,
    );
    if (repairMode) {
      assert.match(
        source,
        /name: codekeeper-(?:fix|maintenance)-validation-receipt-\$\{\{ github\.run_id \}\}\n\s+path: \|\n\s+\$\{\{ runner\.temp \}\}\/codekeeper-candidate\/validation-receipt\.json\n\s+\$\{\{ runner\.temp \}\}\/codekeeper-candidate\/envelope\.json\n\s+\$\{\{ runner\.temp \}\}\/codekeeper-candidate\/handoff\.json/,
        `${mode} must serialize the validation receipt with its updated envelope and manifest`,
      );
      assert.match(
        source,
        /name: codekeeper-(?:fix|maintenance)-validation-receipt-\$\{\{ github\.run_id \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/codekeeper-candidate/,
        `${mode} must overlay the complete validation handoff before sealing`,
      );
    }
  }
});

test("issue preparation can read pull requests in every caller and job that invokes it", async () => {
  const source = await workflow("issues");
  const caller = await repositoryFile(
    "examples/workflows/codekeeper-issues.yml.example",
  );
  const workflowPermissions = source.slice(
    source.indexOf("\npermissions:"),
    source.indexOf("\nenv:"),
  );
  assert.match(workflowPermissions, /pull-requests: read/);
  assert.match(
    caller,
    /permissions:\n\s+contents: read\n\s+issues: read\n\s+pull-requests: read/,
  );
  for (const section of [
    jobSection(source, "workspace", "analyze"),
    jobSection(source, "analyze", "seal"),
  ]) {
    assert.match(section, /stage compute --operation prepare --mode issues/);
    assert.match(
      section,
      /permissions:\n\s+contents: read\n\s+issues: read\n\s+pull-requests: read/,
    );
  }
});

test("maintenance and fix dry runs do not require App credentials, but publication fails closed without them", async () => {
  for (const mode of ["maintain", "fix"]) {
    const source = await workflow(mode);
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    const publish = jobSection(source, "publish");

    assert.match(
      source,
      /app_client_id:\n\s+description: GitHub App client ID\. Required only when dry_run=false\.\n\s+required: false\n\s+default: ""\n\s+type: string/,
    );
    assert.match(
      source,
      /app_private_key:\n\s+description: GitHub App private key\. Required only when dry_run=false\.\n\s+required: false/,
    );
    assert.match(
      source,
      /if: needs\.seal\.result == 'success' && !inputs\.dry_run/,
    );
    assert.match(publish, /stage publish --operation preconditions/);
    assert.match(publish, /APP_CLIENT_ID: \$\{\{ inputs\.app_client_id \}\}/);
    assert.match(
      publish,
      /APP_PRIVATE_KEY: \$\{\{ secrets\.app_private_key \}\}/,
    );
    assert.ok(
      publish.indexOf("stage publish --operation preconditions") <
        publish.indexOf("create-github-app-token"),
      `${mode} must check credentials before minting an App token`,
    );
    assert.match(
      caller,
      /Optional for dry_run=true; required when dry_run=false publishes changes\./,
    );
    assert.match(
      caller,
      /app_client_id: \$\{\{ vars\.CODEKEEPER_APP_CLIENT_ID \}\}/,
    );
    assert.match(
      caller,
      /app_private_key: \$\{\{ secrets\.CODEKEEPER_APP_PRIVATE_KEY \}\}/,
    );
  }
});

test("live maintenance runs use the enabled repair capability without a second approval", async () => {
  const source = await workflow("maintain");
  const caller = await repositoryFile(
    "examples/workflows/codekeeper-maintain.yml.example",
  );
  const workspace = jobSection(source, "workspace", "analyze");

  assert.doesNotMatch(source, /repair_authorized:\n\s+description:/);
  assert.match(workspace, /--actor "\$GITHUB_ACTOR"/);
  assert.match(workspace, /--repair-authorized "\$REPAIR_AUTHORIZED"/);
  assert.match(workspace, /--mutation-authorized "\$REPAIR_AUTHORIZED"/);
  assert.equal(
    [...source.matchAll(/REPAIR_AUTHORIZED: \$\{\{ !inputs\.dry_run \}\}/g)]
      .length,
    3,
    "every maintenance stage must bind repair authority to a live run",
  );
  assert.doesNotMatch(caller, /repair_authorized:/);
});

test("review and issue-triage retain mandatory App credentials", async () => {
  for (const mode of ["review", "issues"]) {
    const source = await workflow(mode);
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );

    assert.match(
      source,
      /app_client_id:\n\s+description: GitHub App client ID\. This identifier is not secret\.\n\s+required: true\n\s+type: string/,
    );
    assert.match(source, /app_private_key:\n\s+required: true/);
    assert.match(
      caller,
      /app_client_id: \$\{\{ vars\.CODEKEEPER_APP_CLIENT_ID \}\}/,
    );
    assert.match(
      caller,
      /app_private_key: \$\{\{ secrets\.CODEKEEPER_APP_PRIVATE_KEY \}\}/,
    );
  }
});

test("merged review gate executes the same fail-closed publication contract", async () => {
  const script = stepRunScript(
    await workflow("review"),
    "Fail closed unless a current review was published",
  );
  const baseEnvironment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ENABLED: "true",
    AUTO_REVIEW: "true",
    AUTO_REVIEW_FEEDBACK: "true",
    IS_AUTOMATION_REPLY: "false",
    IS_REVIEW_FEEDBACK: "false",
    IS_COMMAND_REVIEW: "false",
    IS_OWNER_COMMAND_REVIEW: "false",
    HEAD_REPOSITORY: "octo/example",
    BASE_REPOSITORY: "octo/example",
    HEAD_SHA: "a".repeat(40),
    BASE_SHA: "b".repeat(40),
    REPOSITORY: "octo/example",
    BASE_REF: "main",
    DEFAULT_BRANCH: "main",
    ACTOR: "maintainer",
    AUTOMATION_BOT_LOGIN: "codekeeper[bot]",
    ANALYZE_RESULT: "success",
    SEAL_RESULT: "success",
    PUBLISH_DISPOSITION: "published",
    PUBLISH_BLOCKING: "false",
    GITHUB_STEP_SUMMARY: "/dev/null",
  };
  const runGate = (overrides = {}) =>
    execFileAsync("bash", ["-c", script], {
      env: { ...baseEnvironment, ...overrides },
      maxBuffer: 16 * 1024,
    });

  const passed = await runGate();
  assert.equal(passed.stdout, "");

  for (const overrides of [
    { ANALYZE_RESULT: "skipped" },
    { SEAL_RESULT: "failure" },
  ]) {
    await assert.rejects(
      () => runGate(overrides),
      (error) =>
        error.code === 1 &&
        /Codekeeper did not seal a current review\./.test(error.stdout),
    );
  }
  for (const disposition of ["", "unexpected"]) {
    await assert.rejects(
      () => runGate({ PUBLISH_DISPOSITION: disposition }),
      (error) =>
        error.code === 1 &&
        /Codekeeper did not produce a sealed live review disposition\./.test(
          error.stdout,
        ),
    );
  }
  await assert.rejects(
    () => runGate({ PUBLISH_BLOCKING: "true" }),
    (error) =>
      error.code === 1 && /published blocking findings/.test(error.stdout),
  );

  const manual = await runGate({ PUBLISH_DISPOSITION: "manual" });
  assert.match(
    manual.stdout,
    /returned a manual-review disposition without mutation/,
  );
  const unsupported = await runGate({ PUBLISH_DISPOSITION: "unsupported" });
  assert.match(
    unsupported.stdout,
    /returned an unsupported disposition without mutation/,
  );

  const liveDispositionWins = await runGate({ IS_DRAFT: "true" });
  assert.equal(liveDispositionWins.stdout, "");

  await assert.rejects(
    () => runGate({ HEAD_REPOSITORY: "fork/example" }),
    (error) =>
      error.code === 1 &&
      /Fork pull requests are unsupported/.test(error.stdout),
  );

  const intentionalNoOp = await runGate({
    IS_AUTOMATION_REPLY: "true",
    ANALYZE_RESULT: "skipped",
    SEAL_RESULT: "skipped",
    PUBLISH_DISPOSITION: "",
  });
  assert.match(intentionalNoOp.stdout, /intentionally ignored/);

  await assert.rejects(
    () => runGate({ IS_OWNER_COMMAND_REVIEW: "true" }),
    (error) =>
      error.code === 1 &&
      /Owner review commands must be routed by the repository assistant/.test(
        error.stdout,
      ),
  );
});

test("review uses a direct caller and a two-runner PR-native fail-closed gate", async () => {
  const source = await workflow("review");
  const publisher = await repositoryFile(
    "tools/codekeeper/src/lib/publish.mjs",
  );
  const caller = await repositoryFile(
    "examples/workflows/codekeeper-review.yml.example",
  );
  const analyze = jobSection(source, "analyze", "gate");
  const gate = jobSection(source, "gate");

  assert.match(
    source,
    /cancel-in-progress: \$\{\{ github\.actor != inputs\.automation_bot_login \}\}/,
  );
  assert.match(gate, /name: Codekeeper review gate/);
  assert.match(
    gate,
    /if: always\(\) && needs\.analyze\.outputs\.route != 'false'/,
  );
  assert.match(gate, /timeout-minutes: 15/);
  assert.match(gate, /fails closed/);
  assert.match(gate, /exit 1/);
  assert.match(
    gate,
    /PUBLISH_DISPOSITION: \$\{\{ steps\.publish\.outputs\.result != '' && fromJSON\(steps\.publish\.outputs\.result\)\.disposition \|\| '' \}\}/,
  );
  assert.match(gate, /PUBLISH_BLOCKING:/);
  assert.doesNotMatch(gate, /steps\.publish\.outcome|IS_DRAFT:/);
  assert.doesNotMatch(source, /^  publish:\n/m);
  assert.match(
    source,
    /auto_review:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/,
  );
  assert.match(
    source,
    /feedback_triage:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/,
  );
  assert.match(
    source,
    /owner_command:\n\s+description:[^\n]*\n\s+required: false\n\s+default: false\n\s+type: boolean/,
  );
  assert.match(analyze, /AUTO_REVIEW: \$\{\{ inputs\.auto_review \}\}/);
  assert.match(analyze, /FEEDBACK_TRIAGE: \$\{\{ inputs\.feedback_triage \}\}/);
  assert.match(analyze, /OWNER_COMMAND: \$\{\{ inputs\.owner_command \}\}/);
  assert.match(
    analyze,
    /const dispatch = eventName === "repository_dispatch"[\s\S]*event\.action === "codekeeper_review"[\s\S]*actor === automationBot/,
  );
  assert.match(
    analyze,
    /const automatic = process\.env\.AUTO_REVIEW === "true" && eventName === "pull_request_target"/,
  );
  assert.match(
    analyze,
    /const feedback = process\.env\.FEEDBACK_TRIAGE === "true"[\s\S]*actor !== automationBot[\s\S]*feedbackEvent/,
  );
  assert.match(
    analyze,
    /const execute = process\.env\.ENABLED === "true" && route && eligible/,
  );
  assert.ok(
    analyze.indexOf("Detect Codekeeper review intent") <
      analyze.indexOf("Check out trusted default-branch configuration"),
  );
  assert.match(
    publisher,
    /createRepositoryDispatch\("codekeeper_fix", \{[\s\S]*authorization_mode: "policy"/,
  );
  assert.doesNotMatch(analyze, /^\s+if: >-/m);
  assert.match(gate, /IS_COMMAND_REVIEW/);
  assert.match(
    gate,
    /IS_OWNER_COMMAND_REVIEW: \$\{\{ needs\.analyze\.outputs\.owner_command \}\}/,
  );
  assert.match(
    gate,
    /Owner review commands must be routed by the repository assistant, not the required review gate/,
  );
  const expectedOwnerCommandCondition = `contains(fromJSON('${JSON.stringify(
    OWNER_COMMANDS.map((command) => `/codekeeper ${command}`),
  )}'), github.event.comment.body)`;
  assert.match(caller, new RegExp(escapeRegExp(expectedOwnerCommandCondition)));
  assert.match(
    gate,
    /Codekeeper-authored review feedback is intentionally ignored/,
  );
  assert.match(caller, /auto_review: true/);
  assert.match(caller, /feedback_triage: true/);
  assert.doesNotMatch(caller, /^  intent:/m);
  assert.doesNotMatch(caller, /needs\.intent|^\s+runs-on:/m);
  assert.match(
    caller,
    /review:\n[\s\S]*?uses: \.\/\.github\/workflows\/codekeeper-runtime-review\.yml/,
  );
  assert.match(
    caller,
    /Deterministic no-op feedback is filtered without allocating a runner/,
  );
  assert.doesNotMatch(
    source,
    /publish-review-status|on:\n\s+pull_request_target|state="success"/,
  );
});

test("issue triage can start enabled issue implementation while owner PR repair stays gated", async () => {
  const issue = await workflow("issues");
  const fix = await workflow("fix");
  const caller = await repositoryFile(
    "examples/workflows/codekeeper-issues.yml.example",
  );
  assert.match(
    issue,
    /auto_triage:\n\s+description:[^\n]*\n\s+required: false\n\s+default: true\n\s+type: boolean/,
  );
  assert.match(
    issue,
    /inputs\.auto_triage &&[\s\S]*github\.event_name == 'issues'/,
  );
  for (const action of ["opened", "reopened", "edited", "closed"])
    assert.match(issue, new RegExp(`github\\.event\\.action == '${action}'`));
  assert.match(
    issue,
    /github\.event_name == 'issue_comment'[\s\S]*github\.event\.action == 'created'/,
  );
  assert.match(issue, /codekeeper:needs-information/);
  assert.doesNotMatch(issue, /replace\(/);
  assert.doesNotMatch(issue, /owner_requests/);
  assert.match(issue, /CODEKEEPER_OWNER_COMMANDS_START/);
  assert.match(
    issue,
    /github\.event\.comment\.user\.login != inputs\.automation_bot_login/,
  );
  assert.match(
    issue,
    /github\.event\.comment\.user\.login == github\.event\.issue\.user\.login/,
  );
  assert.match(issue, /github\.event\.comment\.author_association/);
  assert.match(issue, /contains\(fromJSON\('\["\/codekeeper help"/);
  assert.match(
    issue,
    /TRIAGE_MODE: \$\{\{ \(github\.event_name == 'issues' \|\| github\.event_name == 'issue_comment'\) && 'automatic' \|\| 'manual' \}\}/,
  );
  assert.match(
    issue,
    /codekeeper_issue[\s\S]*github\.actor == inputs\.automation_bot_login/,
  );
  assert.match(
    issue,
    /stage compute --operation prepare --mode issues[\s\S]*--actor "\$REQUESTED_BY"/,
  );
  assert.match(
    issue,
    /stage compute --operation prepare --mode issues[\s\S]*--triage-mode "\$TRIAGE_MODE"/,
  );
  assert.match(
    caller,
    /issues:\n\s+types: \[opened, reopened, edited, closed\]\n\s+issue_comment:\n\s+types: \[created\]/,
  );
  assert.match(caller, /auto_triage: true/);
  assert.match(caller, /codekeeper:needs-information/);
  assert.match(caller, /Route a Codekeeper issue continuation/);
  assert.match(caller, /const mentioned = bot && new RegExp/);
  assert.match(caller, /needs\.continuation\.outputs\.route == 'true'/);
  assert.match(caller, /enabled: true/);
  assert.match(
    caller,
    /run-name: "Codekeeper issue triage #\$\{\{ github\.event\.issue\.number \|\| github\.event\.client_payload\.number \}\}"/,
  );

  assert.doesNotMatch(fix, /owner_requests|github\.event\.comment\.body/);
  assert.doesNotMatch(fix, /allow-users:/);
  assert.match(fix, /--target-number "\$TARGET_NUMBER"/);
  assert.match(fix, /fromJSON\(steps\.prepare\.outputs\.result\)\.baseSha/);
  assert.match(fix, /ref: \$\{\{ needs\.analyze\.outputs\.base_sha \}\}/);
  assert.match(fix, /Check out frozen repair target/);
  assert.match(fix, /github\.event_name == 'issues'/);
  assert.match(fix, /github\.event\.action == 'labeled'/);
  assert.match(fix, /github\.event\.label\.name == 'codekeeper:ready'/);
  assert.match(fix, /automation_bot_login:/);
  assert.match(
    fix,
    /github\.event\.sender\.login == inputs\.automation_bot_login/,
  );
  assert.match(
    fix,
    /github\.event_name == 'repository_dispatch'[\s\S]*github\.event\.action == 'codekeeper_fix'[\s\S]*github\.actor == inputs\.automation_bot_login/,
  );
  assert.match(fix, /github\.event\.client_payload\.authorization_mode/);
  assert.match(fix, /--review-thread-ids "\$REVIEW_THREAD_IDS"/);
  assert.match(fix, /--authorization-mode "\$AUTHORIZATION_MODE"/);
  assert.doesNotMatch(
    fix,
    /planner_model_api_key|prepare-plan|plan-result|plan-context/,
  );
  assert.doesNotMatch(fix, /\n  command:/);
  const fixCaller = await repositoryFile(
    "examples/workflows/codekeeper-fix.yml.example",
  );
  assert.match(fixCaller, /issues:\n\s+types: \[labeled\]/);
  assert.match(
    fixCaller,
    /permissions:\n\s+contents: read\n\s+issues: read\n\s+pull-requests: read/,
  );
  assert.doesNotMatch(fixCaller, /issue_comment:/);
  assert.match(
    fixCaller,
    /automation_bot_login: \$\{\{ vars\.CODEKEEPER_AUTOMATION_BOT_LOGIN \}\}/,
  );
  const commands = await repositoryFile(
    "tools/codekeeper/src/lib/commands.mjs",
  );
  assert.match(commands, /!pull\.base\?\.ref/);
  assert.doesNotMatch(commands, /pull\.base\?\.ref !== defaultBranch/);
  assert.match(commands, /removeLabel\(number, "codekeeper:paused"\)/);
});

test("owner-commanded pull request repair can update only the frozen existing head", async () => {
  const fix = await workflow("fix");
  const assistant = await workflow("assistant");
  const assistantCaller = await repositoryFile(
    "examples/workflows/codekeeper-assistant.yml.example",
  );
  const publisher = await repositoryFile(
    "tools/codekeeper/src/lib/pr-repair.mjs",
  );
  assert.match(assistant, /owner_requests:/);
  assert.match(assistant, /installed_modes:/);
  assert.match(assistant, /owner-command/);
  const assistantRoute = jobSection(assistant, "route");
  assert.match(
    assistantRoute,
    /Route deterministic owner request[\s\S]*CONFIG: \$\{\{ github\.workspace \}\}\/repository\/\.github\/codekeeper\.json/,
  );
  assert.doesNotMatch(
    assistantRoute,
    /CONFIG: \$\{\{ github\.workspace \}\}\/policy\/\.github\/codekeeper\.json/,
  );
  assert.match(assistant, /--installed-modes "\$INSTALLED_MODES"/);
  assert.match(
    assistantCaller,
    /issue_comment:[\s\S]*pull_request_review_comment:/,
  );
  assert.match(assistantCaller, /intent:\n[\s\S]*route=/);
  assert.doesNotMatch(assistantCaller, /bootstrap:|needs\.bootstrap/);
  assert.match(
    assistantCaller,
    /assistant:\n\s+needs: intent\n\s+if: needs\.intent\.outputs\.route == 'true'/,
  );
  assert.match(assistantCaller, /installed_modes: review,maintain,issues,fix/);
  assert.match(
    assistantCaller,
    /uses: \.\/\.github\/workflows\/codekeeper-runtime-assistant\.yml/,
  );
  assert.doesNotMatch(assistantCaller, /@FULL_COMMIT_SHA|OWNER\/REPOSITORY/);
  assert.doesNotMatch(fix, /\n  command:|github\.event\.comment\.body/);
  assert.doesNotMatch(fix, /!github\.event\.issue\.pull_request/);
  assert.match(
    fix,
    /target_kind: \$\{\{ fromJSON\(steps\.prepare\.outputs\.result\)\.target\.kind \}\}/,
  );
  assert.equal([...fix.matchAll(/Check out frozen repair target/g)].length, 4);
  for (const job of [
    jobSection(fix, "verify", "seal"),
    jobSection(fix, "publish"),
  ]) {
    assert.match(
      job,
      /uses: \.\/policy\/\.github\/codekeeper\/actions\/acquire-package/,
    );
    assert.doesNotMatch(
      job,
      /uses: \.\/repository\/\.github\/codekeeper\/actions\/acquire-package/,
    );
  }
  assert.match(publisher, /createCommitOnCurrentHead/);
  assert.match(publisher, /pushHeadToBranch\(target\.headRef/);
  assert.match(
    publisher,
    /getPull\(target\.number, \{ expectedHeadSha: commitSha \}\)/,
  );
  assert.match(publisher, /resolveReviewThread/);
  assert.match(publisher, /listPullReviewThreads/);
  assert.doesNotMatch(
    publisher,
    /createPull|createBranchAndCommit|pushBranch|enableAutoMerge|updateIssue|deleteBranch/,
  );
});

test("documentation uses the live feedback input and owner-authorized defer contract", async () => {
  const configuration = await repositoryFile("docs/CONFIGURATION.md");
  const install = await repositoryFile("INSTALL.md");
  assert.match(configuration, /`feedback_triage` defaults to `true`/);
  assert.doesNotMatch(configuration, /auto_review_feedback/);
  assert.match(install, /owner-authorized deferral/i);
  assert.doesNotMatch(install, /asks the assistant to verify the claim/i);
});

test("Fixer repository dispatches retain their target and explicit policy authorization", async () => {
  const fix = await workflow("fix");
  const workspace = jobSection(fix, "workspace", "analyze");
  const analyze = jobSection(fix, "analyze", "verify");
  const publisher = await repositoryFile(
    "tools/codekeeper/src/lib/publish.mjs",
  );
  assert.match(
    analyze,
    /EVENT_ISSUE: \$\{\{ github\.event\.issue\.number \|\| github\.event\.client_payload\.number \}\}/,
  );
  assert.match(workspace, /stage compute --operation prepare --mode fix/);
  assert.match(workspace, /stage compute --operation workspace --mode fix/);
  assert.match(workspace, /--mutation-authorized true/);
  assert.match(
    publisher,
    /createRepositoryDispatch\("codekeeper_fix", \{[\s\S]*authorization_mode: "policy"/,
  );
  assert.match(
    publisher,
    /createRepositoryDispatch\("codekeeper_fix", \{[\s\S]*requested_by: automationIdentity\.login/,
  );
  assert.match(
    publisher,
    /Automatic repair dispatch is pending[\s\S]*?createRepositoryDispatch\("codekeeper_fix", \{[\s\S]*?dispatchSucceeded = true;[\s\S]*?Automatic repair was dispatched[\s\S]*?addLabels\(pull\.number, \["codekeeper:auto-repaired"\]\)/,
  );
});

test("Agents SDK coordinators use pinned dependencies and isolated credentials", async () => {
  const packageJson = JSON.parse(
    await repositoryFile("tools/codekeeper/package.json"),
  );
  const packageLock = JSON.parse(
    await repositoryFile("tools/codekeeper/package-lock.json"),
  );
  assert.deepEqual(packageJson.dependencies, {
    "@openai/agents": "0.16.0",
    "@openai/codex": "0.147.0",
    zod: "4.4.3",
  });
  assert.equal(packageLock.lockfileVersion, 3);
  assert.equal(
    packageLock.packages[""].dependencies["@openai/agents"],
    "0.16.0",
  );
  assert.equal(
    packageLock.packages[""].dependencies["@openai/codex"],
    "0.147.0",
  );
  assert.equal(packageLock.packages[""].dependencies.zod, "4.4.3");

  for (const mode of stagedModes) {
    const source = await workflow(mode);
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    const repairMode = mode === "maintain" || mode === "fix";
    const workspace = jobSection(source, "workspace", "analyze");
    const analyze = jobSection(
      source,
      "analyze",
      repairMode ? "verify" : "seal",
    );
    const effectiveMode =
      mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode;
    assert.match(source, /model_api_key:\n[\s\S]*required: true/);
    assert.match(
      source,
      /trace_api_key:\n\s+description:[^\n]*\n\s+required: false/,
    );
    assert.match(workspace, /bin\/install-runtime\.mjs/);
    assert.match(
      workspace,
      new RegExp(`stage compute --operation workspace --mode ${mode}`),
    );
    assert.match(
      workspace,
      /secrets\.workspace_api_key \|\| secrets\.openai_api_key/,
    );
    assert.doesNotMatch(
      workspace,
      /secrets\.(?:model_api_key|trace_api_key|app_private_key)/,
    );
    assert.match(
      workspace,
      /CODEX_HOME: \$\{\{ github\.workspace \}\}\/codekeeper-codex-home/,
    );
    const isolation = await repositoryFile(
      "tools/codekeeper/src/lib/orchestration/workspace-isolation.mjs",
    );
    assert.match(isolation, /include_instructions = false/);
    assert.match(isolation, /bundled = \{ enabled = false \}/);
    assert.match(isolation, /\[shell_environment_policy\]/);
    assert.match(
      isolation,
      /Refusing symlinked \$\{surface\} instruction root/,
    );
    assert.match(isolation, /contaminated = true/);
    assert.match(isolation, /\.agents\/skills.*\.codex\/skills/);
    assert.match(workspace, /stage compute --operation workspace/);
    assert.doesNotMatch(workspace, /prompt-file: .*\/prompt\.md/);
    assert.match(analyze, /bin\/install-runtime\.mjs/);
    assert.match(analyze, /stage compute --operation analyze/);
    assert.match(
      analyze,
      /CODEKEEPER_MODEL_API_KEY: \$\{\{ secrets\.model_api_key \}\}/,
    );
    assert.doesNotMatch(
      analyze,
      /CODEKEEPER_MODEL_API_KEY: \$\{\{ secrets\.model_api_key \|\| secrets\.openai_api_key \}\}/,
    );
    assert.match(
      analyze,
      /CODEKEEPER_TRACE_API_KEY: \$\{\{ secrets\.trace_api_key \}\}/,
    );
    assert.match(analyze, /workspace-result\.json/);
    assert.match(analyze, /agent-result\.json/);
    assert.match(caller, /model_api_key:/);
    assert.match(
      caller,
      /trace_api_key: \$\{\{ secrets\.OPENAI_TRACE_API_KEY \}\}/,
    );
  }

  const selfTest = await workflow("self-test");
  assert.match(selfTest, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(selfTest, /npm run check/);
});

test("review tracing uses the OpenAI exporter without alternate exporter credentials", async () => {
  const source = await workflow("review");
  const caller = await repositoryFile(
    "examples/workflows/codekeeper-review.yml.example",
  );
  const analyze = jobSection(source, "analyze", "gate");

  assert.doesNotMatch(source, /trace_exporter/i);
  assert.doesNotMatch(analyze, /trace_exporter/i);
  assert.match(analyze, /bin\/install-runtime\.mjs/);
  const packagedRuntime = JSON.parse(
    await repositoryFile("packages/codekeeper/runtime-package/package.json"),
  );
  assert.deepEqual(packagedRuntime.dependencies, {
    "@openai/agents": "0.15.0",
    "@openai/codex": "0.147.0",
    zod: "4.4.3",
  });
  assert.match(
    analyze,
    /name: Finalize review with configured Agents SDK model/,
  );
  assert.doesNotMatch(caller, /trace_exporter/i);
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
  assert.doesNotMatch(
    source,
    /\n  plan:|maintenance-planner\.md|--mode plan|plan-result\.json/,
  );
  assert.match(
    jobSection(source, "workspace", "analyze"),
    /fixer\.md[\s\S]*stage compute --operation workspace/,
  );
  assert.match(
    jobSection(source, "analyze", "verify"),
    /fixer\.md[\s\S]*--mode fix/,
  );
});
