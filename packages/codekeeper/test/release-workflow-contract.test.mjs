import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
