import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { repairAppAuthority } from "../src/app-authority.mjs";
import { renderRivetRepairWorkflow } from "../src/workflows/repair.mjs";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("defines the repair permission increase explicitly", () => {
  assert.deepEqual(repairAppAuthority(), {
    clientIdVariable: "RIVET_APP_CLIENT_ID",
    privateKeySecret: "RIVET_APP_PRIVATE_KEY",
    permissions: {
      contents: "write",
      metadata: "read",
      pullRequests: "write",
    },
    events: [],
  });
});

test("renders an admin-command repair candidate with one bounded push", () => {
  const source = renderRivetRepairWorkflow({
    validation: ["npm test", "npm run check"],
  });
  assert.match(source, /name: rivet-repair/);
  assert.match(source, /events: \[pull_request_comment\]/);
  assert.match(source, /roles: \[admin\]/);
  assert.match(source, /if: github\.event\.comment\.body == '\/rivet-repair'/);
  assert.match(source, /permissions:\n  contents: read\n  pull-requests: read/);
  assert.match(source, /safe-outputs:\n  max-patch-files: 25\n  github-app:/);
  assert.match(source, /report-failure-as-issue: false/);
  assert.match(source, /report-failed-jobs: false/);
  assert.match(source, /report-incomplete:\n    create-issue: false/);
  assert.match(source, /push-to-pull-request-branch:\n    target: triggering/);
  assert.match(source, /fallback-as-pull-request: false/);
  assert.match(source, /protected-files: blocked/);
  assert.match(source, /re-read the live pull request head/);
  assert.match(source, /- `npm test`\n- `npm run check`/);
  assert.doesNotMatch(source, /create-pull-request:|merge-pull-request:/);
});

test("rejects missing or multiline validation commands", () => {
  assert.throws(
    () => renderRivetRepairWorkflow({ validation: [] }),
    /bounded validation commands/,
  );
  assert.throws(
    () => renderRivetRepairWorkflow({ validation: ["npm test\nrm output"] }),
    /bounded validation commands/,
  );
});

test("keeps the compiled repair fixture paired with the renderer", async () => {
  const fixture = await readFile(
    path.join(
      PACKAGE_ROOT,
      "test",
      "fixtures",
      "repair",
      ".github",
      "workflows",
      "rivet-repair.md",
    ),
    "utf8",
  );
  assert.equal(fixture, renderRivetRepairWorkflow());
});
