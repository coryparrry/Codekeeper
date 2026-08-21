import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { renderAssistantWorkflow } from "../src/assets.mjs";
import { ASSISTANT_WORKFLOW } from "../src/constants.mjs";
import { loadVerifiedAssets, TEST_PACKAGE_RELEASE } from "./helpers.mjs";

const EXPECTED_RUN_NAME = "${{ github.event_name == 'workflow_dispatch' && format('Codekeeper App credential verification {0}', inputs.verification_id) || format('Codekeeper assistant #{0}', github.event.issue.number || github.event.pull_request.number) }}";

test("assistant run-name is one complete quoted YAML scalar", async () => {
  const bundle = await loadVerifiedAssets();
  const assistant = bundle.contents[ASSISTANT_WORKFLOW.asset];
  const runNameLines = assistant.match(/^run-name: .*$/gm) ?? [];
  assert.deepEqual(runNameLines, [`run-name: ${JSON.stringify(EXPECTED_RUN_NAME)}`]);
  assert.equal(JSON.parse(runNameLines[0].slice("run-name: ".length)), EXPECTED_RUN_NAME);
});

test("rendered assistant workflow is a complete YAML document with the full run-name expression", async (t) => {
  const bundle = await loadVerifiedAssets();
  const rendered = renderAssistantWorkflow(bundle.contents[ASSISTANT_WORKFLOW.asset], {
    packageRelease: TEST_PACKAGE_RELEASE,
    ownerRequests: true,
    modes: ["review", "maintain"]
  });
  const rubyValidator = [
    "require 'yaml'",
    "workflow = YAML.safe_load(STDIN.read, aliases: true)",
    "abort unless workflow.is_a?(Hash)",
    "abort unless workflow.key?('name') && workflow.key?('run-name') && workflow.key?('permissions') && workflow.key?('jobs')",
    "on_key = workflow.key?('on') ? 'on' : true",
    "abort unless workflow.key?(on_key)",
    "abort unless workflow.fetch('jobs').is_a?(Hash) && !workflow.fetch('jobs').empty?",
    "abort unless workflow.fetch('run-name') == ARGV.fetch(0)"
  ].join("; ");
  try {
    execFileSync("ruby", ["-e", rubyValidator, EXPECTED_RUN_NAME], {
      input: rendered,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("Ruby/Psych is unavailable for YAML parsing");
      return;
    }
    throw error;
  }
});
