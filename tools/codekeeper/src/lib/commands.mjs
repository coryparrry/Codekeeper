import { GitHubClient, isAmbiguousGitHubMutationError } from "./github.mjs";
import { readJson } from "./io.mjs";
import { COMMAND_STATUS_MARKER, sha256 } from "./markers.mjs";
import {
  OWNER_COMMANDS,
  normalizeOwnerCommand,
  ownerCommandAvailableOnSurface,
  ownerCommandSurface,
  parseAnyMentionOwnerCommand,
  parseDirectOwnerCommand,
  parseMentionOwnerCommand,
  parseOwnerCommand,
  renderOwnerCommandHelp,
  renderOwnerCommandStatus,
} from "./owner-commands.mjs";
import { upsertDeferredReviewFeedback } from "./publish.mjs";

const COMMANDS = new Set(OWNER_COMMANDS);
const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MODES = new Set(["review", "maintain", "issues", "fix"]);
const ALL_MODES = Object.freeze([...MODES]);
const OWNER_COMMAND_CONTEXT_KEYS = Object.freeze([
  "schemaVersion",
  "eventName",
  "repository",
  "actor",
  "association",
  "command",
  "canonicalCommand",
  "surface",
  "targetNumber",
  "commentId",
  "commentSha256",
  "executionKind",
]);
const MODE_EXECUTION_COMMANDS = new Set([
  "review",
  "rerun",
  "triage",
  "implement",
  "repair",
  "fix",
]);
const DETERMINISTIC_EXECUTION_COMMANDS = new Set([
  "help",
  "status",
  "pause",
  "stop",
  "defer",
]);

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
  return parseDirectOwnerCommand(body) ?? parseAnyMentionOwnerCommand(body);
}

function authorizeOwnerIntent({ event, config, command }) {
  const targetNumber = event.issue?.number ?? event.pull_request?.number;
  const canonicalCommand = normalizeOwnerCommand(command);
  if (!canonicalCommand || !COMMANDS.has(command)) {
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

function normalizedLogin(value) {
  return String(value ?? "")
    .trim()
    .replace(/\[bot\]$/i, "")
    .toLowerCase();
}

function positiveInteger(value, label) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function executionKindForCommand(command) {
  if (MODE_EXECUTION_COMMANDS.has(command)) return "mode";
  if (DETERMINISTIC_EXECUTION_COMMANDS.has(command)) return "deterministic";
  throw new Error(`Unsupported Codekeeper owner command: ${command}`);
}

function freezeOwnerCommandContext(context) {
  return Object.freeze({ ...context });
}

/**
 * Validate the closed, runner-owned owner-command context before it crosses a
 * workflow stage boundary. This deliberately accepts no routing or authority
 * fields beyond the immutable command request record.
 */
export function assertOwnerCommandContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("Owner-command context must be an object");
  }
  const keys = Object.keys(context).sort();
  const expected = [...OWNER_COMMAND_CONTEXT_KEYS].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Owner-command context contains an unexpected shape");
  }
  if (context.schemaVersion !== 1) {
    throw new TypeError("Unsupported owner-command context schema version");
  }
  for (const [name, value] of [
    ["actor", context.actor],
    ["association", context.association],
    ["command", context.command],
    ["canonicalCommand", context.canonicalCommand],
    ["surface", context.surface],
    ["commentSha256", context.commentSha256],
    ["executionKind", context.executionKind],
  ]) {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError(`Owner-command context ${name} is invalid`);
    }
  }
  if (context.eventName !== null && typeof context.eventName !== "string") {
    throw new TypeError("Owner-command context eventName is invalid");
  }
  if (
    context.repository !== null &&
    (typeof context.repository !== "string" || !context.repository.trim())
  ) {
    throw new TypeError("Owner-command context repository is invalid");
  }
  if (!ASSOCIATIONS.has(context.association)) {
    throw new Error("Owner-command context association is not trusted");
  }
  if (!ownerCommandAvailableOnSurface(context.command, context.surface)) {
    throw new Error(
      `/${context.command} is not available on this ${context.surface}`,
    );
  }
  if (normalizeOwnerCommand(context.command) !== context.canonicalCommand) {
    throw new Error("Owner-command context canonical command does not match");
  }
  if (executionKindForCommand(context.command) !== context.executionKind) {
    throw new Error("Owner-command context execution kind does not match");
  }
  positiveInteger(context.targetNumber, "Owner-command context targetNumber");
  positiveInteger(context.commentId, "Owner-command context commentId");
  if (!/^[a-f0-9]{64}$/.test(context.commentSha256)) {
    throw new Error("Owner-command context comment SHA-256 is invalid");
  }
  return context;
}

/**
 * Parse and authorize the original event without a GitHub token. The result
 * is intentionally closed and immutable so later stages cannot replace the
 * actor, target, surface, or command after authorization.
 */
export function resolveOwnerCommandContext({
  event,
  config,
  automationLogin,
  eventName = process.env.GITHUB_EVENT_NAME ?? null,
}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("Owner-command event must be an object");
  }
  if (!String(automationLogin ?? "").trim()) {
    throw new Error("Configured automation bot login is required");
  }
  const authorization = authorizeOwnerCommand({
    event,
    config,
    automationLogin,
  });
  if (authorization.skipped || !authorization.command) {
    throw new Error("No supported Codekeeper owner command was found");
  }
  const actor = String(authorization.actor ?? "").trim();
  if (normalizedLogin(actor) === normalizedLogin(automationLogin)) {
    throw new Error(
      "The configured Codekeeper automation bot cannot issue owner commands",
    );
  }
  const association = String(event.comment?.author_association ?? "").trim();
  if (!ASSOCIATIONS.has(association)) {
    throw new Error("Owner-command association is not trusted");
  }
  const command = String(authorization.command).trim().toLowerCase();
  const canonicalCommand = normalizeOwnerCommand(command);
  const surface = ownerCommandSurface(event);
  if (!ownerCommandAvailableOnSurface(command, surface)) {
    throw new Error(`/${command} is not available on this ${surface}`);
  }
  const targetNumber = positiveInteger(
    authorization.number,
    "Owner-command target",
  );
  const commentId = positiveInteger(
    event.comment?.id,
    "Owner-command comment ID",
  );
  const repository =
    event.repository?.full_name ?? process.env.GITHUB_REPOSITORY ?? null;
  const context = freezeOwnerCommandContext({
    schemaVersion: 1,
    eventName:
      typeof eventName === "string" && eventName.trim()
        ? eventName.trim()
        : null,
    repository: repository ? String(repository) : null,
    actor,
    association,
    command,
    canonicalCommand,
    surface,
    targetNumber,
    commentId,
    commentSha256: sha256(String(event.comment?.body ?? "")),
    executionKind: executionKindForCommand(command),
  });
  assertOwnerCommandContext(context);
  return context;
}

function requireInstalledMode(command, issue, installedModes) {
  const selected = new Set(installedModes);
  if (
    selected.size !== installedModes.length ||
    [...selected].some((mode) => !MODES.has(mode))
  ) {
    throw new Error("Installed Codekeeper workflows are invalid");
  }
  const canonical = normalizeOwnerCommand(command);
  const required =
    canonical === "review"
      ? issue.pull_request
        ? "review"
        : "issues"
      : canonical === "defer"
        ? "issues"
        : canonical === "implement" || canonical === "repair"
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

function assertEligibleReviewPull(pull, number, repository) {
  if (
    pull.draft ||
    pull.head?.repo?.full_name !== repository ||
    pull.base?.repo?.full_name !== repository ||
    !pull.base?.ref
  ) {
    throw new Error(`PR #${number} is not eligible for Codekeeper review`);
  }
  return pull;
}

function assertEligibleRepairPull(pull, number, repository, defaultBranch) {
  assertEligibleReviewPull(pull, number, repository);
  if (pull.base.ref !== defaultBranch) {
    throw new Error(
      `PR #${number} targets ${pull.base.ref}; /codekeeper repair supports default-branch pull requests only. Stacked pull requests support review only; repair is unavailable.`,
    );
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
      await github.removeLabel(number, "codekeeper:paused", "lifecycle");
    } catch (error) {
      if (isAmbiguousGitHubMutationError(error)) {
        try {
          const currentIssue = await github.getIssue(number);
          if (!labels(currentIssue).includes("codekeeper:paused")) {
            await github.addLabels(number, ["codekeeper:paused"]);
          }
        } catch (rollbackError) {
          throw new Error(
            `${error.message}; paused could not be restored: ${rollbackError.message}`,
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
          `${error.message}; paused could not be restored: ${rollbackError.message}`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export function issueDispatchReceipt({
  repository,
  number,
  command,
  actor,
  commentId: rawCommentId,
}) {
  const commentId = Number(rawCommentId);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new Error("Issue dispatch requires a valid owner-command comment ID");
  }
  const normalizedCommand = String(command).trim().toLowerCase();
  if (!["review", "triage", "implement"].includes(normalizedCommand)) {
    throw new Error("Issue dispatch command is invalid");
  }
  const requestId = sha256(
    JSON.stringify({
      version: 1,
      repository: String(repository).toLowerCase(),
      number,
      command: normalizedCommand,
      actor: String(actor).toLowerCase(),
      commentId,
    }),
  );
  const marker = `<!-- codekeeper:command-dispatch=${requestId} -->`;
  const body = [
    "## Codekeeper dispatch requested",
    "",
    `- Command: \`/codekeeper ${normalizedCommand}\``,
    `- Requested by: \`@${actor}\``,
    `- Command comment: \`${commentId}\``,
    `- Request ID: \`${requestId}\``,
    "",
    "This immutable receipt records the request before dispatch. It does not confirm that GitHub accepted or started a worker.",
  ].join("\n");
  const content = `${body}\n${marker}`;
  return {
    command: normalizedCommand,
    commentId,
    requestId,
    marker,
    body,
    content,
    sha256: sha256(content),
  };
}

async function dispatchIssueOwnerCommand({
  github,
  issue,
  event,
  repository,
  number,
  command,
  actor,
  automationIdentity,
  eventType,
  payload,
  unpause = false,
}) {
  const identity = issueDispatchReceipt({
    repository,
    number,
    command,
    actor,
    commentId: event.comment?.id,
  });
  const receipt = await github.upsertMarkerComment(
    number,
    identity.marker,
    identity.body,
    automationIdentity,
  );
  const receiptCommentId = Number(receipt?.id);
  if (!Number.isSafeInteger(receiptCommentId) || receiptCommentId <= 0) {
    throw new Error("Issue dispatch receipt has no valid comment ID");
  }
  const dispatchPayload = {
    ...payload,
    command_request_id: identity.requestId,
    command_name: identity.command,
    command_comment_id: identity.commentId,
    command_receipt_comment_id: receiptCommentId,
    command_receipt_sha256: identity.sha256,
  };
  if (unpause) {
    await dispatchAfterUnpausing(
      github,
      issue,
      number,
      eventType,
      dispatchPayload,
    );
  } else {
    await github.createRepositoryDispatch(eventType, dispatchPayload);
  }
  return identity;
}

/** Execute deterministic commands through the established command path while
 * refusing every command that belongs to a model mode before GitHub access. */
export async function runDeterministicOwnerCommand(options) {
  const event = options.event ?? (await readJson(options.eventPath));
  const context = resolveOwnerCommandContext({
    event,
    eventName: options.eventName,
    config: options.config,
    automationLogin: options.automationIdentity?.login,
  });
  if (context.executionKind !== "deterministic") {
    throw new Error(
      `Direct deterministic execution refuses mode command /codekeeper ${context.command}; mode commands require the generic runtime`,
    );
  }
  return runOwnerCommand({
    ...options,
    event,
    deterministicOnly: true,
  });
}

export async function runOwnerCommand({
  eventPath,
  event: suppliedEvent,
  config,
  token,
  automationIdentity,
  installedModes = ALL_MODES,
  deterministicOnly = false,
}) {
  const event = suppliedEvent ?? (await readJson(eventPath));
  const authorization = authorizeOwnerCommand({
    event,
    config,
    automationLogin: automationIdentity?.login,
  });
  if (authorization.skipped) return authorization;
  const { actor, command, number } = authorization;
  const canonicalCommand = normalizeOwnerCommand(command);
  if (
    deterministicOnly &&
    executionKindForCommand(command) !== "deterministic"
  ) {
    throw new Error(
      `Direct deterministic execution refuses mode command /codekeeper ${command}; mode commands require the generic runtime`,
    );
  }
  const repository =
    event.repository?.full_name ?? process.env.GITHUB_REPOSITORY;
  const github = new GitHubClient({ token, repository });
  let issue = await github.getIssue(number);
  if (issue.state !== "open") throw new Error(`#${number} is not open`);
  const surface = ownerCommandSurface({ ...event, issue });
  if (!ownerCommandAvailableOnSurface(command, surface)) {
    throw new Error(`/${command} is not available on this ${surface}`);
  }
  requireInstalledMode(command, issue, installedModes);
  let outcome;

  if (canonicalCommand === "help") {
    const repairAvailable =
      !issue.pull_request ||
      (await github.getPull(number)).base?.ref ===
        config.repository.defaultBranch;
    await github.upsertMarkerComment(
      number,
      COMMAND_STATUS_MARKER,
      renderOwnerCommandHelp(surface, { repairAvailable }),
      automationIdentity,
    );
    return {
      number,
      command,
      outcome: `Help for this ${surface} was posted.`,
    };
  } else if (canonicalCommand === "review") {
    if (!issue.pull_request) {
      await dispatchIssueOwnerCommand({
        github,
        issue,
        event,
        repository,
        number,
        command,
        actor,
        automationIdentity,
        eventType: "codekeeper_issue",
        payload: { number, requested_by: actor },
      });
      outcome = "The issue was queued for owner-requested triage.";
      return { number, command, outcome };
    } else {
      const pull = assertEligibleReviewPull(
        await github.getPull(number),
        number,
        repository,
      );
      const payload = {
        number,
        head_sha: pull.head.sha,
        base_sha: pull.base.sha,
        draft: pull.draft,
        head_repository: pull.head.repo.full_name,
        base_ref: pull.base.ref,
      };
      if (command === "triage") payload.review_feedback = true;
      await github.createRepositoryDispatch("codekeeper_review", payload);
      outcome =
        command === "triage"
          ? "The complete current pull request review surface was queued for triage."
          : "A new review was requested for the current pull request commit.";
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
    await dispatchIssueOwnerCommand({
      github,
      issue,
      event,
      repository,
      number,
      command,
      actor,
      automationIdentity,
      eventType: "codekeeper_fix",
      payload: {
        number,
        authorization_mode: "owner",
        requested_by: actor,
      },
      unpause: true,
    });
    outcome = "The bounded owner-requested implementation was queued.";
    return { number, command, outcome };
  } else if (canonicalCommand === "repair") {
    if (!issue.pull_request)
      throw new Error(
        `/codekeeper ${command === "fix" ? "fix" : "repair"} requires a pull request`,
      );
    const payload = {
      number,
      authorization_mode: "owner",
      requested_by: actor,
    };
    const pull = assertEligibleRepairPull(
      await github.getPull(number),
      number,
      repository,
      config.repository.defaultBranch,
    );
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
  } else if (canonicalCommand === "pause") {
    await github.ensureLabels(config.labels, ["codekeeper:paused"]);
    await github.addLabels(number, ["codekeeper:paused"]);
    if (!issue.pull_request)
      await github.removeLabel(number, "codekeeper:ready", "issue");
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
  const repairAvailable =
    !issue.pull_request ||
    (await github.getPull(number)).base?.ref ===
      config.repository.defaultBranch;
  await github.upsertMarkerComment(
    number,
    COMMAND_STATUS_MARKER,
    renderOwnerCommandStatus({
      issue,
      command,
      outcome,
      config,
      surface,
      repairAvailable,
    }),
    automationIdentity,
  );
  return { number, command, outcome };
}

export {
  parseDirectOwnerCommand as parseCommand,
  parseMentionOwnerCommand as parseMentionIntent,
};
