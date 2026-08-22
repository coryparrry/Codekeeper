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

test("reusable workflows expose typed, validated App permission inputs", async () => {
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
      assert.match(
        source,
        new RegExp(`\\$\\{\\{ inputs\\.${input} \\}\\}`),
        `${mode} passes ${input} to the App token action`,
      );
    }
    assert.match(
      source,
      /stage publish --operation (?:permissions|preconditions)/,
    );
  }
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
  for (const mode of modes) {
    const source = await workflow(mode);
    const publish = jobSection(source, mode === "review" ? "gate" : "publish");
    const validation =
      publish.indexOf("stage publish --operation permissions") >= 0
        ? publish.indexOf("stage publish --operation permissions")
        : publish.indexOf("stage publish --operation preconditions");
    const install = publish.indexOf("- name: Install exact Codekeeper runtime");
    const verification = publish.indexOf(
      mode === "review"
        ? "- name: Seal review artifact without repository execution"
        : "- name: Download sealed",
    );
    const token = publish.indexOf(
      "- name: Create short-lived GitHub App token",
    );
    const publication = publish.indexOf("- name: Publish sealed");
    assert.ok(
      validation !== -1 && install !== -1 && install < validation,
      `${mode} validates permissions through the installed runtime`,
    );
    assert.ok(
      install !== -1 && install < token,
      `${mode} verifies and installs the runtime before minting`,
    );
    assert.ok(
      verification !== -1 && verification < token,
      `${mode} verifies its publication input before minting`,
    );
    if (mode === "review") {
      assert.ok(
        install < verification,
        "review seals the restored candidate with the verified runtime before minting",
      );
    }
    assert.ok(
      token !== -1 && token < publication,
      `${mode} mints only immediately before publication`,
    );
  }
});
