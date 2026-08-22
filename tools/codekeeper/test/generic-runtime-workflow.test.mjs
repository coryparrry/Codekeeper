import assert from "node:assert/strict";
import test from "node:test";
import { repositoryFile } from "./workflow-test-helpers.mjs";

function section(source, heading, nextHeading = undefined) {
  const start = source.indexOf(`  ${heading}:\n`);
  assert.notEqual(start, -1, `missing ${heading} job`);
  const next = nextHeading
    ? source.indexOf(`  ${nextHeading}:\n`, start + 1)
    : source.length;
  assert.notEqual(next, -1, `missing ${nextHeading ?? "end"} after ${heading}`);
  return source.slice(start, next);
}

async function workflow() {
  const source = await repositoryFile(
    ".github/workflows/codekeeper-runtime.yml",
  );
  assert.match(source, /^name: Codekeeper runtime\n/);
  assert.match(source, /^on:\n  workflow_call:\n/m);
  return source;
}

test("generic runtime declares the complete reusable workflow interface", async () => {
  const source = await workflow();
  for (const input of [
    "mode",
    "package_version",
    "package_integrity",
    "enabled",
    "dry_run",
    "automation_bot_login",
    "app_client_id",
    "credential_probe",
    "verification_id",
  ]) {
    assert.match(source, new RegExp(`^      ${input}:`, "m"));
  }
  for (const secret of [
    "model_api_key",
    "openai_api_key",
    "deepseek_api_key",
    "openrouter_api_key",
    "workspace_api_key",
    "trace_api_key",
    "app_private_key",
  ]) {
    assert.match(source, new RegExp(`^      ${secret}:`, "m"));
  }
  assert.doesNotMatch(
    source,
    /app_(?:contents|issues|pull_requests)_permission/,
  );
  assert.deepEqual(
    [...source.matchAll(/^  ([a-z-]+):\n/gm)].map((match) => match[1]),
    ["compute", "validate", "publish", "credential-probe"],
  );
});

test("generic runtime keeps validation conditional and publication fail-closed", async () => {
  const source = await workflow();
  const compute = section(source, "compute", "validate");
  const validate = section(source, "validate", "publish");
  const publish = section(source, "publish", "credential-probe");
  assert.match(
    compute,
    /^    if: inputs\.enabled && !inputs\.credential_probe$/m,
  );
  assert.match(validate, /needs: compute/);
  assert.match(
    validate,
    /if: needs\.compute\.outputs\.validation_required == 'true'/,
  );
  assert.match(publish, /needs: \[compute, validate\]/);
  assert.match(publish, /always\(\)/);
  assert.match(publish, /needs\.compute\.outputs\.required_gate == 'true'/);
  assert.match(publish, /Fail closed when review compute did not complete/);
  assert.match(publish, /needs\.compute\.result != 'success'/);
  assert.match(publish, /needs\.compute\.result == 'success'/);
  assert.match(
    publish,
    /needs\.validate\.result == 'success' \|\| needs\.validate\.result == 'skipped'/,
  );
  assert.match(publish, /needs\.compute\.outputs\.required_gate == 'true'/);
  assert.match(
    publish,
    /needs\.compute\.outputs\.publication_required == 'true'/,
  );
  assert.match(publish, /inputs\.dry_run/);
  assert.match(
    publish,
    /name: \$\{\{ \(inputs\.mode == 'review' \|\| needs\.compute\.outputs\.required_gate == 'true'\) && 'Codekeeper review gate'/,
  );
  assert.match(
    publish,
    /if: \(inputs\.mode == 'review' \|\| needs\.compute\.outputs\.required_gate == 'true'\) && needs\.compute\.result != 'success'/,
  );
  assert.match(publish, /name: Enforce the required review gate/);
  assert.match(publish, /PUBLISH_DISPOSITION/);
});

test("every runner acquires and installs the exact package before its stage", async () => {
  const source = await workflow();
  assert.equal(
    [...source.matchAll(/name: Acquire exact Codekeeper package/g)].length,
    4,
  );
  assert.equal(
    [...source.matchAll(/name: Install exact Codekeeper runtime/g)].length,
    3,
  );
  for (const job of ["compute", "validate", "publish"]) {
    const body = section(
      source,
      job,
      job === "compute"
        ? "validate"
        : job === "validate"
          ? "publish"
          : undefined,
    );
    assert.match(body, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(
      body,
      job === "compute"
        ? /uses: \.\/repository\/.github\/codekeeper\/actions\/acquire-package/
        : /uses: \.\/policy\/.github\/codekeeper\/actions\/acquire-package/,
    );
    assert.match(body, /package_version: \$\{\{ inputs\.package_version \}\}/);
    assert.match(
      body,
      /package_integrity: \$\{\{ inputs\.package_integrity \}\}/,
    );
    assert.match(
      body,
      /node "\$GITHUB_WORKSPACE\/tooling\/tools\/codekeeper\/bin\/install-runtime\.mjs"/,
    );
  }
});

test("compute delegates all four mode adapters and transports one run-stable handoff", async () => {
  const source = await workflow();
  const compute = section(source, "compute", "validate");
  for (const mode of ["review", "issues", "maintain", "fix"]) {
    assert.match(compute, new RegExp(`^            ${mode}\\)`, "m"));
  }
  for (const operation of ["prepare", "workspace", "analyze"]) {
    assert.match(compute, new RegExp(`--operation ${operation}`));
  }
  assert.match(compute, /--operation candidate/);
  assert.match(compute, /workspace-result\.json/);
  assert.match(compute, /github\.event\.client_payload\.head_sha/);
  assert.match(
    compute,
    /execution_sha: context\?\.pullRequest\?\.headSha \?\? context\?\.baseSha \?\? process\.env\.GITHUB_SHA,/,
  );
  assert.doesNotMatch(compute, /baseSha \\\n/);
  assert.match(compute, /CODEKEEPER_AUTOMATION_BOT_LOGIN:/);
  assert.match(compute, /CODEKEEPER_APP_CLIENT_ID:/);
  assert.doesNotMatch(compute, /^          AUTOMATION_BOT_LOGIN:/m);
  assert.doesNotMatch(compute, /^          APP_CLIENT_ID:/m);
  assert.match(
    compute,
    /profile_args=\(--agent-profile-source package --agent-profile-source-sha "\$TOOLING_SHA"\)/,
  );
  assert.match(
    compute,
    /--triage-mode "\$TRIAGE_MODE" --target-number "\$TARGET_NUMBER"/,
  );
  assert.match(
    compute,
    /--mutation-authorized true --patch "\$BUNDLE\/workspace\.patch"/,
  );
  assert.match(
    compute,
    /if \[\[ ! -e \"\$BUNDLE\/workspace-result\.json\" \]\]/,
  );
  assert.match(
    compute,
    /name: codekeeper-generic-candidate-\$\{\{ github\.run_id \}\}/,
  );
  assert.match(compute, /retention-days: 1/);
  assert.match(compute, /overwrite: true/);
});

test("validation is credential-free and publication seals before App credentials", async () => {
  const source = await workflow();
  const compute = section(source, "compute", "validate");
  const validate = section(source, "validate", "publish");
  const publish = section(source, "publish", "credential-probe");
  assert.match(compute, /secrets\.model_api_key/);
  assert.match(compute, /secrets\.openai_api_key/);
  assert.match(compute, /secrets\.deepseek_api_key/);
  assert.match(compute, /secrets\.openrouter_api_key/);
  assert.match(compute, /secrets\.workspace_api_key/);
  assert.match(compute, /secrets\.trace_api_key/);
  assert.doesNotMatch(compute, /secrets\.app_private_key/);
  assert.doesNotMatch(
    validate,
    /secrets\.(?:model_api_key|workspace_api_key|trace_api_key|app_private_key)/,
  );
  assert.match(validate, /--operation verify/);
  assert.match(validate, /path: policy/);
  assert.match(validate, /path: repository/);
  assert.match(
    validate,
    /ref: \$\{\{ needs\.compute\.outputs\.execution_sha \}\}/,
  );
  assert.match(
    validate,
    /CONFIG: \$\{\{ github\.workspace \}\}\/policy\/.github\/codekeeper\.json/,
  );
  assert.doesNotMatch(validate, /github\.token|GITHUB_TOKEN/);
  assert.match(publish, /name: Seal the candidate before App credentials/);
  assert.match(publish, /name: Create the short-lived GitHub App token/);
  assert.match(publish, /name: Check out the frozen publication target/);
  assert.match(
    publish,
    /ref: \$\{\{ needs\.compute\.outputs\.execution_sha \}\}/,
  );
  assert.match(
    publish,
    /profile_args=\(--agent-profile-source package --agent-profile-source-sha "\$TOOLING_SHA"\)/,
  );
  assert.match(
    publish,
    /!inputs\.dry_run \|\| inputs\.mode == 'review' \|\| needs\.compute\.outputs\.required_gate == 'true'/,
  );
  assert.ok(
    publish.indexOf("name: Seal the candidate before App credentials") <
      publish.indexOf("name: Create the short-lived GitHub App token"),
  );
  assert.match(publish, /--operation preconditions/);
  assert.match(publish, /--operation bot/);
  assert.match(publish, /--operation publish/);
  assert.match(
    publish,
    /permission-contents: \$\{\{ needs\.compute\.outputs\.contents_permission \}\}/,
  );
  assert.match(
    publish,
    /permission-issues: \$\{\{ needs\.compute\.outputs\.issues_permission \}\}/,
  );
  assert.match(
    publish,
    /permission-pull-requests: \$\{\{ needs\.compute\.outputs\.pull_requests_permission \}\}/,
  );
  assert.doesNotMatch(
    publish,
    /secrets\.(?:model_api_key|workspace_api_key|trace_api_key)/,
  );
});

test("credential proof uses the verified package and App key without a model or repository mutation", async () => {
  const source = await workflow();
  const probe = section(source, "credential-probe");
  assert.match(probe, /^    name: Codekeeper App credential verification$/m);
  assert.match(probe, /^    if: inputs\.enabled && inputs\.credential_probe$/m);
  assert.match(probe, /name: Acquire exact Codekeeper package/);
  assert.match(probe, /registrationAppPermissions/);
  assert.match(probe, /secrets\.app_private_key/);
  assert.match(probe, /actions\/create-github-app-token@[0-9a-f]{40}/);
  assert.match(
    probe,
    /Prove App identity, installation, and repository access/,
  );
  assert.doesNotMatch(probe, /model_api_key|workspace_api_key|trace_api_key/);
  assert.doesNotMatch(
    probe,
    /stage (?:compute|validate|publish)|git push|gh pr|gh issue/,
  );
});

test("auto owner commands resolve once and preserve deterministic credential boundaries", async () => {
  const source = await workflow();
  const compute = section(source, "compute", "validate");
  const validate = section(source, "validate", "publish");
  const publish = section(source, "publish");
  assert.match(compute, /--operation owner-command-context/);
  assert.match(
    compute,
    /owner_context_args=\(--command-context "\$COMMAND_CONTEXT"\)/,
  );
  assert.doesNotMatch(compute, /--owner-command-context/);
  assert.match(compute, /--mode "\$REQUESTED_MODE"/);
  assert.match(compute, /--command "\$command" --surface "\$surface"/);
  assert.match(compute, /resolved_mode: plan\.resolvedMode/);
  assert.match(compute, /command_execution_kind:/);
  assert.match(compute, /--operation command-candidate/);
  assert.match(compute, /MODEL_PROVIDER/);
  assert.match(compute, /unset LEGACY_MODEL_API_KEY OPENAI_MODEL_API_KEY/);
  assert.doesNotMatch(
    validate,
    /secrets\.(?:openai|deepseek|openrouter)_api_key/,
  );
  assert.match(publish, /operation=command-seal/);
  assert.match(publish, /--operation command/);
  assert.ok(
    publish.indexOf("operation=command-seal") <
      publish.indexOf("name: Create the short-lived GitHub App token"),
  );
  assert.doesNotMatch(publish, /repository_dispatch/);
});
