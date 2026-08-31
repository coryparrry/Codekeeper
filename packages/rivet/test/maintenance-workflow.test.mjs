import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RIVET_CONFIG } from "../src/config.mjs";
import { renderRivetMaintenanceWorkflow } from "../src/workflows/maintenance.mjs";

test("renders a default-branch, read-only weekly maintenance workflow", () => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  const source = renderRivetMaintenanceWorkflow({ configuration });
  for (const expected of [
    "workflow_dispatch:",
    'cron: "17 3 * * 1"',
    "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    "github.event.inputs.aw_context == ''",
    "ref: ${{ github.sha }}",
    "engine: codex",
    "model: gpt-5.6-luna",
    "imports:\n  - .github/rivet/agents/repository-auditor.md",
    "contents: read",
    "issues: read",
    "pull-requests: read",
    "retention-days: 7",
    "report-incomplete:\n    create-issue: false",
    "uses: ./.github/rivet/actions/validate-audit",
  ]) {
    assert.ok(source.includes(expected), `missing ${expected}`);
  }
  assert.doesNotMatch(source, /private-key|client-id|secrets\./i);
  assert.doesNotMatch(
    source,
    /permission-(?:issues|contents|pull-requests): write|create-issue: true|publish-repair|create-pull-request/i,
  );
});
test("projects the configured review model without widening maintenance authority", () => {
  const configuration = {
    schemaVersion: 4,
    review: {
      automatic: true,
      inlineFindings: true,
      requestChanges: false,
      maximumFindings: 8,
    },
    repair: { authority: "never" },
    issues: { triage: "automatic", implementation: "disabled" },
    maintenance: { mode: "scheduled" },
    merge: { authority: "never" },
    models: {
      review: { engine: "codex", model: "gpt-5.6-luna", effort: "default" },
    },
  };
  const source = renderRivetMaintenanceWorkflow({ configuration });
  assert.match(source, /engine: codex\nmodel: gpt-5\.6-luna/);
  assert.match(source, /safe-outputs:[\s\S]*validate-audit/);

  configuration.maintenance.mode = "manual";
  const manual = renderRivetMaintenanceWorkflow({ configuration });
  assert.match(manual, /workflow_dispatch:/);
  assert.doesNotMatch(manual, /schedule:|cron:/);
});
