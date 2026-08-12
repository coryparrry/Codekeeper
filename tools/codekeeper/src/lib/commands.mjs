import { GitHubClient, isAmbiguousGitHubMutationError } from "./github.mjs";
import { readJson } from "./io.mjs";
import { COMMAND_STATUS_MARKER } from "./markers.mjs";
import {
  OWNER_COMMANDS,
  parseDirectOwnerCommand,
  parseMentionOwnerCommand,
  parseOwnerCommand,
} from "./owner-commands.mjs";
import { upsertDeferredReviewFeedback } from "./publish.mjs";

const COMMANDS = new Set(OWNER_COMMANDS);
const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MODES = new Set(["review", "maintain", "issues", "fix"]);
const ALL_MODES = Object.freeze([...MODES]);

function labels(issue) {
  return (issue.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function isOwner(config, actor) {
  const login = String(actor ?? "")
    .trim()
    .toLowerCase();
  return config.repository.ownerLogins.some(
    (owner) => owner.toLowerCase() === login,
  );
}

function parseOwnerRequestIntent(body) {
  const direct = parseDirectOwnerCommand(body);
  if (direct) return direct;
  const mention = String(body ?? "")
    .trim()
    .match(new RegExp(`^@\\S+\\s+(${[...COMMANDS].join("|")})$`, "i"));
  return mention?.[1].toLowerCase() ?? null;
}

function authorizeOwnerIntent({ event, config, command }) {
  const targetNumber = event.issue?.number ?? event.pull_request?.number;
  if (!COMMANDS.has(command)) {
    return {
      number:
        Number.isSafeInteger(targetNumber) && targetNumber > 0
          ? targetNumber
          : null,
      command: null,
      skipped: true,
      outcome: "No supported Codekeeper command was found.",
    };
  }
  if (config.automation?.ownerRequests === false)
    throw new Error("Owner requests are off in the Codekeeper policy");
  const actor = event.comment?.user?.login ?? event.sender?.login;
  if (
    !ASSOCIATIONS.has(event.comment?.author_association) ||
    !isOwner(config, actor)
  ) {
    throw new Error(
      `Actor ${actor || "unknown"} is not authorised to run Codekeeper commands`,
    );
  }
  if (!Number.isSafeInteger(targetNumber) || targetNumber <= 0)
    throw new Error("The command target is invalid");
  return { actor, command, number: targetNumber, skipped: false };
}

export function authorizeOwnerRequest({ event, config }) {
  return authorizeOwnerIntent({
    event,
    config,
    command: parseOwnerRequestIntent(event.comment?.body),
  });
}

export function authorizeOwnerCommand({ event, config, automationLogin }) {
  return authorizeOwnerIntent({
    event,
    config,
    command: parseOwnerCommand(event.comment?.body, automationLogin),
  });
}

function requireInstalledMode(command, issue, installedModes) {
  const selected = new Set(installedModes);
  if (
    selected.size !== installedModes.length ||
    [...selected].some((mode) => !MODES.has(mode))
  ) {
    throw new Error("Installed Codekeeper workflows are invalid");
  }
  const required =
    command === "review" || command === "rerun"
      ? "review"
      : command === "triage"
        ? issue.pull_request
          ? "review"
          : "issues"
        : command === "defer"
          ? "issues"
          : command === "implement" || command === "fix"
            ? "fix"
            : null;
  if (!required || selected.has(required)) return;
  const label =
    required === "review"
      ? "Pull request review"
      : required === "issues"
        ? "Issue triage"
        : "Fixer";
  throw new Error(`/${command} requires the ${label} workflow`);
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

Available commands: \`/codekeeper status\`, \`/codekeeper review\`, \`/codekeeper triage\`, \`/codekeeper defer\`, \`/codekeeper implement\`, \`/codekeeper fix\`, and \`/codekeeper stop\`.`;
}

function assertEligibleReviewPull(pull, number, repository, defaultBranch) {
  if (
    pull.draft ||
    pull.head?.repo?.full_name !== repository ||
    pull.base?.repo?.full_name !== repository ||
    pull.base?.ref !== defaultBranch
  ) {
    throw new Error(`PR #${number} is not eligible for Codekeeper review`);
  }
  return pull;
}

async function dispatchAfterUnpausing(
  github,
  issue,
  number,
  eventType,
  payload,
) {
  const wasPaused = labels(issue).includes("codekeeper:paused");
  if (wasPaused) {
    try {
      await github.removeLabel(number, "codekeeper:paused");
    } catch (error) {
      if (isAmbiguousGitHubMutationError(error)) {
        try {
          const currentIssue = await github.getIssue(number);
          if (!labels(currentIssue).includes("codekeeper:paused")) {
            await github.addLabels(number, ["codekeeper:paused"]);
          }
        } catch (rollbackError) {
          throw new Error(
            `${error.message}; codekeeper:paused could not be restored: ${rollbackError.message}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
  }
  try {
    await github.createRepositoryDispatch(eventType, payload);
  } catch (error) {
    if (wasPaused && !isAmbiguousGitHubMutationError(error)) {
      try {
        await github.addLabels(number, ["codekeeper:paused"]);
      } catch (rollbackError) {
        throw new Error(
          `${error.message}; codekeeper:paused could not be restored: ${rollbackError.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export async function runOwnerCommand({
  eventPath,
  config,
  token,
  automationIdentity,
  installedModes = ALL_MODES,
}) {
  const event = await readJson(eventPath);
  const authorization = authorizeOwnerCommand({
    event,
    config,
    automationLogin: automationIdentity?.login,
  });
  if (authorization.skipped) return authorization;
  const { actor, command, number } = authorization;
  const repository =
    event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  const github = new GitHubClient({ token, repository });
  let issue = await github.getIssue(number);
  if (issue.state !== "open") throw new Error(`#${number} is not open`);
  requireInstalledMode(command, issue, installedModes);
  let outcome;

  if (command === "review" || command === "rerun") {
    if (!issue.pull_request)
      throw new Error(`/${command} requires a pull request`);
    const pull = assertEligibleReviewPull(
      await github.getPull(number),
      number,
      repository,
      config.repository.defaultBranch,
    );
    await github.createRepositoryDispatch("codekeeper_review", {
      number,
      head_sha: pull.head.sha,
      base_sha: pull.base.sha,
      draft: pull.draft,
      head_repository: pull.head.repo.full_name,
      base_ref: pull.base.ref,
    });
    outcome = "A new review was requested for the current pull request commit.";
  } else if (command === "triage") {
    if (issue.pull_request) {
      const pull = assertEligibleReviewPull(
        await github.getPull(number),
        number,
        repository,
        config.repository.defaultBranch,
      );
      await github.createRepositoryDispatch("codekeeper_review", {
        number,
        head_sha: pull.head.sha,
        base_sha: pull.base.sha,
        draft: pull.draft,
        head_repository: pull.head.repo.full_name,
        base_ref: pull.base.ref,
        review_feedback: true,
      });
      outcome =
        "The complete current pull request review surface was queued for triage.";
    } else {
      await github.createRepositoryDispatch("codekeeper_issue", {
        number,
        requested_by: actor,
      });
      outcome = "The issue was queued for owner-requested triage.";
    }
  } else if (command === "defer") {
    if (!issue.pull_request)
      throw new Error(
        "/codekeeper defer requires a pull request review comment",
      );
    const directComment = event.comment;
    const sourceComment = directComment?.in_reply_to_id
      ? await github.getReviewComment(directComment.in_reply_to_id)
      : directComment;
    if (
      !sourceComment?.id ||
      parseOwnerCommand(sourceComment.body, automationIdentity?.login) ===
        "defer"
    ) {
      throw new Error(
        "/codekeeper defer must reply to the review comment that should become an issue",
      );
    }
    const threads = await github.listPullReviewThreads(number);
    const thread = threads.find((candidate) =>
      (candidate.comments?.nodes ?? []).some(
        (comment) => comment.databaseId === sourceComment.id,
      ),
    );
    const sourceKey = `review_comment:${sourceComment.id}`;
    const feedback = {
      problemKey: `owner-defer-review-comment-${sourceComment.id}`,
      disposition: "defer",
      type: "maintenance",
      explanation: String(
        sourceComment.body ?? "Deferred pull request review feedback",
      ).slice(0, 6000),
      validation:
        "A configured repository owner explicitly requested deferral; normal issue triage must validate readiness and priority.",
      sourceKeys: [sourceKey],
      threadIds: thread ? [thread.id] : [],
    };
    const deferred = await upsertDeferredReviewFeedback({
      github,
      context: {
        repository,
        runUrl: "",
        pullRequest: {
          number,
          url: issue.html_url,
          reviewFeedback: [
            {
              sourceKey,
              rootCommentId:
                thread?.comments?.nodes?.[0]?.databaseId ?? sourceComment.id,
              author: sourceComment.user?.login ?? actor,
              url: sourceComment.html_url ?? issue.html_url,
              threadId: thread?.id ?? null,
            },
          ],
        },
      },
      result: { reviewFeedback: [feedback] },
      config,
      automationIdentity,
      ownerRequested: true,
    });
    outcome = `The review feedback was deferred to issue #${deferred[0].issueNumber}.`;
  } else if (command === "implement") {
    if (issue.pull_request)
      throw new Error("/codekeeper implement requires an issue");
    await dispatchAfterUnpausing(github, issue, number, "codekeeper_fix", {
      number,
      authorization_mode: "owner",
      requested_by: actor,
    });
    outcome = "The bounded owner-requested implementation was queued.";
  } else if (command === "fix") {
    if (!issue.pull_request)
      throw new Error("/codekeeper fix requires a pull request");
    const payload = {
      number,
      authorization_mode: "owner",
      requested_by: actor,
    };
    const pull = await github.getPull(number);
    payload.head_sha = pull.head.sha;
    if (event.comment?.pull_request_review_id) {
      const threads = await github.listPullReviewThreads(number);
      const thread = threads.find((candidate) =>
        (candidate.comments?.nodes ?? []).some(
          (comment) => comment.databaseId === event.comment.id,
        ),
      );
      if (thread) payload.review_thread_ids = [thread.id];
    }
    await dispatchAfterUnpausing(
      github,
      issue,
      number,
      "codekeeper_fix",
      payload,
    );
    outcome = "The bounded owner-requested repair was queued.";
  } else if (command === "stop") {
    await github.ensureLabels(config.labels, ["codekeeper:paused"]);
    await github.addLabels(number, ["codekeeper:paused"]);
    await github.removeLabel(number, "codekeeper:ready");
    if (issue.pull_request) {
      const pull = await github.getPull(number);
      if (pull.auto_merge) {
        try {
          await github.disableAutoMerge(pull.node_id);
        } catch (error) {
          if (!isAmbiguousGitHubMutationError(error)) throw error;
          const refreshedPull = await github.getPull(number);
          if (
            refreshedPull?.number !== number ||
            refreshedPull.auto_merge !== null
          )
            throw error;
        }
      }
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

export {
  parseDirectOwnerCommand as parseCommand,
  parseMentionOwnerCommand as parseMentionIntent,
};
