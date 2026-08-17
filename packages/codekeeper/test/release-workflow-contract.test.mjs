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
    /actions\/attest-build-provenance@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4/,
  );
  assert.match(source, /node-version: 24\.19\.0/);
  assert.match(
    source,
    /npm install --global npm@12\.0\.2 --ignore-scripts --no-audit --no-fund/,
  );
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(source, /npm run check/);
  assert.match(source, /working-directory: tools\/codekeeper/);
  assert.match(source, /working-directory: packages\/codekeeper/);
});
test("release workflow only publishes a locally reverified tarball and rechecks the public registry receipt", async () => {
  const source = await repositoryFile(
    ".github/workflows/codekeeper-release.yml",
  );
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
    /npm view "codekeeper@\$EXPECTED_VERSION" version dist\.integrity --json > "\$receipt" 2> "\$error_report"/,
  );
  assert.match(source, /receipt\?\.version !== process\.env\.EXPECTED_VERSION/);
  assert.match(
    source,
    /receipt\?\.dist\?\.integrity !== process\.env\.EXPECTED_INTEGRITY/,
  );
  assert.match(source, /error\?\.error\?\.code !== "E404"/);
  assert.match(
    source,
    /RECEIPT="\$receipt" node --input-type=module -e '[\s\S]*const error = JSON\.parse\(readFileSync\(process\.env\.RECEIPT/,
  );
  assert.doesNotMatch(source, /JSON\.parse\(readFileSync\(process\.env\.ERROR_REPORT/);
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
    /npm view "codekeeper@\$EXPECTED_VERSION" version dist\.integrity dist\.tarball --json/,
  );
  assert.match(source, /npm pack --json --ignore-scripts --pack-destination/);
  assert.match(source, /--expected-integrity "\$EXPECTED_INTEGRITY"/);
  assert.match(
    source,
    /NPM_CONFIG_USERCONFIG: \$\{\{ runner\.temp \}\}\/codekeeper-public-npmrc/,
  );
  assert.match(source, /Run fresh exact-version install canary/);
  assert.match(
    source,
    /npm install --ignore-scripts --no-audit --no-fund "codekeeper@\$EXPECTED_VERSION"/,
  );
  assert.match(source, /\.\/node_modules\/\.bin\/codekeeper --help/);
  assert.match(source, /Create immutable-tag GitHub release/);
  assert.match(source, /contents: write/);
  assert.match(source, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(source, /sha512sum "\$TARBALL" > "\$sidecar"/);
  assert.match(
    source,
    /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$RELEASE_TAG"/,
  );
  assert.match(source, /release\?\.tag_name !== process\.env\.RELEASE_TAG/);
  assert.match(source, /release\?\.name !== expectedTitle/);
  assert.match(source, /release\?\.body !== expectedBody/);
  assert.match(source, /release\?\.draft !== false/);
  assert.match(source, /release\?\.prerelease !== false/);
  assert.match(
    source,
    /grep -Fx 'gh: Not Found \(HTTP 404\)' "\$release_error"/,
  );
  assert.match(source, /gh release create "\$RELEASE_TAG" \\/);
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
