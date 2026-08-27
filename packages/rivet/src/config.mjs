export const RIVET_CONFIG_SCHEMA_VERSION = 4;

export const DEFAULT_RIVET_CONFIG = Object.freeze({
  schemaVersion: RIVET_CONFIG_SCHEMA_VERSION,
  review: Object.freeze({
    automatic: true,
    inlineFindings: true,
    requestChanges: false,
    maximumFindings: 8,
  }),
  repair: Object.freeze({ authority: "never" }),
  issues: Object.freeze({ triage: "disabled", implementation: "disabled" }),
  maintenance: Object.freeze({ mode: "disabled" }),
  merge: Object.freeze({ authority: "never" }),
  models: Object.freeze({
    review: Object.freeze({
      engine: "codex",
      model: "gpt-5.6-luna",
      effort: "default",
    }),
  }),
});

function object(value, path, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Rivet config: ${path} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Rivet config: ${path} has unsupported or missing fields`);
  }
}

function boolean(value, path) {
  if (typeof value !== "boolean") {
    throw new Error(`Rivet config: ${path} must be a boolean`);
  }
}

function choice(value, path, choices) {
  if (!choices.includes(value)) {
    throw new Error(
      `Rivet config: ${path} must be one of ${choices.join(", ")}`,
    );
  }
}

function model(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
  ) {
    throw new Error("Rivet config: models.review.model is invalid");
  }
}

export function validateRivetConfig(value) {
  object(value, "root", [
    "schemaVersion",
    "review",
    "repair",
    "issues",
    "maintenance",
    "merge",
    "models",
  ]);
  if (value.schemaVersion !== RIVET_CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `Rivet config: schemaVersion must be ${RIVET_CONFIG_SCHEMA_VERSION}`,
    );
  }

  object(value.review, "review", [
    "automatic",
    "inlineFindings",
    "requestChanges",
    "maximumFindings",
  ]);
  boolean(value.review.automatic, "review.automatic");
  boolean(value.review.inlineFindings, "review.inlineFindings");
  boolean(value.review.requestChanges, "review.requestChanges");
  if (
    !Number.isInteger(value.review.maximumFindings) ||
    value.review.maximumFindings < 1 ||
    value.review.maximumFindings > 20
  ) {
    throw new Error(
      "Rivet config: review.maximumFindings must be an integer from 1 to 20",
    );
  }

  object(value.repair, "repair", ["authority"]);
  choice(value.repair.authority, "repair.authority", ["never", "owner"]);
  object(value.issues, "issues", ["triage", "implementation"]);
  choice(value.issues.triage, "issues.triage", [
    "disabled",
    "automatic",
    "owner",
  ]);
  choice(value.issues.implementation, "issues.implementation", [
    "disabled",
    "owner",
  ]);
  object(value.maintenance, "maintenance", ["mode"]);
  choice(value.maintenance.mode, "maintenance.mode", [
    "disabled",
    "manual",
    "scheduled",
  ]);
  object(value.merge, "merge", ["authority"]);
  choice(value.merge.authority, "merge.authority", ["never"]);

  object(value.models, "models", ["review"]);
  object(value.models.review, "models.review", ["engine", "model", "effort"]);
  choice(value.models.review.engine, "models.review.engine", [
    "codex",
    "claude",
    "copilot",
    "gemini",
  ]);
  model(value.models.review.model);
  choice(value.models.review.effort, "models.review.effort", [
    "default",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  if (value.models.review.effort !== "default") {
    throw new Error(
      "Rivet config: pinned gh-aw review engines require effort default",
    );
  }
  return structuredClone(value);
}

export function reviewWorkflowProjection(value) {
  const config = validateRivetConfig(value);
  if (!config.review.automatic) {
    throw new Error(
      "Rivet config: review-only installation requires automatic review",
    );
  }
  if (
    config.repair.authority !== "never" ||
    config.issues.triage !== "disabled" ||
    config.issues.implementation !== "disabled" ||
    config.maintenance.mode !== "disabled"
  ) {
    throw new Error(
      "Rivet config: review-only installation cannot enable mutation modes",
    );
  }
  return Object.freeze({
    ...config.review,
    ...config.models.review,
  });
}

export function productAuthoritySummary(value) {
  const config = validateRivetConfig(value);
  return Object.freeze([
    config.review.automatic
      ? "Review runs automatically for pull request events."
      : "Review requires an owner action.",
    config.review.inlineFindings
      ? `Review may publish up to ${config.review.maximumFindings} inline findings.`
      : "Review cannot publish inline findings.",
    config.review.requestChanges
      ? "Review may request changes."
      : "Review may comment but cannot request changes.",
    config.repair.authority === "never"
      ? "Repair is disabled."
      : "Repair requires an owner action.",
    `Issue triage is ${config.issues.triage}.`,
    `Issue implementation is ${config.issues.implementation}.`,
    `Maintenance is ${config.maintenance.mode}.`,
    "Merge is impossible.",
  ]);
}
