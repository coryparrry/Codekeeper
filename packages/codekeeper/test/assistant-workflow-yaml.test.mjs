import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { renderUnifiedWorkflow } from "../src/assets.mjs";
import { UNIFIED_CALLER_WORKFLOW } from "../src/constants.mjs";
import { loadVerifiedAssets, TEST_PACKAGE_RELEASE } from "./helpers.mjs";

const EXPECTED_RUN_NAME = "${{ inputs.verify_app_credentials && format('Codekeeper App credential verification {0}', inputs.verification_id) || (github.event_name == 'workflow_dispatch' && inputs.issue_number != '' && format('Codekeeper manual fix #{0}', inputs.issue_number) || (github.event_name == 'workflow_dispatch' && format('Codekeeper maintenance verification {0}', inputs.verification_id || github.run_id) || format('Codekeeper {0} #{1}', github.event_name, github.event.pull_request.number || github.event.issue.number || github.event.client_payload.number || github.run_number))) }}";

test("unified caller run-name is one complete quoted YAML scalar", async () => {
  const bundle = await loadVerifiedAssets();
  const caller = bundle.contents[UNIFIED_CALLER_WORKFLOW.asset];
  const runNameLines = caller.match(/^run-name: .*$/gm) ?? [];
  assert.deepEqual(runNameLines, [`run-name: ${JSON.stringify(EXPECTED_RUN_NAME)}`]);
  assert.equal(JSON.parse(runNameLines[0].slice("run-name: ".length)), EXPECTED_RUN_NAME);
});

test("rendered unified caller is a complete YAML document with five static runtime jobs", async (t) => {
  const bundle = await loadVerifiedAssets();
  const rendered = renderUnifiedWorkflow(bundle.contents[UNIFIED_CALLER_WORKFLOW.asset], {
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
    "abort unless workflow.fetch('jobs').is_a?(Hash) && workflow.fetch('jobs').keys == %w[review issue fix maintain command]",
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
