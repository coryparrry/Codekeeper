import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assistant = new URL(
  "../../../.github/workflows/codekeeper-assistant.yml",
  import.meta.url,
);
const issues = new URL(
  "../../../.github/workflows/codekeeper-issues.yml",
  import.meta.url,
);

test("assistant authorizes trusted policy before minting a write token", async () => {
  const source = await readFile(assistant, "utf8");
  const tooling = source.indexOf(
    "Verify bootstrap Codekeeper tooling against pinned manifest",
  );
  const policy = source.indexOf("Check out trusted default-branch policy");
  const authorization = source.indexOf("Authorize configured owner request");
  const token = source.indexOf("Create short-lived GitHub App token");

  assert.ok(tooling >= 0 && tooling < authorization);
  assert.ok(policy >= 0 && policy < authorization);
  assert.ok(authorization < token);
  assert.match(
    source.slice(authorization, token),
    /authorizeOwnerRequest\(\{ event, config \}\)/,
  );
  assert.doesNotMatch(
    source.slice(authorization, token),
    /AUTOMATION_BOT_LOGIN/,
  );

  const stepStarts = [...source.matchAll(/^ {6}- name: (.+)$/gm)];
  const steps = stepStarts.map((match, index) => ({
    name: match[1],
    source: source.slice(
      match.index,
      stepStarts[index + 1]?.index ?? source.length,
    ),
  }));
  const tokenSteps = steps.filter(
    (step) =>
      step.source.includes("actions/create-github-app-token@") ||
      step.source.includes("steps.app-token.outputs."),
  );
  assert.deepEqual(
    tokenSteps.map((step) => step.name),
    [
      "Create short-lived GitHub App token",
      "Resolve automation bot identity",
      "Route deterministic owner request",
    ],
  );
  for (const step of tokenSteps) {
    assert.match(
      step.source,
      /if: steps\.authorization\.outputs\.authorized == 'true'/,
      `${step.name} must be gated by token-free authorization`,
    );
  }
});

test("later issue events queue behind in-progress publication", async () => {
  const source = await readFile(issues, "utf8");
  const concurrency = source.slice(
    source.indexOf("concurrency:"),
    source.indexOf("\njobs:"),
  );
  assert.match(
    concurrency,
    /group: codekeeper-issue-\$\{\{ github\.event\.issue\.number \|\| github\.event\.client_payload\.number \}\}/,
  );
  assert.match(concurrency, /cancel-in-progress: false/);
});
