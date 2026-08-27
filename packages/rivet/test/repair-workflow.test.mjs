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

test("renders isolated validation before the App-authorized publisher", () => {
  const source = renderRivetRepairWorkflow({
    validation: ["npm test", "npm run check"],
  });
  assert.match(source, /name: rivet-repair/);
  assert.match(source, /events: \[pull_request_comment\]/);
  assert.match(source, /roles: \[admin\]/);
  assert.match(source, /if: github\.event\.comment\.body == '\/rivet-repair'/);
  assert.match(source, /permissions:\n  contents: read\n  pull-requests: read/);
  assert.match(source, /safe-outputs:\n  max-patch-files: 25/);
  assert.match(source, /report-failure-as-issue: false/);
  assert.match(source, /report-failed-jobs: false/);
  assert.match(source, /report-incomplete:\n    create-issue: false/);
  assert.match(source, /jobs:\n    validate-repair:/);
  assert.match(
    source,
    /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
  );
  assert.match(source, /uses: \.\/\.github\/rivet\/actions\/validate-repair/);
  assert.match(source, /needs: validate-repair/);
  assert.match(source, /if: needs\.validate_repair\.result == 'success'/);
  assert.match(source, /uses: \.\/\.github\/rivet\/actions\/publish-repair/);
  assert.match(
    source,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
  );
  assert.match(
    source,
    /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/,
  );
  assert.match(
    source,
    /RIVET_APP_CLIENT_ID: \$\{\{ vars\.RIVET_APP_CLIENT_ID \}\}/,
  );
  assert.match(
    source,
    /RIVET_APP_PRIVATE_KEY: \$\{\{ secrets\.RIVET_APP_PRIVATE_KEY \}\}/,
  );
  assert.match(
    source,
    /RIVET_VALIDATION_COMMANDS_BASE64: WyJucG0gdGVzdCIsIm5wbSBydW4gY2hlY2siXQ==/,
  );
  assert.match(
    source,
    /validates without write credentials on an isolated runner/,
  );
  assert.match(source, /- `npm test`\n- `npm run check`/);
  assert.doesNotMatch(
    source,
    /create-pull-request:|merge-pull-request:|push-to-pull-request-branch:/,
  );
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
