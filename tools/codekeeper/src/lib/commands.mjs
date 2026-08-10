import { GitHubClient } from "./github.mjs";
import { readJson } from "./io.mjs";
import { COMMAND_STATUS_MARKER } from "./markers.mjs";

const COMMANDS = new Set(["status", "review", "rerun", "implement", "stop"]);
const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function labels(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function parseCommand(body) {
  const match = String(body ?? "")
    .trim()
    .match(/^\/codekeeper\s+(status|review|rerun|implement|stop)$/i);
  return match ? match[1].toLowerCase() : null;
}

function isOwner(config, actor) {
  const login = String(actor ?? "")
    .trim()
    .toLowerCase();
  return config.repository.ownerLogins.some(
    (owner) => owner.toLowerCase() === login,
  );
}

function statusBody(issue, command, outcome) {
  const active = labels(issue).filter((label) =>
    label.startsWith("codekeeper:"),
  );
  return `## Codekeeper status

| Item | State |
|---|---|
| Command | \`${command}\` |
| Result | ${outcome} |
| Codekeeper labels | ${active.length ? active.map((label) => `\`${label}\``).join(", ") : "None"} |

Available commands: \`/codekeeper status\`, \`/codekeeper review\`, \`/codekeeper rerun\`, \`/codekeeper implement\`, \`/codekeeper fix\`, and \`/codekeeper stop\`.`;
}

export async function runOwnerCommand({
  eventPath,
  config,
  token,
  automationIdentity,
}) {
  const event = await readJson(eventPath);
  const command = parseCommand(event.comment?.body);
  if (!COMMANDS.has(command))
    throw new Error("The Codekeeper command is not supported");
  const actor = event.comment?.user?.login ?? event.sender?.login;
  if (
    !ASSOCIATIONS.has(event.comment?.author_association) ||
    !isOwner(config, actor)
  ) {
    throw new Error(
      `Actor ${actor || "unknown"} is not authorised to run Codekeeper commands`,
    );
  }
  const repository =
    event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  const number = event.issue?.number;
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error("The command target is invalid");
  const github = new GitHubClient({ token, repository });
  let issue = await github.getIssue(number);
  if (issue.state !== "open") throw new Error(`#${number} is not open`);
  let outcome;

  if (command === "review" || command === "rerun") {
    if (!issue.pull_request)
      throw new Error(`/${command} requires a pull request`);
    const pull = await github.getPull(number);
    if (
      pull.draft ||
      pull.head?.repo?.full_name !== repository ||
      pull.base?.repo?.full_name !== repository
    ) {
      throw new Error(`PR #${number} is not eligible for Codekeeper review`);
    }
    await github.createRepositoryDispatch("codekeeper_review", {
      number,
      head_sha: pull.head.sha,
      base_sha: pull.base.sha,
      draft: pull.draft,
      head_repository: pull.head.repo.full_name,
      base_ref: pull.base.ref,
    });
    outcome = "A new review was requested for the current pull request commit.";
  } else if (command === "implement") {
    if (issue.pull_request)
      throw new Error("/codekeeper implement requires an issue");
    if (!config.issues.allowAiImplementation)
      throw new Error("Issue implementation is off in the Codekeeper policy");
    await github.ensureLabels(config.labels, ["codekeeper:ready"]);
    await github.addLabels(number, ["codekeeper:ready"]);
    outcome = "The issue was queued for implementation.";
  } else if (command === "stop") {
    await github.ensureLabels(config.labels, ["codekeeper:paused"]);
    await github.addLabels(number, ["codekeeper:paused"]);
    await github.removeLabel(number, "codekeeper:ready");
    if (issue.pull_request) {
      const pull = await github.getPull(number);
      if (pull.auto_merge) await github.disableAutoMerge(pull.node_id);
    }
    outcome =
      "Automatic implementation, repair, and merge are paused for this item.";
  } else {
    outcome = "The current Codekeeper state is shown below.";
  }

  issue = await github.getIssue(number);
  await github.upsertMarkerComment(
    number,
    COMMAND_STATUS_MARKER,
    statusBody(issue, command, outcome),
    automationIdentity,
  );
  return { number, command, outcome };
}

export { parseCommand };
