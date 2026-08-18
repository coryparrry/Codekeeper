import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const actionPath = ".github/actions/setup-codekeeper-node/action.yml";

async function repositoryFile(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("repository Node setup is a credential-free pinned composite action", async () => {
  const source = await repositoryFile(actionPath);
  assert.match(source, /using: composite/);
  assert.match(
    source,
    /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
  );
  assert.match(
    source,
    /npm install --global npm@12\.0\.2 --ignore-scripts --no-audit --no-fund/,
  );
  assert.match(source, /node-version must be an exact semantic version/);
  assert.match(source, /install-npm must be true or false/);
  assert.doesNotMatch(
    source,
    /secrets\.|github\.token|GH_TOKEN|permissions:|persist-credentials/,
  );
});

test("repository-owned workflows reuse the composite action after checkout", async () => {
  const expected = new Map([
    [".github/workflows/codekeeper-self-test.yml", 3],
    [".github/workflows/codekeeper-release-readiness.yml", 1],
    [".github/workflows/codekeeper-security.yml", 1],
  ]);
  for (const [file, count] of expected) {
    const source = await repositoryFile(file);
    assert.equal(
      [...source.matchAll(/uses: \.\/\.github\/actions\/setup-codekeeper-node/g)].length,
      count,
      `${file} composite action count`,
    );
    assert.equal(
      [...source.matchAll(/uses: actions\/setup-node@/g)].length,
      0,
      `${file} must not duplicate setup-node`,
    );
    assert.equal(
      [...source.matchAll(/name: Install pinned npm/g)].length,
      0,
      `${file} must not duplicate the pinned npm install`,
    );
    const checkout = source.indexOf("uses: actions/checkout@");
    const setup = source.indexOf("uses: ./.github/actions/setup-codekeeper-node");
    assert.ok(checkout >= 0 && setup > checkout, `${file} checks out before using the local action`);
  }
});

test("release publication keeps its registry-specific setup visible", async () => {
  const source = await repositoryFile(".github/workflows/codekeeper-release.yml");
  assert.match(source, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(source, /uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
});
