import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RIVET_CONFIG,
  issueTriageWorkflowProjection,
  maintenanceWorkflowProjection,
  productAuthoritySummary,
  reviewWorkflowProjection,
  validateRivetConfig,
} from "../src/config.mjs";

test("validates the closed Rivet schema v4 default", () => {
  const config = validateRivetConfig(DEFAULT_RIVET_CONFIG);
  assert.equal(config.schemaVersion, 4);
  assert.deepEqual(config.review, {
    automatic: true,
    inlineFindings: true,
    requestChanges: false,
    maximumFindings: 8,
  });
  assert.equal(config.repair.authority, "never");
  assert.equal(config.merge.authority, "never");
});

test("rejects unknown fields and malformed review controls", () => {
  const unknown = structuredClone(DEFAULT_RIVET_CONFIG);
  unknown.execution = { retries: 3 };
  assert.throws(
    () => validateRivetConfig(unknown),
    /unsupported or missing fields/,
  );

  for (const maximumFindings of [0, 21, 1.5]) {
    const config = structuredClone(DEFAULT_RIVET_CONFIG);
    config.review.maximumFindings = maximumFindings;
    assert.throws(() => validateRivetConfig(config), /integer from 1 to 20/);
  }

  const injectedModel = structuredClone(DEFAULT_RIVET_CONFIG);
  injectedModel.models.review.model = "model\npermissions: write-all";
  assert.throws(() => validateRivetConfig(injectedModel), /model is invalid/);
});

test("maps the supported review engine matrix without provider emulation", () => {
  for (const engine of ["codex", "claude", "copilot", "gemini"]) {
    const config = structuredClone(DEFAULT_RIVET_CONFIG);
    config.models.review.engine = engine;
    config.models.review.model = `${engine}-review-model`;
    const projection = reviewWorkflowProjection(config);
    assert.equal(projection.engine, engine);
    assert.equal(projection.model, `${engine}-review-model`);
  }

  const unsupportedEffort = structuredClone(DEFAULT_RIVET_CONFIG);
  unsupportedEffort.models.review.effort = "high";
  assert.throws(
    () => reviewWorkflowProjection(unsupportedEffort),
    /pinned gh-aw review engines require effort default/,
  );
});

test("fails closed when review-only installation gains mutation authority", () => {
  const config = structuredClone(DEFAULT_RIVET_CONFIG);
  config.repair.authority = "owner";
  assert.throws(
    () => reviewWorkflowProjection(config),
    /cannot enable unsupported mutation modes/,
  );

  const ownerTriage = structuredClone(DEFAULT_RIVET_CONFIG);
  ownerTriage.issues.triage = "owner";
  assert.throws(
    () => reviewWorkflowProjection(ownerTriage),
    /cannot enable unsupported mutation modes/,
  );
});

test("allows automatic issue triage but never implementation", () => {
  const projection = reviewWorkflowProjection(DEFAULT_RIVET_CONFIG);
  assert.equal(projection.issueTriage, true);

  const disabled = structuredClone(DEFAULT_RIVET_CONFIG);
  disabled.issues.triage = "disabled";
  assert.equal(reviewWorkflowProjection(disabled).issueTriage, false);

  const implementation = structuredClone(DEFAULT_RIVET_CONFIG);
  implementation.issues.implementation = "owner";
  assert.throws(
    () => reviewWorkflowProjection(implementation),
    /cannot enable unsupported mutation modes/,
  );
});

test("projects enabled report-only maintenance with the configured model", () => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "scheduled";
  assert.deepEqual(maintenanceWorkflowProjection(configuration), {
    mode: "scheduled",
    engine: "codex",
    model: "gpt-5.6-luna",
    effort: "default",
  });

  assert.throws(
    () => maintenanceWorkflowProjection(DEFAULT_RIVET_CONFIG),
    /requires manual or scheduled mode/,
  );
});

test("allows report-only maintenance alongside review and issue triage", () => {
  const configuration = structuredClone(DEFAULT_RIVET_CONFIG);
  configuration.maintenance.mode = "manual";
  assert.equal(reviewWorkflowProjection(configuration).issueTriage, true);
  assert.equal(
    issueTriageWorkflowProjection(configuration).model,
    "gpt-5.6-luna",
  );
});

test("projects only automatic incoming issue triage", () => {
  assert.deepEqual(issueTriageWorkflowProjection(DEFAULT_RIVET_CONFIG), {
    engine: "codex",
    model: "gpt-5.6-luna",
    effort: "default",
  });

  const disabled = structuredClone(DEFAULT_RIVET_CONFIG);
  disabled.issues.triage = "disabled";
  assert.throws(
    () => issueTriageWorkflowProjection(disabled),
    /requires automatic triage/,
  );

  const implementation = structuredClone(DEFAULT_RIVET_CONFIG);
  implementation.issues.implementation = "owner";
  assert.throws(
    () => issueTriageWorkflowProjection(implementation),
    /cannot enable issue implementation/,
  );
});

test("summarizes product authority before workflow compilation", () => {
  assert.deepEqual(productAuthoritySummary(DEFAULT_RIVET_CONFIG), [
    "Review runs automatically for pull request events.",
    "Review may publish up to 8 inline findings.",
    "Review may comment but cannot request changes.",
    "Repair is disabled.",
    "Issue triage is automatic.",
    "Issue implementation is disabled.",
    "Maintenance is disabled.",
    "Merge is impossible.",
  ]);
});
