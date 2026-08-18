import assert from "node:assert/strict";
import test from "node:test";
import {
  reconciliationPlan,
  rulesetPayload,
  validateGovernancePolicy,
} from "./repository-governance.mjs";

function policy() {
  return {
    version: 1,
    repository: "owner/repository",
    activation: {
      automatic: false,
      reason: "Apply only after review.",
    },
    rulesets: [
      {
        name: "main",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: {
            include: ["refs/heads/main"],
            exclude: [],
          },
        },
        rules: [
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 0,
            },
          },
        ],
      },
      {
        name: "tags",
        target: "tag",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: {
            include: ["refs/tags/codekeeper-v*"],
            exclude: [],
          },
        },
        rules: [{ type: "update" }],
      },
    ],
  };
}

test("governance requires explicit non-automatic branch and tag rules", () => {
  assert.equal(validateGovernancePolicy(policy()).rulesets.length, 2);

  const automatic = policy();
  automatic.activation.automatic = true;
  assert.throws(() => validateGovernancePolicy(automatic), /automatic activation must remain false/);

  const bypass = policy();
  bypass.rulesets[0].bypass_actors.push({
    actor_type: "RepositoryRole",
    actor_id: 5,
    bypass_mode: "always",
  });
  assert.throws(() => validateGovernancePolicy(bypass), /bypass_actors must remain empty/);
});

test("reconciliation creates, updates, and preserves matching rulesets", () => {
  const desired = policy().rulesets;
  const changed = structuredClone(desired[0]);
  changed.id = 10;
  changed.rules = [{ type: "deletion" }];
  const matching = { id: 11, ...structuredClone(desired[1]) };

  assert.deepEqual(
    reconciliationPlan(desired, [changed, matching]).map((item) => item.action),
    ["update", "unchanged"],
  );
  assert.deepEqual(
    reconciliationPlan(desired, []).map((item) => item.action),
    ["create", "create"],
  );
});

test("reconciliation ignores GitHub default fields and key order", () => {
  const desired = policy().rulesets;
  const githubMain = {
    id: 21006876,
    name: "main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        exclude: [],
        include: ["refs/heads/main"],
      },
    },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          required_reviewers: [],
          allowed_merge_methods: ["merge", "squash", "rebase"],
        },
      },
    ],
    current_user_can_bypass: "never",
  };
  const githubTags = {
    id: 21006878,
    name: "tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        exclude: [],
        include: ["refs/tags/codekeeper-v*"],
      },
    },
    rules: [{ type: "update" }],
  };

  assert.deepEqual(
    reconciliationPlan(desired, [githubTags, githubMain]).map((item) => item.action),
    ["unchanged", "unchanged"],
  );
});

test("API payloads contain only the reviewed ruleset contract", () => {
  const source = policy().rulesets[0];
  const payload = rulesetPayload(source);
  assert.deepEqual(payload, source);
  payload.name = "changed";
  assert.equal(source.name, "main");
});
