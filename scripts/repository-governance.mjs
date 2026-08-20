#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const POLICY_PATH = path.join(
  REPOSITORY_ROOT,
  ".github",
  "repository-rules.json",
);
const MODES = new Set(["--validate", "--check-remote", "--apply"]);

function fail(message) {
  throw new Error(`Repository governance: ${message}`);
}

function exactObject(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${name} contains unexpected fields`);
  }
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim())
    fail(`${name} must be a non-empty string`);
  return value;
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${name} must be an array of strings`);
  }
  if (new Set(value).size !== value.length)
    fail(`${name} must not contain duplicates`);
  return value;
}

function validateRule(rule, name) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule))
    fail(`${name} must be an object`);
  nonEmptyString(rule.type, `${name}.type`);
  const allowed =
    rule.parameters === undefined ? ["type"] : ["type", "parameters"];
  exactObject(rule, name, allowed);
  if (
    rule.parameters !== undefined &&
    (!rule.parameters ||
      typeof rule.parameters !== "object" ||
      Array.isArray(rule.parameters))
  ) {
    fail(`${name}.parameters must be an object`);
  }
  return rule;
}

export function validateGovernancePolicy(input) {
  exactObject(input, "policy", [
    "version",
    "repository",
    "activation",
    "rulesets",
  ]);
  if (input.version !== 1) fail("policy version must be 1");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    fail("repository must be owner/name");
  }
  exactObject(input.activation, "activation", ["automatic", "reason"]);
  if (input.activation.automatic !== false)
    fail("automatic activation must remain false");
  nonEmptyString(input.activation.reason, "activation.reason");
  if (!Array.isArray(input.rulesets) || input.rulesets.length !== 2) {
    fail("policy must define exactly one branch and one tag ruleset");
  }

  const names = new Set();
  const targets = new Set();
  for (const [index, ruleset] of input.rulesets.entries()) {
    const name = `rulesets[${index}]`;
    exactObject(ruleset, name, [
      "name",
      "target",
      "enforcement",
      "bypass_actors",
      "conditions",
      "rules",
    ]);
    nonEmptyString(ruleset.name, `${name}.name`);
    if (names.has(ruleset.name)) fail("ruleset names must be unique");
    names.add(ruleset.name);
    if (!["branch", "tag"].includes(ruleset.target))
      fail(`${name}.target is unsupported`);
    targets.add(ruleset.target);
    if (ruleset.enforcement !== "active")
      fail(`${name}.enforcement must be active`);
    if (
      !Array.isArray(ruleset.bypass_actors) ||
      ruleset.bypass_actors.length !== 0
    ) {
      fail(`${name}.bypass_actors must remain empty`);
    }
    exactObject(ruleset.conditions, `${name}.conditions`, ["ref_name"]);
    exactObject(ruleset.conditions.ref_name, `${name}.conditions.ref_name`, [
      "include",
      "exclude",
    ]);
    stringArray(
      ruleset.conditions.ref_name.include,
      `${name}.conditions.ref_name.include`,
    );
    stringArray(
      ruleset.conditions.ref_name.exclude,
      `${name}.conditions.ref_name.exclude`,
    );
    if (!Array.isArray(ruleset.rules) || ruleset.rules.length === 0)
      fail(`${name}.rules must not be empty`);
    ruleset.rules.forEach((rule, ruleIndex) =>
      validateRule(rule, `${name}.rules[${ruleIndex}]`),
    );
  }
  if (!targets.has("branch") || !targets.has("tag"))
    fail("branch and tag rulesets are both required");
  const branchRuleset = input.rulesets.find(
    (ruleset) => ruleset.target === "branch",
  );
  const protectedBranches = branchRuleset.conditions.ref_name.include;
  for (const requiredBranch of ["refs/heads/main", "refs/heads/staging"]) {
    if (!protectedBranches.includes(requiredBranch)) {
      fail(`branch ruleset must protect ${requiredBranch}`);
    }
  }
  const pullRequestRule = branchRuleset.rules.find(
    (rule) => rule.type === "pull_request",
  );
  if (!pullRequestRule) fail("branch ruleset must require pull requests");
  if (!pullRequestRule.parameters)
    fail("branch pull request rule must define parameters");
  if (pullRequestRule.parameters.required_approving_review_count < 1) {
    fail("branch pull requests must require at least one approval");
  }
  if (pullRequestRule.parameters.dismiss_stale_reviews_on_push !== true) {
    fail("branch pull requests must dismiss stale approvals");
  }
  const statusRule = branchRuleset.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  const requiredChecks = statusRule?.parameters?.required_status_checks ?? [];
  if (!requiredChecks.some((check) => check.context === "promotion-policy")) {
    fail("branch ruleset must require the promotion-policy check");
  }
  return input;
}

export function rulesetPayload(ruleset) {
  return structuredClone(ruleset);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortedValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedValue(value[key])]),
  );
}

function projectOnto(desired, current) {
  if (desired === null || typeof desired !== "object") return current;
  if (Array.isArray(desired)) {
    if (!Array.isArray(current)) return current;
    if (
      desired.every(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof item.type === "string",
      )
    ) {
      const remaining = [...current];
      const projected = desired.map((desiredItem) => {
        const index = remaining.findIndex(
          (item) => item && item.type === desiredItem.type,
        );
        if (index === -1) return { type: `\0missing:${desiredItem.type}` };
        const [currentItem] = remaining.splice(index, 1);
        return projectOnto(desiredItem, currentItem);
      });
      return remaining.length === 0 ? projected : [...projected, ...remaining];
    }
    if (
      desired.every(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof item.context === "string",
      )
    ) {
      const remaining = [...current];
      const projected = desired.map((desiredItem) => {
        const index = remaining.findIndex(
          (item) => item && item.context === desiredItem.context,
        );
        if (index === -1)
          return { context: `\0missing:${desiredItem.context}` };
        const [currentItem] = remaining.splice(index, 1);
        return projectOnto(desiredItem, currentItem);
      });
      return remaining.length === 0 ? projected : [...projected, ...remaining];
    }
    if (current.length !== desired.length) return current;
    return desired.map((item, index) => projectOnto(item, current[index]));
  }
  if (current === null || typeof current !== "object" || Array.isArray(current))
    return current;
  const projected = {};
  for (const key of Object.keys(desired)) {
    projected[key] = Object.hasOwn(current, key)
      ? projectOnto(desired[key], current[key])
      : current[key];
  }
  return projected;
}

function canonicalRuleset(ruleset) {
  const payload = rulesetPayload(ruleset);
  return JSON.stringify(
    sortedValue({
      name: payload.name,
      target: payload.target,
      enforcement: payload.enforcement,
      bypass_actors: payload.bypass_actors ?? [],
      conditions: payload.conditions,
      rules: payload.rules,
    }),
  );
}

export function reconciliationPlan(desiredRulesets, currentRulesets) {
  const currentByName = new Map(
    currentRulesets.map((item) => [item.name, item]),
  );
  return desiredRulesets.map((desired) => {
    const current = currentByName.get(desired.name);
    if (!current) return { action: "create", desired };
    return canonicalRuleset(projectOnto(desired, current)) ===
      canonicalRuleset(desired)
      ? { action: "unchanged", desired, current }
      : { action: "update", desired, current };
  });
}

function gh(args, { input } = {}) {
  const result = spawnSync("gh", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GH_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) fail(`could not start GitHub CLI: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `GitHub CLI failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
    );
  }
  return result.stdout.trim();
}

function api(repository, endpoint, { method = "GET", body } = {}) {
  const args = ["api", `repos/${repository}/${endpoint}`, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const output = gh(args, {
    input: body === undefined ? undefined : `${JSON.stringify(body)}\n`,
  });
  return output ? JSON.parse(output) : null;
}

function readCurrentRulesets(repository) {
  const summaries = api(repository, "rulesets?includes_parents=false") ?? [];
  return summaries.map((summary) => api(repository, `rulesets/${summary.id}`));
}

export async function loadGovernancePolicy(filePath = POLICY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    fail(
      `could not read ${path.relative(REPOSITORY_ROOT, filePath)}: ${error.message}`,
    );
  }
  return validateGovernancePolicy(parsed);
}

async function main(argv = process.argv.slice(2)) {
  const mode = argv[0] ?? "--validate";
  if (argv.length > 1 || !MODES.has(mode)) {
    fail(
      "usage: node scripts/repository-governance.mjs [--validate|--check-remote|--apply]",
    );
  }
  const policy = await loadGovernancePolicy();
  if (mode === "--validate") {
    process.stdout.write(
      `Validated ${policy.rulesets.length} repository rulesets for ${policy.repository}.\n`,
    );
    return;
  }

  const current = readCurrentRulesets(policy.repository);
  const plan = reconciliationPlan(policy.rulesets, current);
  for (const item of plan)
    process.stdout.write(`${item.action}: ${item.desired.name}\n`);

  if (mode === "--check-remote") {
    const drift = plan.filter((item) => item.action !== "unchanged");
    if (drift.length > 0)
      fail(
        `${drift.length} repository ruleset${drift.length === 1 ? "" : "s"} differ from the checked-in contract`,
      );
    return;
  }

  if (process.env.CODEKEEPER_GOVERNANCE_APPLY !== "true") {
    fail("--apply requires CODEKEEPER_GOVERNANCE_APPLY=true");
  }
  for (const item of plan) {
    if (item.action === "create") {
      api(policy.repository, "rulesets", {
        method: "POST",
        body: rulesetPayload(item.desired),
      });
    } else if (item.action === "update") {
      api(policy.repository, `rulesets/${item.current.id}`, {
        method: "PUT",
        body: rulesetPayload(item.desired),
      });
    }
  }

  const verified = reconciliationPlan(
    policy.rulesets,
    readCurrentRulesets(policy.repository),
  );
  const drift = verified.filter((item) => item.action !== "unchanged");
  if (drift.length > 0)
    fail("GitHub did not converge on the checked-in repository rules");
  process.stdout.write(
    "Repository governance matches the checked-in contract.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
