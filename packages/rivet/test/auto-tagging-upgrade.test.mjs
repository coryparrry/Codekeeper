import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { runCli } from "../src/cli.mjs";
import { installRepair, installReview } from "../src/install.mjs";
import { currentReviewLock } from "./review-lock-fixtures.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WORKFLOW_PATH = ".github/workflows/rivet-review.md";
const LOCK_PATH = ".github/workflows/rivet-review.lock.yml";
const EXTENSION_PATH = ".github/rivet/aw/review-extension.md";
// Frozen from the last general-review installation before auto tagging,
// source commit 83927a86; these fixtures retain conversation-memory support.
const PREVIOUS_FIXTURES = "test/fixtures/pre-auto-tagging";
const PRE_ISOLATION_FIXTURES = "test/fixtures/pre-pending-tag-isolation";

async function compressedFixture(relativePath) {
  return gunzipSync(
    Buffer.from(
      await readFile(path.join(PACKAGE_ROOT, relativePath), "utf8"),
      "base64",
    ),
  ).toString("utf8");
}
async function previousWorkflow(fixtures = PREVIOUS_FIXTURES) {
  return readFile(path.join(PACKAGE_ROOT, fixtures, "rivet-review.md"), "utf8");
}
async function previousLock(fixtures = PREVIOUS_FIXTURES) {
  return compressedFixture(`${fixtures}/rivet-review.lock.yml.gz.b64`);
}
async function fixtureCompiler({ repositoryRoot, workflowId }) {
  const workflow = await readFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.md`),
    "utf8",
  );
  let lock;
  if (workflowId === "rivet-review") {
    lock =
      workflow === (await previousWorkflow())
        ? await previousLock()
        : workflow === (await previousWorkflow(PRE_ISOLATION_FIXTURES))
          ? await previousLock(PRE_ISOLATION_FIXTURES)
          : await currentReviewLock(PACKAGE_ROOT, workflow);
  } else if (workflowId === "rivet-issue-triage") {
    lock = await compressedFixture(
      "test/fixtures/issue-triage/rivet-issue-triage.lock.yml.gz.b64",
    );
  } else {
    assert.equal(workflowId, "rivet-repair");
    lock = "name: rivet-repair-current\n";
  }
  await writeFile(
    path.join(repositoryRoot, `.github/workflows/${workflowId}.lock.yml`),
    lock,
  );
}
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rivet-tagging-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function restorePreviousInstallation(repositoryRoot, fixtures) {
  await writeFile(
    path.join(repositoryRoot, WORKFLOW_PATH),
    await previousWorkflow(fixtures),
  );
  await writeFile(
    path.join(repositoryRoot, LOCK_PATH),
    await previousLock(fixtures),
  );
  await writeFile(
    path.join(repositoryRoot, EXTENSION_PATH),
    await readFile(
      path.join(
        PACKAGE_ROOT,
        "assets/upgrades/pre-pending-tag-isolation/review-extension.md",
      ),
      "utf8",
    ),
  );
}

test("CLI preserves customized configuration during an installation refresh", async (t) => {
  const repositoryRoot = await repository(t);
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.review.maximumFindings = 3;
  const options = {
    repositoryRoot,
    configuration,
    compileWorkflow: fixtureCompiler,
    validateWorkflow: async () => {},
  };
  await installReview(options);
  const result = await runCli(["init", "--review-only", "--dry-run"], {
    cwd: repositoryRoot,
    stdout: { write() {} },
    installReviewImpl: (received) =>
      installReview({
        ...received,
        compileWorkflow: fixtureCompiler,
        validateWorkflow: async () => {},
      }),
  });
  assert.ok(result.files.every(({ status }) => status === "unchanged"));
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
    ),
    configuration,
  );
});

for (const fixtures of [PREVIOUS_FIXTURES, PRE_ISOLATION_FIXTURES]) {
  test(`CLI upgrades ${fixtures} review installation directly to repair`, async (t) => {
    const repositoryRoot = await repository(t);
    const options = {
      repositoryRoot,
      compileWorkflow: fixtureCompiler,
      validateWorkflow: async () => {},
    };
    await installReview(options);
    await restorePreviousInstallation(repositoryRoot, fixtures);
    const runUpgrade = () =>
      runCli(["init", "--repair", "--repository", repositoryRoot], {
        stdout: { write() {} },
        installRepairImpl: (received) =>
          installRepair({
            ...received,
            compileWorkflow: fixtureCompiler,
            validateWorkflow: async () => {},
          }),
      });
    const editedLock = `${await previousLock(fixtures)}\nunexpected: true\n`;
    await writeFile(path.join(repositoryRoot, LOCK_PATH), editedLock);
    await assert.rejects(runUpgrade(), /refusing to overwrite/);
    assert.equal(
      await readFile(path.join(repositoryRoot, LOCK_PATH), "utf8"),
      editedLock,
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
      ).repair.authority,
      "never",
    );
    await writeFile(
      path.join(repositoryRoot, LOCK_PATH),
      await previousLock(fixtures),
    );
    const result = await runUpgrade();
    assert.equal(result.mode, "repair");
    assert.ok(
      result.files.some(
        ({ path: file, status }) =>
          file === ".github/workflows/rivet-repair.md" && status === "create",
      ),
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
      ).repair.authority,
      "owner",
    );
    assert.match(
      await readFile(path.join(repositoryRoot, WORKFLOW_PATH), "utf8"),
      /publish-review-tags:/,
    );
  });
}

for (const fixtures of [PREVIOUS_FIXTURES, PRE_ISOLATION_FIXTURES]) {
  for (const [mode, install] of [
    ["review", installReview],
    ["repair", installRepair],
  ]) {
    test(`upgrades the ${fixtures} ${mode} installation and rejects edited locks`, async (t) => {
      const repositoryRoot = await repository(t);
      const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
      if (mode === "repair") configuration.repair.authority = "owner";
      const options = {
        repositoryRoot,
        configuration,
        compileWorkflow: fixtureCompiler,
        validateWorkflow: async () => {},
      };
      await install(options);
      await restorePreviousInstallation(repositoryRoot, fixtures);
      const configBefore = await readFile(
        path.join(repositoryRoot, ".github/rivet.json"),
        "utf8",
      );

      const editedLock = `${await previousLock(fixtures)}\nunexpected: true\n`;
      await writeFile(path.join(repositoryRoot, LOCK_PATH), editedLock);
      await assert.rejects(install(options), /refusing to overwrite/);
      assert.equal(
        await readFile(path.join(repositoryRoot, LOCK_PATH), "utf8"),
        editedLock,
      );
      assert.equal(
        await readFile(path.join(repositoryRoot, WORKFLOW_PATH), "utf8"),
        await previousWorkflow(fixtures),
      );

      await writeFile(
        path.join(repositoryRoot, LOCK_PATH),
        await previousLock(fixtures),
      );
      const result = await install(options);
      assert.deepEqual(
        result.files
          .filter(({ status }) => status === "update")
          .map(({ path: relativePath }) => relativePath),
        [EXTENSION_PATH, LOCK_PATH, WORKFLOW_PATH],
      );
      const upgraded = await readFile(
        path.join(repositoryRoot, WORKFLOW_PATH),
        "utf8",
      );
      assert.match(upgraded, /review_tags_pending:/);
      assert.match(upgraded, /publish-review-tags:/);
      assert.match(upgraded, /For every complete comparison/);
      assert.equal(
        await readFile(path.join(repositoryRoot, LOCK_PATH), "utf8"),
        await currentReviewLock(PACKAGE_ROOT, upgraded),
      );
      assert.equal(
        await readFile(path.join(repositoryRoot, EXTENSION_PATH), "utf8"),
        await readFile(
          path.join(PACKAGE_ROOT, "assets/review", EXTENSION_PATH),
          "utf8",
        ),
      );
      assert.equal(
        await readFile(path.join(repositoryRoot, ".github/rivet.json"), "utf8"),
        configBefore,
      );
    });
  }
}
