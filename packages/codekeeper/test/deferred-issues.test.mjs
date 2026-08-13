import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadVerifiedAssets } from "../src/assets.mjs";
import { buildInstallPlan } from "../src/plan.mjs";
import { upgradePolicy } from "../src/policy.mjs";
import { createEditableSettings, validateEditableSettings } from "../src/settings.mjs";
import { HEAD_SHA } from "./helpers.mjs";

const policy = upgradePolicy(JSON.parse(
  await readFile(new URL("../assets/policies/openai.json", import.meta.url), "utf8")
));
const profiles = {
  "pr-reviewer": "review profile",
  "repository-auditor": "audit profile",
  "issue-triager": "issue profile",
  fixer: "fix profile"
};

test("deferred issue creation requires the Issue triage workflow", () => {
  const withoutIssues = createEditableSettings({
    policy,
    modes: ["review", "maintain"],
    enabled: true,
    profiles
  });
  assert.equal(withoutIssues.policy.review.createDeferredIssues, false);
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
  assert.equal(withIssues.policy.review.createDeferredIssues, true);
  assert.doesNotThrow(() => validateEditableSettings(withIssues, policy));
});

test("plain-prompt plans disable deferred issues when Issue triage is not selected", async () => {
  const bundle = await loadVerifiedAssets();
  const plan = buildInstallPlan({
    bundle,
    snapshot: {
      root: "/tmp/widget",
      repository: "acme/widget",
      defaultBranch: "main",
      headSha: HEAD_SHA,
      viewerLogin: "coryparrry"
    },
    answers: {
      modes: ["review", "maintain"],
      preset: "openai",
      displayName: "Widget",
      ownerLogins: ["coryparrry"],
      appClientId: "Iv123456789012345678",
      automationBotLogin: "codekeeper-acme[bot]",
      enabled: true,
      capabilities: []
    }
  });

  assert.equal(plan.policy.review.createDeferredIssues, false);
  assert.equal(plan.files.some((file) => file.path === ".github/workflows/codekeeper-issues.yml"), false);
});
