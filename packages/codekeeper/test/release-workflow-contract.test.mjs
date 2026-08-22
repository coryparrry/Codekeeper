import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = new URL("../../../", import.meta.url);
const repositoryFile = (relativePath) =>
  readFile(new URL(relativePath, repositoryRoot), "utf8");

test("release publication is tag-gated, provenance-enabled, and bound to a protected npm environment", async () => {
  const source = await repositoryFile(
    ".github/workflows/codekeeper-release.yml",
  );
  assert.match(source, /push:\n    tags:\n      - "codekeeper-v\*"/);
  assert.match(source, /workflow_dispatch:\n    inputs:\n      tag:/);
  assert.match(source, /permissions:\n  contents: read/);
  assert.match(source, /Confirm public provenance source/);
  assert.match(
    source,
    /visibility="\$\(gh api "repos\/\$GITHUB_REPOSITORY" --jq '\.visibility'\)"/,
  );
  assert.match(source, /test "\$visibility" = "public"/);
  assert.match(source, /environment: npm/);
  assert.match(source, /artifact-metadata: write/);
  assert.match(source, /attestations: write/);
  assert.match(source, /id-token: write/);
  assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN|npm_[a-z-]*token/i);
  assert.match(source, /runs-on: ubuntu-latest/);
  assert.match(
    source,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/,
  );
  assert.match(
    source,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0/,
  );
  assert.match(
    source,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
  );
  assert.match(
    source,
    /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/,
  );
  assert.match(
    source,
    /actions\/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4\.2\.2/,
  );
  assert.match(source, /node-version: 24\.19\.0/);
  assert.match(
    source,
    /npm install --global npm@12\.0\.2 --ignore-scripts --no-audit --no-fund/,
  );
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(
    source,
    /git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main\n          git update-ref refs\/remotes\/origin\/main HEAD/,
  );
  assert.match(source, /npm run check/);
  assert.match(
    source,
    /env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL npm run check/,
  );
  assert.match(source, /working-directory: tools\/codekeeper/);
  assert.match(source, /working-directory: packages\/codekeeper/);
});
test("release workflow only publishes a locally reverified tarball and rechecks the public registry receipt", async () => {
  const source = await repositoryFile(
    ".github/workflows/codekeeper-release.yml",
  );
  const step = (start, end) => {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    assert.notEqual(startIndex, -1, `missing workflow step: ${start}`);
    assert.notEqual(
      endIndex,
      -1,
      `missing workflow step after ${start}: ${end}`,
    );
    return source.slice(startIndex, endIndex);
  };
  const verificationSteps = [
    step(
      "- name: Verify local package receipt",
      "- name: Upload verified release tarball",
    ),
    step(
      "- name: Reverify publish input",
      "- name: Reconfirm remote release tag before registry mutation",
    ),
    step(
      "- name: Re-fetch and verify public registry receipt",
      "- name: Run fresh exact-version install canary",
    ),
  ];
  const receiptSteps = [
    step(
      "- name: Determine npm publication state",
      "- name: Publish exact verified tarball with npm provenance",
    ),
    step(
      "- name: Re-fetch and verify public registry receipt",
      "- name: Run fresh exact-version install canary",
    ),
  ];
  for (const verificationStep of verificationSteps) {
    assert.match(verificationStep, /release", "package-integrity\.json"/);
    assert.match(verificationStep, /flag: "wx"/);
    assert.match(verificationStep, /bin\/verify-package\.mjs/);
    assert.match(verificationStep, /--expected-integrity/);
  }
  assert.match(verificationSteps[0], /CODEKEEPER_PACKAGE_VERIFIED/);
  assert.doesNotMatch(verificationSteps[0], /JSON\.parse\(output\)/);
  for (const receiptStep of receiptSteps) {
    assert.match(
      receiptStep,
      /const isReceiptObject = \(value\) => value !== null && typeof value === "object" && !Array\.isArray\(value\);/,
    );
    assert.match(receiptStep, /if \(Array\.isArray\(value\)\)/);
    assert.match(
      receiptStep,
      /value\.length !== 1 \|\| !isReceiptObject\(value\[0\]\)/,
    );
    assert.match(receiptStep, /return value\[0\];/);
    assert.match(
      receiptStep,
      /if \(!isReceiptObject\(value\)\) throw new Error\("npm registry receipt has an invalid shape"\);/,
    );
    assert.match(
      receiptStep,
      /const receipt = normalizeReceipt\(JSON\.parse\(readFileSync\(process\.env\.RECEIPT, "utf8"\)\)\);/,
    );
  }
  assert.match(
    source,
    /node scripts\/pack-codekeeper-package\.mjs --destination/,
  );
  assert.match(source, /test ! -e "\$RELEASE_ROOT"/);
  assert.match(source, /Upload verified release tarball/);
  assert.match(source, /Download verified release tarball/);
  assert.match(source, /Reverify publish input/);
  assert.match(
    source,
    /--expected-manifest-sha256 "\$EXPECTED_MANIFEST_SHA256"/,
  );
  assert.match(source, /--expected-source-commit "\$EXPECTED_SOURCE_COMMIT"/);
  assert.match(source, /Determine npm publication state/);
  assert.match(
    source,
    /npm view "\$EXPECTED_NAME@\$EXPECTED_VERSION" version dist\.integrity --json > "\$receipt" 2> "\$error_report"/,
  );
  assert.match(source, /receipt\?\.version !== process\.env\.EXPECTED_VERSION/);
  assert.equal(
    source.match(
      /receipt\["dist\.integrity"\] \?\? receipt\?\.dist\?\.integrity/g,
    )?.length,
    2,
    "both registry receipt checks must accept npm 12 flat dist fields",
  );
  assert.match(
    source,
    /receipt\["dist\.tarball"\] \?\? receipt\?\.dist\?\.tarball/,
  );
  assert.match(source, /error\?\.error\?\.code !== "E404"/);
  assert.match(
    source,
    /RECEIPT="\$receipt" node --input-type=module -e '[\s\S]*const error = JSON\.parse\(readFileSync\(process\.env\.RECEIPT/,
  );
  assert.doesNotMatch(
    source,
    /JSON\.parse\(readFileSync\(process\.env\.ERROR_REPORT/,
  );
  assert.match(source, /should_publish=false/);
  assert.match(source, /should_publish=true/);
  assert.match(
    source,
    /if: steps\.publication-state\.outputs\.should_publish == 'true'/,
  );
  assert.match(
    source,
    /npm publish "\$TARBALL" --access public --provenance --ignore-scripts/,
  );
  assert.match(
    source,
    /npm view "\$EXPECTED_NAME@\$EXPECTED_VERSION" version dist\.integrity dist\.tarball --json/,
  );
  assert.match(source, /max_attempts=6/);
  assert.match(source, /retry_delay_seconds=2/);
  assert.match(
    source,
    /for \(\( attempt = 1; attempt <= max_attempts; attempt\+\+ \)\); do/,
  );
  assert.match(source, /sleep "\$retry_delay_seconds"/);
  assert.match(
    source,
    /retry_delay_seconds=\$\(\(retry_delay_seconds \* 2\)\)/,
  );
  assert.match(source, /if \(\( attempt == max_attempts \)\); then/);
  assert.match(source, /npm pack --json --ignore-scripts --pack-destination/);
  const classifiers = [
    ...source.matchAll(
      /require_retryable_missing_release\(\) \{[\s\S]*?\n          \}/g,
    ),
  ].map((match) => match[0]);
  assert.equal(
    classifiers.length,
    2,
    "receipt fetch and install canary must share one missing-release classifier",
  );
  assert.equal(classifiers[0], classifiers[1]);
  const receiptStep = step(
    "- name: Re-fetch and verify public registry receipt",
    "- name: Run fresh exact-version install canary",
  );
  const receiptLoopStart = receiptStep.indexOf(
    "for (( attempt = 1; attempt <= max_attempts; attempt++ )); do",
  );
  const receiptLoopEnd = receiptStep.indexOf(
    "\n          done\n",
    receiptLoopStart,
  );
  assert.notEqual(receiptLoopStart, -1, "public receipt retry loop is required");
  assert.notEqual(receiptLoopEnd, -1, "public receipt retry loop must terminate");
  const receiptLoop = receiptStep.slice(receiptLoopStart, receiptLoopEnd);
  assert.match(
    receiptLoop,
    /npm view "\$EXPECTED_NAME@\$EXPECTED_VERSION" version dist\.integrity dist\.tarball --json/,
  );
  assert.match(
    receiptLoop,
    /npm pack --json --ignore-scripts --pack-destination "\$download"/,
  );
  assert.match(receiptLoop, /rm -rf "\$download"/);
  assert.match(receiptStep, /new Set\(\["E404", "ETARGET"\]\)/);
  assert.match(receiptStep, /No matching version found/);
  assert.doesNotMatch(
    receiptStep.slice(receiptLoopEnd),
    /npm pack --json --ignore-scripts --pack-destination/,
  );
  const canaryStep = step(
    "- name: Run fresh exact-version install canary",
    "- name: Reconfirm remote release tag before GitHub Release mutation",
  );
  const canaryLoopStart = canaryStep.indexOf(
    "for (( attempt = 1; attempt <= max_attempts; attempt++ )); do",
  );
  const canaryLoopEnd = canaryStep.indexOf(
    "\n          done\n",
    canaryLoopStart,
  );
  assert.notEqual(canaryLoopStart, -1, "install canary retry loop is required");
  assert.notEqual(canaryLoopEnd, -1, "install canary retry loop must terminate");
  const canaryLoop = canaryStep.slice(canaryLoopStart, canaryLoopEnd);
  assert.match(
    canaryLoop,
    /npm install --ignore-scripts --no-audit --no-fund "\$EXPECTED_NAME@\$EXPECTED_VERSION"/,
  );
  assert.match(canaryLoop, /rm -rf "\$canary"/);
  assert.match(canaryStep, /new Set\(\["E404", "ETARGET"\]\)/);
  assert.equal(
    source.match(
      /actual_integrity="sha512-\$\(openssl dgst -sha512 -binary "\$(?:tarball|actual_tarball)" \| openssl base64 -A\)"/g,
    )?.length,
    2,
    "both release SRI checks must use unwrapped OpenSSL base64 encoding",
  );
  assert.match(source, /--expected-integrity "\$EXPECTED_INTEGRITY"/);
  assert.match(
    source,
    /NPM_CONFIG_USERCONFIG: \$\{\{ runner\.temp \}\}\/codekeeper-public-npmrc/,
  );
  assert.match(source, /Run fresh exact-version install canary/);
  assert.match(
    source,
    /npm install --ignore-scripts --no-audit --no-fund "\$EXPECTED_NAME@\$EXPECTED_VERSION"/,
  );
  assert.match(source, /\.\/node_modules\/\.bin\/codekeeper --help/);
  assert.match(source, /Finalize immutable-tag GitHub release/);
  assert.match(source, /contents: write/);
  assert.match(source, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(source, /sha512sum "\$TARBALL" > "\$sidecar"/);
  assert.match(
    source,
    /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/,
  );
  assert.match(source, /release\?\.tag_name !== process\.env\.RELEASE_TAG/);
  assert.match(
    source,
    /\[releasePleaseTitle, finalizedTitle\]\.includes\(release\?\.name\)/,
  );
  assert.match(source, /typeof release\?\.body !== "string"/);
  assert.match(source, /release\.body\.length === 0/);
  assert.match(
    source,
    /Codekeeper \$\{version\} is a verified release of the repository-owned AI maintainer that runs in GitHub Actions/,
  );
  assert.match(source, /npx @coryparry\/codekeeper@\$\{version\} init/);
  assert.match(source, /npx @coryparry\/codekeeper@\$\{version\} verify/);
  assert.match(source, /The npm package is published with provenance/);
  assert.match(source, /--notes-file "\$notes"/);
  assert.match(source, /release\?\.draft !== false/);
  assert.match(source, /release\?\.prerelease !== false/);
  assert.match(
    source,
    /grep -Fx 'gh: Not Found \(HTTP 404\)' "\$release_error"/,
  );
  assert.match(source, /gh release create "\$RELEASE_TAG" \\/);
  assert.match(source, /gh release edit "\$RELEASE_TAG" \\/);
  assert.match(
    source,
    /gh release upload "\$RELEASE_TAG" "\$TARBALL" "\$sidecar" \\/,
  );
  assert.match(source, /--clobber/);
  assert.match(
    source,
    /gh release download "\$RELEASE_TAG" --repo "\$GITHUB_REPOSITORY" --pattern "\$tarball_name"/,
  );
  assert.match(
    source,
    /gh release download "\$RELEASE_TAG" --repo "\$GITHUB_REPOSITORY" --pattern "\$sidecar_name"/,
  );
  assert.match(source, /cmp -s "\$TARBALL" "\$download\/\$tarball_name"/);
  assert.match(source, /cmp -s "\$sidecar" "\$download\/\$sidecar_name"/);
  assert.match(source, /--verify-tag/);
  assert.match(source, /needs\.build\.outputs\.tag/);
});

test("missing-release classifier retries E404 and ETARGET diagnostics only", async (t) => {
  const source = await repositoryFile(
    ".github/workflows/codekeeper-release.yml",
  );
  const match = source.match(
    /NPM_STDOUT="\$1" NPM_STDERR="\$2" node --input-type=module -e '\n            ([\s\S]*?)\n            '/,
  );
  assert.ok(match, "missing-release classifier source is required");
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-npm-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stdoutPath = path.join(root, "stdout.txt");
  const stderrPath = path.join(root, "stderr.txt");
  const classify = async (stdout, stderr) => {
    await writeFile(stdoutPath, stdout);
    await writeFile(stderrPath, stderr);
    return spawnSync(
      process.execPath,
      ["--input-type=module", "-e", match[1]],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_STDOUT: stdoutPath,
          NPM_STDERR: stderrPath,
        },
      },
    );
  };

  for (const [stdout, stderr] of [
    ['{"error":{"code":"E404"}}\n', ""],
    ['{"error":{"code":"ETARGET"}}\n', ""],
    ["", "npm error code ETARGET\nnpm error notarget No matching version found for @example/pkg@1.0.0.\n"],
    ["", "npm error notarget No matching version found for @example/pkg@1.0.0.\n"],
  ]) {
    const result = await classify(stdout, stderr);
    assert.equal(result.status, 0, result.stderr);
  }

  const rejected = await classify(
    '{"error":{"code":"E401"}}\n',
    "npm error code E401\n",
  );
  assert.notEqual(rejected.status, 0);
  assert.match(
    rejected.stderr,
    /without a confirmed missing public release/,
  );
});

test("publication requires a credential-free exact-candidate lifecycle gate", async () => {
  const source = await repositoryFile(
    ".github/workflows/codekeeper-release.yml",
  );
  const candidateStart = source.indexOf("  candidate-lifecycle:\n");
  const publishStart = source.indexOf("  publish:\n", candidateStart);
  assert.notEqual(candidateStart, -1, "candidate lifecycle job is required");
  assert.notEqual(publishStart, -1, "publish must follow candidate lifecycle");
  const candidate = source.slice(candidateStart, publishStart);
  const publish = source.slice(publishStart);

  assert.match(candidate, /needs: build/);
  assert.match(candidate, /node-version: 24\.19\.0/);
  assert.match(
    candidate,
    /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.sha \|\| github\.ref \}\}/,
  );
  assert.doesNotMatch(
    candidate,
    /ref: \$\{\{ needs\.build\.outputs\.source_commit \}\}/,
  );
  assert.match(
    candidate,
    /name: codekeeper-release-\$\{\{ needs\.build\.outputs\.version \}\}-\$\{\{ github\.sha \}\}/,
  );
  for (const output of [
    "filename",
    "integrity",
    "manifest_sha256",
    "name",
    "source_commit",
    "version",
  ]) {
    assert.match(candidate, new RegExp(`needs\\.build\\.outputs\\.${output}`));
  }
  assert.match(candidate, /node scripts\/verify-release-candidate\.mjs/);
  assert.match(candidate, /--expected-filename "\$EXPECTED_FILENAME"/);
  assert.match(candidate, /--expected-integrity "\$EXPECTED_INTEGRITY"/);
  assert.match(
    candidate,
    /--expected-manifest-sha256 "\$EXPECTED_MANIFEST_SHA256"/,
  );
  assert.match(
    candidate,
    /--expected-source-commit "\$EXPECTED_SOURCE_COMMIT"/,
  );
  assert.doesNotMatch(candidate, /environment: npm/);
  assert.doesNotMatch(candidate, /id-token:/);
  assert.doesNotMatch(candidate, /^    permissions:/m);
  assert.doesNotMatch(candidate, /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/i);
  assert.match(publish, /needs: \[build, candidate-lifecycle\]/);
  assert.match(publish, /environment: npm/);
});

test("pull-request CI runs the same candidate lifecycle on both supported Node lines", async () => {
  const source = await repositoryFile(
    ".github/workflows/codekeeper-self-test.yml",
  );
  const start = source.indexOf("  installer-checks:\n");
  const end = source.indexOf("  acceptance-harness-checks:\n", start);
  assert.notEqual(start, -1, "installer and release candidate PR job is required");
  assert.notEqual(end, -1, "release candidate PR job must be bounded");
  const candidate = source.slice(start, end);

  assert.match(candidate, /node-version: \[22\.23\.2, 24\.19\.0\]/);
  assert.match(candidate, /node-version: \$\{\{ matrix\.node-version \}\}/);
  assert.match(
    candidate,
    /node scripts\/pack-codekeeper-package\.mjs \\\n+            --candidate \\\n+            --destination "\$CANDIDATE_ROOT" > "\$PACK_REPORT"/,
  );
  assert.match(candidate, /node scripts\/verify-release-candidate\.mjs/);
  assert.match(candidate, /--pack-report "\$PACK_REPORT"/);
  assert.match(candidate, /--tarball-directory "\$CANDIDATE_ROOT"/);
  assert.match(candidate, /--expected-source-commit "\$\(git rev-parse HEAD\)"/);
  assert.doesNotMatch(candidate, /environment: npm/);
  assert.doesNotMatch(candidate, /id-token:/);
  assert.doesNotMatch(candidate, /secrets\.|NPM_TOKEN|NODE_AUTH_TOKEN/i);
});

test("Release Please prepares reviewed Codekeeper releases for the hardened publisher", async () => {
  const [workflow, config, manifest, checks, packageManifest] =
    await Promise.all([
      repositoryFile(".github/workflows/codekeeper-release-please.yml"),
      repositoryFile("release-please-config.json"),
      repositoryFile(".release-please-manifest.json"),
      repositoryFile(".github/workflows/codekeeper-self-test.yml"),
      repositoryFile("packages/codekeeper/package.json"),
    ]);
  assert.match(workflow, /push:\n    branches:\n      - main/);
  assert.match(
    workflow,
    /googleapis\/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5\.0\.0/,
  );
  assert.match(workflow, /token: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.match(workflow, /target-branch: main/);
  const parsedConfig = JSON.parse(config);
  const packageConfig = parsedConfig.packages["packages/codekeeper"];
  assert.equal(packageConfig["release-type"], "node");
  assert.equal(packageConfig.component, "codekeeper");
  assert.equal(packageConfig["tag-separator"], "-");
  assert.equal(packageConfig["changelog-path"], "/CHANGELOG.md");
  assert.deepEqual(JSON.parse(manifest), {
    "packages/codekeeper": JSON.parse(packageManifest).version,
  });
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/,
  );
  assert.match(workflow, /token: \$\{\{ secrets\.RELEASE_PLEASE_TOKEN \}\}/);
  assert.match(
    workflow,
    /release-please--branches--main--components--codekeeper/,
  );
  assert.match(workflow, /scripts\/refresh-release-manifest\.mjs/);
  assert.doesNotMatch(checks, /promotion-policy/);
  assert.doesNotMatch(checks, /staging/);
});

test("product runtime workflows install the prebuilt runtime without npm ci", async () => {
  const runtime = await repositoryFile(".github/workflows/codekeeper-runtime.yml");
  const assistant = await repositoryFile(".github/workflows/codekeeper-assistant.yml");
  const selfTest = await repositoryFile(".github/workflows/codekeeper-self-test.yml");
  assert.match(runtime, /bin\/install-runtime\.mjs/);
  assert.doesNotMatch(runtime, /npm ci/);
  assert.match(
    runtime,
    /execution_sha: context\?\.pullRequest\?\.headSha \?\? context\?\.baseSha \?\? process\.env\.GITHUB_SHA,/,
  );
  assert.doesNotMatch(runtime, /baseSha \\\n/);
  assert.match(assistant, /bin\/install-runtime\.mjs/);
  assert.doesNotMatch(assistant, /npm ci/);
  assert.match(selfTest, /npm ci --ignore-scripts --no-audit --no-fund/);
});
