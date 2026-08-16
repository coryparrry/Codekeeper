import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  actionPins,
  bootstrapToolingArtifactName,
  jobSection,
  modes,
  repositoryFile,
  workflow,
  workflowDirectory,
} from "./workflow-test-helpers.mjs";

test("self-test runs for every tracked-file change", async () => {
  const source = await workflow("self-test");
  const triggers = source.slice(0, source.indexOf("\npermissions:"));
  assert.match(triggers, /on:\n  pull_request:\n  push:\n  workflow_dispatch:/);
  assert.doesNotMatch(triggers, /\n\s+paths(?:-ignore)?:/);
  assert.match(
    source,
    /concurrency:\n  group: codekeeper-checks-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}-\$\{\{ github\.event\.pull_request\.head\.ref \|\| github\.ref_name \}\}\n  cancel-in-progress: true/,
  );
});

test("source CI stays generic while repository settings select its runner", async () => {
  const source = await workflow("self-test");
  const runnerLines = source.match(/^\s+runs-on: .*$/gm) ?? [];
  assert.ok(runnerLines.length > 0);
  assert.ok(
    runnerLines.every(
      (line) =>
        line.trim() ===
        "runs-on: ${{ vars.CODEKEEPER_CI_RUNNER || 'ubuntu-latest' }}",
    ),
    "tracked source CI must not contain a concrete organization or third-party runner label",
  );
  const actionlint = await repositoryFile(".github/actionlint.yaml");
  assert.doesNotMatch(
    actionlint,
    /^\s*self-hosted-runner:/m,
    "tracked lint configuration must not register deployment-specific runner labels",
  );
});

test("the standard repository check verifies the complete source-release inventory", async () => {
  const packageJson = JSON.parse(await repositoryFile("package.json"));
  assert.match(
    packageJson.scripts.check,
    /bash scripts\/release-source\.sh --verify/,
  );
});

test("four generic mode workflows expose workflow_call and caller templates remain non-executable", async () => {
  const files = await readdir(workflowDirectory);
  for (const mode of modes) {
    assert.ok(files.includes(`codekeeper-${mode}.yml`));
    const source = await workflow(mode);
    assert.match(source, /on:\n\s+workflow_call:/);
    assert.doesNotMatch(source, /job\.workflow_sha/);

    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    assert.match(
      caller,
      /uses: \.\/\.github\/workflows\/codekeeper-bootstrap\.yml/,
    );
    assert.match(
      caller,
      new RegExp(
        `uses: \\.\\/\\.github\\/workflows\\/codekeeper-runtime-${mode}\\.yml`,
      ),
    );
    assert.doesNotMatch(
      caller,
      /OWNER\/REPOSITORY|FULL_COMMIT_SHA|PACKAGE_MANIFEST_SHA256/,
    );
  }
  const reviewCaller = await repositoryFile(
    "examples/workflows/codekeeper-review.yml.example",
  );
  assert.match(reviewCaller, /on:\n\s+pull_request_target:/);
  assert.match(
    reviewCaller,
    /pull_request_review:\n\s+types: \[submitted, edited, dismissed\]/,
  );
  assert.match(
    reviewCaller,
    /pull_request_review_comment:\n\s+types: \[created, edited, deleted\]/,
  );
  assert.doesNotMatch(reviewCaller, /on:\n\s+pull_request:/);
  assert.match(reviewCaller, /pull-requests: read/);
  assert.match(
    reviewCaller,
    /run-name: "Codekeeper review #\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.client_payload\.number \}\} @\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.client_payload\.head_sha \}\}"/,
  );
  assert.match(
    reviewCaller,
    /const botMention = mentionBot && new RegExp\(`\^@\$\{escapedMention\}\(\?:\\\\s\|\$\)`/,
  );
  assert.match(
    reviewCaller,
    /const mentioned = mentionBot && new RegExp\(`\^@\$\{escapedMention\}\\\\s\+\(\$\{actions\.join\("\|"\)\}\)\$`/,
  );
  assert.match(
    reviewCaller,
    /const route = \(!feedbackEvent \|\| Boolean\(automationBot\)\) && !commandIntent && !automationReply && !botMention/,
  );
  assert.match(
    reviewCaller,
    /REVIEW_AUTHOR: \$\{\{ github\.event\.review\.user\.login \}\}/,
  );
  assert.match(
    reviewCaller,
    /const author = eventName === "pull_request_review" \? reviewAuthor : commentAuthor/,
  );
  assert.match(
    reviewCaller,
    /const automationReply = feedbackEvent && automationBot && author === automationBot/,
  );
  const assistantCaller = await repositoryFile(
    "examples/workflows/codekeeper-assistant.yml.example",
  );
  assert.match(
    assistantCaller,
    /const mentioned = bot && new RegExp\(`\^@\$\{escapedBot\}\\\\s\+\(\$\{actions\.join\("\|"\)\}\)\$`/,
  );
  assert.doesNotMatch(assistantCaller, /body\.includes\(`/);
  const issueCaller = await repositoryFile(
    "examples/workflows/codekeeper-issues.yml.example",
  );
  assert.match(
    issueCaller,
    /run-name: "Codekeeper issue triage #\$\{\{ github\.event\.issue\.number \|\| github\.event\.client_payload\.number \}\}"/,
  );
  assert.match(
    issueCaller,
    /issues:\n\s+types: \[opened, reopened, edited, closed\]/,
  );
  assert.ok(!files.some((name) => name.startsWith("treebar-ai-")));
});

test("callers authorize one exact package and use only adopter-local reusable workflows", async () => {
  for (const mode of ["assistant", ...modes]) {
    const template = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    assert.equal([...template.matchAll(/"PACKAGE_VERSION"/g)].length, 2);
    assert.equal([...template.matchAll(/"PACKAGE_INTEGRITY"/g)].length, 2);
    assert.doesNotMatch(template, /PACKAGE_MANIFEST_SHA256/);
    assert.match(
      template,
      /uses: \.\/\.github\/workflows\/codekeeper-bootstrap\.yml/,
    );
    assert.match(
      template,
      new RegExp(
        `uses: \\.\\/\\.github\\/workflows\\/codekeeper-runtime-${mode}\\.yml`,
      ),
    );
    assert.match(
      template,
      /package_manifest_sha256: \$\{\{ needs\.bootstrap\.outputs\.package_manifest_sha256 \}\}/,
    );
    assert.match(
      template,
      /package_source_commit: \$\{\{ needs\.bootstrap\.outputs\.source_commit \}\}/,
    );
    assert.doesNotMatch(
      template,
      /uses:\s+[^.\s][^\n]*codekeeper|@latest|@[~^*]|OWNER\/REPOSITORY|FULL_COMMIT_SHA/,
    );
    const role = mode === "issues" ? "triage" : mode;
    const bootstrap = jobSection(template, "bootstrap", role);
    assert.match(bootstrap, /permissions:\n\s+contents: read/);
    assert.doesNotMatch(
      bootstrap,
      /secrets:|GITHUB_TOKEN|GH_TOKEN|APP_PRIVATE_KEY/,
    );
  }
});

test("reusable workflows reverify the exact closed package before every consumer", async () => {
  const expectedConsumers = { maintain: 5, fix: 5, issues: 4, review: 4 };
  for (const [mode, count] of Object.entries(expectedConsumers)) {
    const source = await workflow(mode);
    assert.equal(
      [...source.matchAll(/name: Download bootstrap Codekeeper package/g)]
        .length,
      count,
    );
    assert.equal(
      [...source.matchAll(/name: Verify bootstrap Codekeeper package/g)].length,
      count,
    );
    assert.equal(
      [...source.matchAll(/name: Install exact Codekeeper runtime/g)].length,
      count,
    );
    assert.equal(
      [...source.matchAll(/name: Check out frozen maintainer tooling/g)].length,
      0,
    );
    assert.equal(
      [...source.matchAll(/bin\/verify-package\.mjs/g)].length,
      count,
    );
    assert.equal(
      [...source.matchAll(/--expected-name "\$CODEKEEPER_PACKAGE_NAME"/g)]
        .length,
      count,
    );
    assert.equal(
      [...source.matchAll(/--expected-version "\$CODEKEEPER_PACKAGE_VERSION"/g)]
        .length,
      count,
    );
    assert.equal(
      [
        ...source.matchAll(
          /--expected-integrity "\$CODEKEEPER_PACKAGE_INTEGRITY"/g,
        ),
      ].length,
      count,
    );
    assert.equal(
      [
        ...source.matchAll(
          /--expected-manifest-sha256 "\$CODEKEEPER_PACKAGE_MANIFEST_SHA256"/g,
        ),
      ].length,
      count,
    );
    assert.equal(
      [
        ...source.matchAll(
          /--expected-source-commit "\$CODEKEEPER_PACKAGE_SOURCE_COMMIT"/g,
        ),
      ].length,
      count,
    );
    assert.match(
      source,
      /CODEKEEPER_PACKAGE_VERSION: \$\{\{ inputs\.package_version \}\}/,
    );
    assert.match(
      source,
      /CODEKEEPER_PACKAGE_INTEGRITY: \$\{\{ inputs\.package_integrity \}\}/,
    );
    assert.match(
      source,
      /CODEKEEPER_PACKAGE_MANIFEST_SHA256: \$\{\{ inputs\.package_manifest_sha256 \}\}/,
    );
    assert.match(
      source,
      /CODEKEEPER_PACKAGE_SOURCE_COMMIT: \$\{\{ inputs\.package_source_commit \}\}/,
    );
    assert.equal(
      [
        ...source.matchAll(
          /run: node "\$GITHUB_WORKSPACE\/tooling\/tools\/codekeeper\/bin\/install-runtime\.mjs"/g,
        ),
      ].length,
      count,
    );
    assert.doesNotMatch(source, /cp -R .*codekeeper\/runtime|cd "\$runtime"/);
    assert.doesNotMatch(
      source,
      /node (?:\.\.\/)?tooling\/tools\/codekeeper\/runtime/,
    );
    assert.doesNotMatch(
      source,
      /verify-tooling-artifact|CODEKEEPER_TOOLING_MANIFEST|job\.workflow_sha/,
    );
    const bootstrapArtifactNames = [
      ...source.matchAll(/^ {10}name: (codekeeper-tooling-[^\n]+)$/gm),
    ].map((match) => match[1]);
    assert.deepEqual(
      bootstrapArtifactNames,
      Array(count).fill(bootstrapToolingArtifactName),
      `${mode} must consume the caller bootstrap artifact by run ID only so failed-job reruns reuse verified tooling`,
    );
    const workspaceArtifactName = `codekeeper-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}-workspace-\${{ github.run_id }}`;
    const workspaceArtifactNames = [
      ...source.matchAll(/^ {10}name: (codekeeper-[^\n]*-workspace-[^\n]+)$/gm),
    ].map((match) => match[1]);
    assert.deepEqual(
      workspaceArtifactNames,
      [workspaceArtifactName, workspaceArtifactName],
      `${mode} workspace handoff must remain available to failed-job reruns`,
    );
    assert.doesNotMatch(source, /job\.workflow_repository/);
    assert.doesNotMatch(
      source,
      /repository: \$\{\{ job\.workflow_repository \}\}/,
    );
  }
  const assistant = await workflow("assistant");
  assert.equal(
    [...assistant.matchAll(/name: Verify bootstrap Codekeeper package/g)]
      .length,
    1,
  );
  assert.match(assistant, /bin\/verify-package\.mjs/);
  assert.doesNotMatch(
    assistant,
    /job\.workflow_sha|verify-tooling-artifact|CODEKEEPER_TOOLING_MANIFEST/,
  );
});

test("reusable workflows default to GitHub runners and allow a trusted caller override", async () => {
  for (const mode of ["assistant", "maintain", "fix", "issues", "review"]) {
    const source = await workflow(mode);
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    assert.match(
      source,
      /runner:\n\s+description: Runner label used by every job in this reusable workflow\.\n\s+required: false\n\s+default: ubuntu-latest\n\s+type: string/,
    );
    assert.doesNotMatch(source, /^\s+runs-on: ubuntu-latest$/m);
    assert.match(source, /^\s+runs-on: \$\{\{ inputs\.runner \}\}$/m);
    assert.doesNotMatch(caller, /^\s+runs-on: ubuntu-latest$/m);
    assert.match(
      caller,
      /^\s+runner: \$\{\{ vars\.CODEKEEPER_RUNNER \|\| 'ubuntu-latest' \}\}$/m,
    );
  }
});

test("workspace workflows run pinned Codex through the Agents SDK without runner privilege mutation", async () => {
  const runtimePackage = JSON.parse(
    await repositoryFile("tools/codekeeper/package.json"),
  );
  assert.equal(runtimePackage.dependencies["@openai/codex"], "0.146.0");
  for (const mode of modes) {
    const source = await workflow(mode);
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    const workspace = jobSection(source, "workspace", "analyze");

    assert.doesNotMatch(source, /codex_safety_strategy|openai\/codex-action@/);
    assert.doesNotMatch(
      caller,
      /CODEKEEPER_CODEX_SAFETY_STRATEGY|codex_safety_strategy/,
    );
    assert.match(
      workspace,
      /name: Install exact Codekeeper runtime\n\s+run: node "\$GITHUB_WORKSPACE\/tooling\/tools\/codekeeper\/bin\/install-runtime\.mjs"/,
    );
    assert.match(workspace, /name: .*Codex through the Agents SDK/);
    assert.match(
      workspace,
      /CODEKEEPER_WORKSPACE_API_KEY: \$\{\{ secrets\.workspace_api_key \|\| secrets\.openai_api_key \}\}/,
    );
    assert.match(workspace, /run-workspace-agent/);
    assert.match(
      workspace,
      new RegExp(
        `--mode ${mode === "maintain" ? "audit" : mode === "issues" ? "issue" : mode}`,
      ),
    );
    assert.match(workspace, /--result "\$BUNDLE\/workspace-result\.json"/);
    assert.match(
      workspace,
      /BUNDLE: \$\{\{ github\.workspace \}\}\/codekeeper-bundle/,
    );
    assert.match(
      workspace,
      /CODEX_HOME: \$\{\{ github\.workspace \}\}\/codekeeper-codex-home/,
    );
    assert.doesNotMatch(
      workspace,
      /\$\{\{ runner\.temp \}\}\/codekeeper-(?:bundle|codex-home)/,
    );
    assert.doesNotMatch(
      workspace,
      /sudo|useradd|usermod|codex-user|safety-strategy/,
    );
    assert.doesNotMatch(source, /blacksmith/i);
    assert.doesNotMatch(caller, /blacksmith/i);
  }
});

test("bootstrap validates tarball SRI before deriving and publishing package provenance", async () => {
  const source = await workflow("bootstrap");
  assert.match(
    source,
    /package_version:[\s\S]*required: true[\s\S]*package_integrity:[\s\S]*required: true/,
  );
  assert.doesNotMatch(
    source.slice(0, source.indexOf("    outputs:")),
    /package_manifest_sha256:/,
  );
  assert.match(
    source,
    /package_manifest_sha256:\n\s+description:[^\n]+\n\s+value: \$\{\{ jobs\.bootstrap\.outputs\.package_manifest_sha256 \}\}/,
  );
  assert.match(
    source,
    /npm pack --json --ignore-scripts[^\n]+"codekeeper@\$CODEKEEPER_PACKAGE_VERSION"/,
  );
  assert.match(
    source,
    /createHash\("sha512"\)[\s\S]*readFileSync\(tarball\)[\s\S]*digest\("base64"\)/,
  );
  assert.match(
    source,
    /if \(actualIntegrity !== integrity\) throw new Error\("Codekeeper package tarball integrity mismatch"\)/,
  );
  assert.ok(
    source.indexOf("actualIntegrity !== integrity") <
      source.indexOf("Extract verified tarball without installer dependencies"),
  );
  assert.match(source, /tar -tzf "\$CODEKEEPER_TARBALL"/);
  assert.match(source, /types\.some\(\(line\) => !new Set\(\["-", "d"\]\)\.has\(line\[0\]\)\)/);
  assert.match(source, /tar -xzf "\$CODEKEEPER_TARBALL" --strip-components=1 --no-same-owner --no-same-permissions/);
  assert.doesNotMatch(source, /npm install --prefix "\$install_root"/);
  assert.match(source, /const manifestSha256 = digest\(manifestBytes\)/);
  assert.match(source, /package_manifest_sha256=\$\{manifestSha256\}/);
  assert.match(source, /release\/package-integrity\.json/);
  assert.match(
    source,
    /const receipt = \{ version: 1, algorithm: "sha512", integrity: process\.env\.CODEKEEPER_PACKAGE_INTEGRITY \}/,
  );
  for (const argument of [
    "name",
    "version",
    "integrity",
    "manifest-sha256",
    "source-commit",
  ]) {
    assert.match(source, new RegExp(`--expected-${argument}`));
  }
  assert.match(
    source,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
  );
  assert.match(
    source,
    /name: codekeeper-tooling-\$\{\{ github\.run_id \}\}[\s\S]*retention-days: 1[\s\S]*overwrite: true/,
  );
  assert.doesNotMatch(
    source,
    /secrets\.|GITHUB_TOKEN|GH_TOKEN|actions\/checkout|@latest|OWNER\/REPOSITORY/,
  );
});

test("workflow and caller surfaces contain no Treebar or Cory-specific identity", async () => {
  const workflowFiles = await readdir(workflowDirectory);
  const workflowText = await Promise.all(
    workflowFiles
      .filter((name) => name.endsWith(".yml"))
      .map((name) => repositoryFile(`.github/workflows/${name}`)),
  );
  const callerText = await Promise.all(
    modes.map((mode) =>
      repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`),
    ),
  );
  for (const source of [...workflowText, ...callerText]) {
    assert.doesNotMatch(source, /treebar|coryparr?y/i);
  }
});

test("all executable actions are pinned to known immutable commits", async () => {
  const workflowFiles = await readdir(workflowDirectory);
  const executable = await Promise.all(
    workflowFiles
      .filter((name) => name.endsWith(".yml"))
      .map((name) => repositoryFile(`.github/workflows/${name}`)),
  );
  const usesPattern = /^\s*uses:\s*([^\s#]+)@([^\s#]+)(?:\s+#.*)?$/gm;
  for (const source of executable) {
    for (const match of source.matchAll(usesPattern)) {
      const [, action, reference] = match;
      assert.match(
        reference,
        /^[0-9a-f]{40}$/,
        `${action} must use a full commit SHA`,
      );
      assert.equal(
        reference,
        actionPins[action],
        `${action} pin changed without this contract update`,
      );
    }
  }
});

test("all checkouts discard persisted credentials and tool versions are exact", async () => {
  for (const mode of [...modes, "self-test"]) {
    const source = await workflow(mode);
    const checkoutCount = [...source.matchAll(/uses: actions\/checkout@/g)]
      .length;
    const protectedCount = [...source.matchAll(/persist-credentials: false/g)]
      .length;
    assert.equal(
      protectedCount,
      checkoutCount,
      `${mode} leaves a checkout credential persisted`,
    );
    assert.match(source, /node-version: 24\.19\.0/);
  }
  const runtimePackage = JSON.parse(
    await repositoryFile("tools/codekeeper/package.json"),
  );
  assert.equal(runtimePackage.dependencies["@openai/agents"], "0.14.3");
  assert.equal(runtimePackage.dependencies["@openai/codex"], "0.146.0");
});
