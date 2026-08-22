import assert from "node:assert/strict";
import test from "node:test";
import { repositoryFile } from "./workflow-test-helpers.mjs";

const templatePath = "examples/workflows/codekeeper.yml.example";
const expectedJobs = ["review", "issue", "fix", "maintain", "command"];

function jobs(source) {
  const start = source.indexOf("\njobs:\n");
  assert.notEqual(start, -1, "missing jobs mapping");
  return source.slice(start + 1);
}

function job(source, id) {
  const body = jobs(source);
  const start = body.indexOf(`  ${id}:\n`);
  assert.notEqual(start, -1, `missing ${id} job`);
  const next = expectedJobs
    .map((candidate) => body.indexOf(`  ${candidate}:\n`, start + 1))
    .filter((index) => index > start)
    .sort((left, right) => left - right)[0];
  return body.slice(start, next ?? body.length);
}

async function callers() {
  return [await repositoryFile(templatePath)];
}

test("unified caller exposes exactly five static reusable-workflow jobs", async () => {
  for (const source of await callers()) {
    const body = jobs(source);
    assert.deepEqual(
      [...body.matchAll(/^  ([a-z]+):\n/gm)].map((match) => match[1]),
      expectedJobs,
    );
    assert.equal(
      [
        ...body.matchAll(
          /uses: \.\/\.github\/workflows\/codekeeper-runtime\.yml/g,
        ),
      ].length,
      5,
    );
    assert.doesNotMatch(body, /^\s+runs-on:/m);
    assert.doesNotMatch(body, /^\s+steps:/m);
  }
});

test("automatic jobs call the generic runtime with one explicit mode", async () => {
  const modeByJob = {
    review: "review",
    issue: "issues",
    fix: "fix",
    maintain: "maintain",
  };
  for (const source of await callers()) {
    for (const [id, mode] of Object.entries(modeByJob)) {
      const body = job(source, id);
      assert.match(
        body,
        /uses: \.\/\.github\/workflows\/codekeeper-runtime\.yml/,
      );
      assert.match(body, new RegExp(`^      mode: ${mode}$`, "m"));
      assert.doesNotMatch(body, /^      mode: auto$/m);
    }
  }
});

test("command enters mode auto without a routing runner or second dispatch", async () => {
  for (const source of await callers()) {
    const body = job(source, "command");
    assert.match(body, /^      mode: auto$/m);
    assert.match(body, /github\.event_name == 'issue_comment'/);
    assert.match(body, /github\.event_name == 'pull_request_review_comment'/);
    assert.match(body, /inputs\.verify_app_credentials/);
    assert.match(body, /repository\.ownerLogins/);
    assert.doesNotMatch(
      body,
      /repository_dispatch|gh api|actions\/github-script/,
    );
    assert.equal(
      [
        ...body.matchAll(
          /uses: \.\/\.github\/workflows\/codekeeper-runtime\.yml/g,
        ),
      ].length,
      1,
    );
  }
});

test("manual dispatch selects maintenance, fix, or the no-mutation credential proof", async () => {
  for (const source of await callers()) {
    const fix = job(source, "fix");
    const maintain = job(source, "maintain");
    const command = job(source, "command");
    assert.match(source, /^      issue_number:/m);
    assert.match(source, /^      verify_app_credentials:/m);
    assert.match(fix, /inputs\.issue_number != ''/);
    assert.match(maintain, /inputs\.issue_number == ''/);
    assert.match(maintain, /!inputs\.verify_app_credentials/);
    assert.match(command, /^      credential_probe: /m);
    assert.match(command, /^      verification_id: /m);
    assert.match(source, /Codekeeper App credential verification/);
    assert.match(source, /Codekeeper maintenance verification/);
    assert.match(source, /Codekeeper manual fix/);
  }
});

test("comment events route commands away from review and issue automation", async () => {
  for (const source of await callers()) {
    const review = job(source, "review");
    const issue = job(source, "issue");
    const command = job(source, "command");
    for (const body of [review, issue, command]) {
      assert.match(body, /CODEKEEPER_OWNER_COMMANDS_START/);
      assert.match(body, /contains\(github\.event\.comment\.body, '\/codekeeper'\)/);
      assert.match(body, /contains\(github\.event\.comment\.body, 'AUTOMATION_BOT_MENTION'\)/);
      assert.match(body, /CODEKEEPER_AUTOMATION_BOT_LOGIN/);
    }
    assert.match(review, /github\.event_name == 'pull_request_review_comment'/);
    assert.match(issue, /codekeeper:needs-information/);
    assert.match(issue, /!contains\(github\.event\.comment\.body, '\/codekeeper'\)/);
    assert.match(issue, /!contains\(github\.event\.comment\.body, 'AUTOMATION_BOT_MENTION'\)/);
    assert.match(command, /github\.event\.action == 'created'/);
    assert.doesNotMatch(command, /endsWith\(github\.event\.comment\.body/);
    assert.equal(source.match(/AUTOMATION_BOT_MENTION/g)?.length, 3);
  }
});

test("rendered automation controls govern the matching static jobs", async () => {
  for (const source of await callers()) {
    for (const placeholder of [
      "OWNER_REQUESTS_ENABLED",
      "AUTO_REVIEW_ENABLED",
      "FEEDBACK_TRIAGE_ENABLED",
      "AUTO_TRIAGE_ENABLED",
    ]) {
      assert.equal(
        [...source.matchAll(new RegExp(placeholder, "g"))].length,
        2,
        `${placeholder} must have one recovery marker and one admission use`,
      );
    }
    assert.match(job(source, "review"), /fromJSON\('AUTO_REVIEW_ENABLED'\)/);
    assert.match(
      job(source, "review"),
      /fromJSON\('FEEDBACK_TRIAGE_ENABLED'\)/,
    );
    assert.match(job(source, "issue"), /fromJSON\('AUTO_TRIAGE_ENABLED'\)/);
    assert.match(
      job(source, "command"),
      /fromJSON\('OWNER_REQUESTS_ENABLED'\)/,
    );
    assert.doesNotMatch(source, /vars\.CODEKEEPER_OWNER_REQUESTS/);
  }
});

test("review preserves protected gate admission and event compatibility", async () => {
  for (const source of await callers()) {
    const review = job(source, "review");
    assert.match(
      source,
      /pull_request_target:\n    types: \[opened, reopened, synchronize, ready_for_review\]/,
    );
    assert.match(
      source,
      /pull_request_review:\n    types: \[submitted, edited, dismissed\]/,
    );
    assert.match(
      source,
      /pull_request_review_comment:\n    types: \[created, edited, deleted\]/,
    );
    assert.match(review, /"Codekeeper review gate"/);
    assert.match(review, /^      mode: review$/m);
    assert.match(review, /vars\.CODEKEEPER_ENABLED == 'true'/);
    assert.match(
      review,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
    assert.doesNotMatch(
      review.split("    with:\n", 1)[0],
      /CODEKEEPER_ENABLED/,
    );
  }
});

test("every job passes release identity, installed modes, and named secrets", async () => {
  for (const source of await callers()) {
    for (const id of expectedJobs) {
      const body = job(source, id);
      assert.match(body, /^      package_version: "PACKAGE_VERSION"$/m);
      assert.match(body, /^      package_integrity: "PACKAGE_INTEGRITY"$/m);
      assert.match(body, /^      installed_modes: "INSTALLED_MODES"$/m);
      for (const secret of [
        "openai_api_key",
        "deepseek_api_key",
        "openrouter_api_key",
        "workspace_api_key",
        "trace_api_key",
        "app_private_key",
      ]) {
        assert.ok(
          body.includes(`      ${secret}: \${{ secrets.`),
          `${id} must pass ${secret} from a named repository secret`,
        );
      }
    }
  }
});
