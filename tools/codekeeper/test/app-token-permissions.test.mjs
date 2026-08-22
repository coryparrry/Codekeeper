import test from "node:test";
import assert from "node:assert/strict";
import {
  jobSection,
  repositoryFile,
  workflow,
  modes,
} from "./workflow-test-helpers.mjs";

const permissionInputs = [
  "app_contents_permission",
  "app_issues_permission",
  "app_pull_requests_permission",
];

test("compatibility wrappers retain permission inputs without granting callers authority", async () => {
  const generic = await repositoryFile(
    ".github/workflows/codekeeper-runtime.yml",
  );
  for (const mode of modes) {
    const source = await workflow(mode);
    for (const input of permissionInputs) {
      assert.match(
        source,
        new RegExp(
          `${input}:\\n\\s+description:[^\\n]+\\n\\s+required: false\\n\\s+default: (?:read|write)\\n\\s+type: string`,
        ),
        `${mode} declares ${input}`,
      );
      assert.doesNotMatch(
        source,
        new RegExp(`\\$\\{\\{ inputs\\.${input} \\}\\}`),
        `${mode} does not forward ${input} into the generic runtime`,
      );
    }
  }
  assert.match(generic, /CONTENTS_PERMISSION: \$\{\{ needs\.compute\.outputs\.contents_permission \}\}/);
  assert.match(generic, /ISSUES_PERMISSION: \$\{\{ needs\.compute\.outputs\.issues_permission \}\}/);
  assert.match(generic, /PULL_REQUESTS_PERMISSION: \$\{\{ needs\.compute\.outputs\.pull_requests_permission \}\}/);
  assert.match(generic, /stage publish \\\n+            --operation preconditions/);
});

test("reusable workflow defaults preserve each role's minimum authority", async () => {
  const expected = {
    assistant: ["write", "write", "write"],
    review: ["read", "write", "write"],
    maintain: ["read", "write", "read"],
    issues: ["read", "write", "read"],
    fix: ["write", "write", "write"],
  };
  for (const [mode, values] of Object.entries(expected)) {
    const source = await workflow(mode);
    for (const [index, input] of permissionInputs.entries()) {
      assert.match(
        source,
        new RegExp(
          `${input}:\\n(?:\\s+[^\\n]+\\n)*?\\s+default: ${values[index]}\\n`,
        ),
        `${mode} defaults ${input} to ${values[index]}`,
      );
    }
  }
});

test("generated caller assets carry explicit permission placeholders for installer binding", async () => {
  for (const mode of ["assistant", ...modes]) {
    const source = await repositoryFile(
      `examples/workflows/codekeeper-${mode}.yml.example`,
    );
    for (const suffix of ["CONTENTS", "ISSUES", "PULL_REQUESTS"]) {
      assert.match(
        source,
        new RegExp(
          `app_${suffix.toLowerCase()}_permission: \\"APP_${suffix}_PERMISSION\\"`,
        ),
      );
    }
  }
});

test("publication mints the privileged App token only after local verification", async () => {
  const generic = await repositoryFile(
    ".github/workflows/codekeeper-runtime.yml",
  );
  const publish = jobSection(generic, "publish");
  const install = publish.indexOf("- name: Install exact Codekeeper runtime");
  const seal = publish.indexOf("- name: Seal the candidate before App credentials");
  const validation = publish.indexOf(
    "- name: Validate App permissions from the verified mode plan",
  );
  const token = publish.indexOf(
    "- name: Create the short-lived GitHub App token",
  );
  const publication = publish.indexOf("- name: Publish the sealed result");
  assert.ok(install !== -1 && install < seal);
  assert.ok(seal !== -1 && seal < validation);
  assert.ok(validation !== -1 && validation < token);
  assert.ok(token !== -1 && token < publication);
});
