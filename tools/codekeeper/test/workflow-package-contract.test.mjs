import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  actionPins,
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
    assert.doesNotMatch(caller, /codekeeper-bootstrap|needs\.bootstrap/);
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
  assert.doesNotMatch(reviewCaller, /^  intent:/m);
  assert.doesNotMatch(reviewCaller, /needs\.intent|^\s+runs-on:/m);
  assert.match(
    reviewCaller,
    /review:\n[\s\S]*?if: >-[\s\S]*?uses: \.\/\.github\/workflows\/codekeeper-runtime-review\.yml/,
  );
  assert.match(
    reviewCaller,
    /Deterministic no-op feedback is filtered without allocating a runner/,
  );
  assert.match(reviewCaller, /CODEKEEPER_OWNER_COMMANDS_START/);
  assert.match(reviewCaller, /contains\(fromJSON\('\["\/codekeeper help"/);

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
    assert.equal([...template.matchAll(/"PACKAGE_VERSION"/g)].length, 1);
    assert.equal([...template.matchAll(/"PACKAGE_INTEGRITY"/g)].length, 1);
    assert.doesNotMatch(
      template,
      /PACKAGE_MANIFEST_SHA256|codekeeper-bootstrap|needs\.bootstrap/,
    );
    assert.match(
      template,
      new RegExp(
        `uses: \\.\\/\\.github\\/workflows\\/codekeeper-runtime-${mode}\\.yml`,
      ),
    );
    assert.doesNotMatch(
      template,
      /package_manifest_sha256|package_source_commit/,
    );
    assert.doesNotMatch(
      template,
      /uses:\s+[^.\s][^\n]*codekeeper|@latest|@[~^*]|OWNER\/REPOSITORY|FULL_COMMIT_SHA/,
    );
  }
});

test("reusable workflows acquire one exact package and reverify it in every isolated consumer", async () => {
  const consumerJobs = {
    assistant: ["route"],
    maintain: ["workspace", "analyze", "verify", "seal", "publish"],
    fix: ["workspace", "analyze", "verify", "seal", "publish"],
    issues: ["workspace", "analyze", "seal", "publish"],
  };
  for (const [mode, jobs] of Object.entries(consumerJobs)) {
    const count = jobs.length;
    const source = await workflow(mode);
    assert.equal(
      [...source.matchAll(/name: Acquire exact Codekeeper package/g)].length,
      1,
    );
    assert.equal(
      [...source.matchAll(/name: Install exact Codekeeper runtime/g)].length,
      count,
    );
    assert.equal(
      [...source.matchAll(/name: Check out frozen maintainer tooling/g)].length,
      0,
    );
    const policyAcquisitionCount = mode === "fix" ? 2 : 0;
    assert.equal(
      [
        ...source.matchAll(
          /uses: \.\/repository\/\.github\/codekeeper\/actions\/acquire-package/g,
        ),
      ].length,
      count - policyAcquisitionCount,
    );
    assert.equal(
      [
        ...source.matchAll(
          /uses: \.\/policy\/\.github\/codekeeper\/actions\/acquire-package/g,
        ),
      ].length,
      policyAcquisitionCount,
    );
    if (mode !== "assistant") {
      assert.match(
        source,
        /CODEKEEPER_PACKAGE_VERSION: \$\{\{ inputs\.package_version \}\}/,
      );
      assert.match(
        source,
        /CODEKEEPER_PACKAGE_INTEGRITY: \$\{\{ inputs\.package_integrity \}\}/,
      );
    }
    assert.doesNotMatch(
      source,
      /inputs\.package_(?:manifest_sha256|source_commit)/,
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
    if (mode === "assistant") {
      assert.doesNotMatch(
        source,
        /Upload verified Codekeeper package|Download verified Codekeeper package|Verify downloaded Codekeeper package|codekeeper-tooling-\$\{\{ github\.run_id \}\}/,
      );
    } else {
      assert.equal(
        [...source.matchAll(/name: Upload verified Codekeeper package/g)]
          .length,
        1,
      );
      assert.equal(
        [...source.matchAll(/name: Download verified Codekeeper package/g)]
          .length,
        count - 1,
      );
      assert.equal(
        [...source.matchAll(/name: Verify downloaded Codekeeper package/g)]
          .length,
        count - 1,
      );
      assert.equal(
        [
          ...source.matchAll(
            /name: codekeeper-tooling-\$\{\{ github\.run_id \}\}/g,
          ),
        ].length,
        count,
      );
      assert.match(
        source,
        /package_manifest_sha256: \$\{\{ steps\.codekeeper-package\.outputs\.package_manifest_sha256 \}\}/,
      );
      assert.match(
        source,
        /package_source_commit: \$\{\{ steps\.codekeeper-package\.outputs\.source_commit \}\}/,
      );
      assert.equal(
        [
          ...source.matchAll(
            /expected_manifest_sha256: \$\{\{ needs\.workspace\.outputs\.package_manifest_sha256 \}\}/g,
          ),
        ].length,
        count - 1,
      );
      assert.equal(
        [
          ...source.matchAll(
            /expected_source_commit: \$\{\{ needs\.workspace\.outputs\.package_source_commit \}\}/g,
          ),
        ].length,
        count - 1,
      );
      const workspaceArtifactName = `codekeeper-${mode === "maintain" ? "maintenance" : mode === "issues" ? "issue" : mode}-workspace-\${{ github.run_id }}`;
      const workspaceArtifactNames = [
        ...source.matchAll(
          /^ {10}name: (codekeeper-[^\n]*-workspace-[^\n]+)$/gm,
        ),
      ].map((match) => match[1]);
      assert.deepEqual(
        workspaceArtifactNames,
        [workspaceArtifactName, workspaceArtifactName],
        `${mode} workspace handoff must remain available to failed-job reruns`,
      );
    }
    assert.doesNotMatch(source, /job\.workflow_repository/);
    assert.doesNotMatch(
      source,
      /repository: \$\{\{ job\.workflow_repository \}\}/,
    );
    for (const [index, jobName] of jobs.entries()) {
      const job = jobSection(source, jobName, jobs[index + 1]);
      const actionCheckout =
        mode === "fix" && (jobName === "verify" || jobName === "publish")
          ? "policy"
          : "repository";
      const node = job.indexOf("uses: actions/setup-node@");
      const checkout = job.indexOf("path: repository");
      const install = job.indexOf("name: Install exact Codekeeper runtime");
      assert.ok(checkout >= 0, `${mode}.${jobName} checks out repository`);
      assert.ok(
        node > checkout,
        `${mode}.${jobName} sets up Node after checkout`,
      );
      if (index === 0) {
        const acquire = job.indexOf(
          `uses: ./${actionCheckout}/.github/codekeeper/actions/acquire-package`,
        );
        const upload = job.indexOf("name: Upload verified Codekeeper package");
        assert.ok(
          acquire > node,
          `${mode}.${jobName} acquires after Node setup`,
        );
        if (mode !== "assistant") {
          assert.ok(
            upload > acquire,
            `${mode}.${jobName} uploads only after acquisition`,
          );
          assert.ok(
            install > upload,
            `${mode}.${jobName} installs after upload`,
          );
        } else {
          assert.ok(
            install > acquire,
            `${mode}.${jobName} installs after acquisition`,
          );
        }
      } else {
        const download = job.indexOf(
          "name: Download verified Codekeeper package",
        );
        const verify = job.indexOf(
          "name: Verify downloaded Codekeeper package",
        );
        assert.ok(
          download >= 0,
          `${mode}.${jobName} downloads the run package`,
        );
        assert.ok(
          verify > node,
          `${mode}.${jobName} verifies after Node setup`,
        );
        assert.match(
          job.slice(verify),
          new RegExp(
            `uses: \\.\\/${actionCheckout}\\/\\.github\\/codekeeper\\/actions\\/acquire-package[\\s\\S]*package_source: artifact`,
          ),
        );
        assert.ok(
          install > verify,
          `${mode}.${jobName} installs only after verification`,
        );
        assert.match(job, /needs: \[[^\]]*workspace[^\]]*\]|needs: workspace/);
      }
    }
  }
});

test("review package verification is consolidated across two trusted boundaries", async () => {
  const source = await workflow("review");
  const analyze = jobSection(source, "analyze", "gate");
  const gate = jobSection(source, "gate");

  assert.equal([...source.matchAll(/^\s+runs-on: ubuntu-latest$/gm)].length, 2);
  assert.equal(
    [...source.matchAll(/name: Acquire exact Codekeeper package/g)].length,
    1,
  );
  assert.equal(
    [...source.matchAll(/name: Verify downloaded Codekeeper package/g)].length,
    1,
  );
  assert.equal(
    [...source.matchAll(/name: Install exact Codekeeper runtime/g)].length,
    2,
  );
  assert.equal(
    [
      ...source.matchAll(
        /run: node "\$GITHUB_WORKSPACE\/tooling\/tools\/codekeeper\/bin\/install-runtime\.mjs"/g,
      ),
    ].length,
    2,
  );
  assert.equal(
    [
      ...source.matchAll(
        /uses: \.\/repository\/\.github\/codekeeper\/actions\/acquire-package/g,
      ),
    ].length,
    2,
  );
  assert.equal(
    [...source.matchAll(/uses: actions\/upload-artifact@/g)].length,
    1,
  );
  assert.equal(
    [...source.matchAll(/uses: actions\/download-artifact@/g)].length,
    1,
  );
  assert.equal(
    [
      ...source.matchAll(
        /name: codekeeper-review-publication-\$\{\{ github\.run_id \}\}/g,
      ),
    ].length,
    2,
  );
  assert.doesNotMatch(source, /codekeeper-tooling-\$\{\{ github\.run_id \}\}/);
  assert.match(
    analyze,
    /package_manifest_sha256: \$\{\{ steps\.codekeeper-package\.outputs\.package_manifest_sha256 \}\}/,
  );
  assert.match(
    analyze,
    /package_source_commit: \$\{\{ steps\.codekeeper-package\.outputs\.source_commit \}\}/,
  );
  assert.match(gate, /package_source: artifact/);
  assert.match(
    gate,
    /expected_manifest_sha256: \$\{\{ needs\.analyze\.outputs\.package_manifest_sha256 \}\}/,
  );
  assert.match(
    gate,
    /expected_source_commit: \$\{\{ needs\.analyze\.outputs\.package_source_commit \}\}/,
  );
  assert.match(
    analyze,
    /mv "\$GITHUB_WORKSPACE\/tooling\/tools" "\$HANDOFF\/tooling\/tools"/,
  );
  assert.doesNotMatch(analyze, /mv "\$GITHUB_WORKSPACE\/tooling"/);
});

test("artifact boundaries receive each runner's verified package source identity", async () => {
  for (const mode of modes) {
    const source = await workflow(mode);
    const lines = source.split("\n");
    const commands = lines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          line.includes("stage validate --operation") ||
          line.includes("stage publish --operation publish"),
      );
    assert.ok(commands.length > 0, `${mode} has artifact boundary commands`);
    for (const { line, index } of commands) {
      const block = lines.slice(index, index + 16).join("\n");
      assert.match(
        block,
        /--tooling-sha "\$\{\{ steps\.codekeeper-package\.outputs\.source_commit \}\}"/,
        `${mode} ${line.trim()} binds the independently verified source commit`,
      );
    }
  }
});

test("product workflows require fresh GitHub-hosted Ubuntu runners", async () => {
  for (const mode of ["assistant", "maintain", "fix", "issues", "review"]) {
    const source = await workflow(mode);
    const caller = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    assert.doesNotMatch(source, /inputs\.runner|CODEKEEPER_RUNNER/);
    assert.doesNotMatch(caller, /vars\.CODEKEEPER_RUNNER|CODEKEEPER_RUNNER/);
    assert.doesNotMatch(source, /^\s+runner:\s*$/m);
    assert.doesNotMatch(caller, /^\s+runner:\s+/m);

    const jobRunners = source.match(/^\s+runs-on: .*$/gm) ?? [];
    assert.ok(jobRunners.length > 0);
    assert.ok(
      jobRunners.every((line) => line.trim() === "runs-on: ubuntu-latest"),
    );

    const callerRunners = caller.match(/^\s+runs-on: .*$/gm) ?? [];
    assert.ok(
      callerRunners.every((line) => line.trim() === "runs-on: ubuntu-latest"),
    );
  }
});

test("workspace workflows run pinned Codex through the Agents SDK without runner privilege mutation", async () => {
  const runtimePackage = JSON.parse(
    await repositoryFile("tools/codekeeper/package.json"),
  );
  assert.equal(runtimePackage.dependencies["@openai/codex"], "0.147.0");
  for (const mode of modes.filter((mode) => mode !== "review")) {
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
    assert.match(workspace, /stage compute --operation workspace/);
    assert.match(
      workspace,
      /CODEKEEPER_WORKSPACE_API_KEY: \$\{\{ secrets\.workspace_api_key \|\| secrets\.openai_api_key \}\}/,
    );
    assert.doesNotMatch(workspace, /run-workspace-agent/);
    assert.match(workspace, new RegExp(`--mode ${mode}`));
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

test("review closes its temporary workspace user before coordinator credentials enter the runner", async () => {
  const source = await workflow("review");
  const caller = await repositoryFile(
    "examples/workflows/codekeeper-review.yml.example",
  );
  const analyze = jobSection(source, "analyze", "gate");
  const isolation = await repositoryFile(
    "tools/codekeeper/src/lib/orchestration/workspace-isolation.mjs",
  );

  assert.doesNotMatch(source, /codex_safety_strategy|openai\/codex-action@/);
  assert.doesNotMatch(
    caller,
    /CODEKEEPER_CODEX_SAFETY_STRATEGY|codex_safety_strategy/,
  );
  assert.match(analyze, /stage compute --operation workspace --mode review/);
  assert.match(isolation, /useradd[\s\S]*--system/);
  assert.match(isolation, /["']env["'], \[?"-i"/);
  assert.match(analyze, /CODEKEEPER_WORKSPACE_API_KEY/);
  assert.match(isolation, /pkill.*-TERM/);
  assert.match(isolation, /pkill.*-KILL/);
  assert.match(isolation, /userdel/);
  assert.ok(
    analyze.indexOf("stage compute --operation workspace") <
      analyze.indexOf("Finalize review with configured Agents SDK model"),
  );
  assert.match(analyze, /CODEKEEPER_MODEL_API_KEY/);
  assert.match(analyze, /CODEKEEPER_TRACE_API_KEY/);
  assert.doesNotMatch(source, /blacksmith/i);
  assert.doesNotMatch(caller, /blacksmith/i);
});

test("review grants its isolated user read-only traversal to the installed runtime", async () => {
  const isolate = await repositoryFile(
    "tools/codekeeper/src/lib/orchestration/workspace-isolation.mjs",
  );

  assert.match(isolate, /chmod[\s\S]*a\+x,go-w[\s\S]*workspaceRoot/);
  assert.match(
    isolate,
    /chmod[\s\S]*a\+rX,go-w[\s\S]*repositoryPath[\s\S]*directory[\s\S]*toolingPath/,
  );
  assert.match(
    isolate,
    /chmod[\s\S]*a\+r,go-w[\s\S]*configPath[\s\S]*modePlanPath/,
  );
  assert.match(
    isolate,
    /--user[\s\S]*workspaceUser[\s\S]*test[\s\S]*-r[\s\S]*cliPath/,
  );
});

test("package acquisition validates tarball SRI before deriving package provenance", async () => {
  const source = await repositoryFile(
    ".github/codekeeper/actions/acquire-package/action.yml",
  );
  assert.match(
    source,
    /package_version:[\s\S]*required: true[\s\S]*package_integrity:[\s\S]*required: true/,
  );
  assert.match(
    source,
    /package_source:[\s\S]*default: registry[\s\S]*expected_manifest_sha256:[\s\S]*expected_source_commit:/,
  );
  assert.match(
    source,
    /package_manifest_sha256:\n\s+description:[^\n]+\n\s+value: \$\{\{ steps\.acquire\.outputs\.package_manifest_sha256 \}\}/,
  );
  assert.match(
    source,
    /npm pack --json --ignore-scripts[^\n]+"@coryparry\/codekeeper@\$CODEKEEPER_PACKAGE_VERSION"/,
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
      source.indexOf('tar -tzf "$CODEKEEPER_TARBALL"'),
  );
  assert.match(source, /tar -tzf "\$CODEKEEPER_TARBALL"/);
  assert.match(
    source,
    /types\.some\(\(line\) => !new Set\(\["-", "d"\]\)\.has\(line\[0\]\)\)/,
  );
  assert.match(
    source,
    /tar -xzf "\$CODEKEEPER_TARBALL" --strip-components=1 --no-same-owner --no-same-permissions/,
  );
  assert.doesNotMatch(source, /npm install --prefix "\$install_root"/);
  assert.match(source, /const manifestSha256 = digest\(manifestBytes\)/);
  assert.ok(
    source.indexOf(
      "manifestSha256 !== process.env.CODEKEEPER_EXPECTED_MANIFEST_SHA256",
    ) < source.indexOf('node "$tooling_root/bin/verify-package.mjs"'),
  );
  assert.ok(
    source.indexOf("digest(verifierBytes) !== verifier.sha256") <
      source.indexOf('node "$tooling_root/bin/verify-package.mjs"'),
  );
  assert.match(
    source,
    /printf 'package_manifest_sha256=%s\\nsource_commit=%s\\n'/,
  );
  assert.ok(
    source.indexOf("--expected-source-commit") <
      source.indexOf("printf 'package_manifest_sha256="),
  );
  assert.match(source, /package-integrity\.json/);
  assert.match(source, /https:\/\/github\.com\/coryparrry\/Codekeeper/);
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
  assert.doesNotMatch(
    source,
    /secrets\.|GITHUB_TOKEN|GH_TOKEN|actions\/(?:checkout|upload-artifact|download-artifact)|@latest|OWNER\/REPOSITORY/,
  );
});

test("workflow and caller surfaces contain no deployment-local identity", async () => {
  const workflowFiles = await readdir(workflowDirectory);
  const workflows = await Promise.all(
    workflowFiles
      .filter((name) => name.endsWith(".yml"))
      .map(async (name) => ({
        name,
        source: await repositoryFile(`.github/workflows/${name}`),
      })),
  );
  const callerText = await Promise.all(
    modes.map((mode) =>
      repositoryFile(`examples/workflows/codekeeper-${mode}.yml.example`),
    ),
  );
  const releaseWorkflow = workflows.find(
    ({ name }) => name === "codekeeper-release.yml",
  );
  assert.ok(releaseWorkflow);
  assert.equal(
    releaseWorkflow.source.match(/@coryparry\/codekeeper/g)?.length,
    2,
    "the release workflow may use the exact public npm package identity only for install commands",
  );
  releaseWorkflow.source = releaseWorkflow.source.replaceAll(
    "@coryparry/codekeeper",
    "@PACKAGE_SCOPE/codekeeper",
  );
  for (const source of [
    ...workflows.map((workflow) => workflow.source),
    ...callerText,
  ]) {
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
  assert.equal(runtimePackage.dependencies["@openai/agents"], "0.16.0");
  assert.equal(runtimePackage.dependencies["@openai/codex"], "0.147.0");
});
