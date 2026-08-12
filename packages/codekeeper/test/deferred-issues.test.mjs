import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createEditableSettings, validateEditableSettings } from "../src/settings.mjs";

const policy = JSON.parse(
  await readFile(new URL("../assets/policies/openai.json", import.meta.url), "utf8")
);
const profiles = {
  review: "review profile",
  audit: "audit profile",
  issue: "issue profile",
  fix: "fix profile"
};

test("deferred issue creation requires the Issue triage workflow", () => {
  const withoutIssues = createEditableSettings({
    policy,
    modes: ["review", "maintain"],
    enabled: true,
    profiles
  });
  withoutIssues.policy.review.createDeferredIssues = true;

  assert.throws(
    () => validateEditableSettings(withoutIssues, policy),
    /Deferred issue creation requires the Issue triage workflow/
  );

  const withIssues = createEditableSettings({
    policy,
    modes: ["review", "maintain", "issues"],
    enabled: true,
    profiles
  });
  withIssues.policy.review.createDeferredIssues = true;

  assert.doesNotThrow(() => validateEditableSettings(withIssues, policy));
});
