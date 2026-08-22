import { assertOwnerCommandContext } from "./commands.mjs";
import { sha256 } from "./markers.mjs";
import { normalizeOwnerCommand, parseOwnerCommand } from "./owner-commands.mjs";

const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SURFACES = new Set(["issue", "pull-request", "review-thread"]);
const COMMANDS = new Set(["review", "rerun", "triage", "implement", "repair", "fix"]);

function normalizedLogin(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function numericCommentId(value) {
  const id = String(value ?? "").trim();
  return /^[1-9][0-9]*$/.test(id) ? id : null;
}

function isConfiguredOwner(config, actor) {
  const login = normalizedLogin(actor);
  return login.length > 0 && (config.repository.ownerLogins ?? []).some((owner) => normalizedLogin(owner) === login);
}

function plainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${name} must be a plain object`);
  }
  return value;
}

function targetNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Owner-command target number is invalid");
  return number;
}

export function normalizeOwnerCommandContext(value, event) {
  if (value === undefined || value === null) return null;
  plainObject(value, "Owner-command context");
  const closed = Object.hasOwn(value, "schemaVersion");
  if (closed) assertOwnerCommandContext(value);
  const command = String(value.command ?? value.ownerCommand ?? "")
    .trim()
    .toLowerCase();
  if (!COMMANDS.has(command) || !normalizeOwnerCommand(command)) throw new Error("Owner-command context has an unsupported command");
  const sourceEvent = value.originalEvent ?? value.event ?? null;
  const comment = value.originalComment ?? value.comment ?? sourceEvent?.comment ?? event?.comment ?? (value.commentId !== undefined ? { id: value.commentId } : null);
  const surface = String(value.surface ?? (comment?.pull_request_review_id !== undefined || comment?.in_reply_to_id !== undefined || comment?.path ? "review-thread" : event?.pull_request || event?.issue?.pull_request ? "pull-request" : "issue"))
    .trim()
    .toLowerCase();
  if (!SURFACES.has(surface)) throw new Error("Owner-command context surface is invalid");
  const number = targetNumber(value.targetNumber ?? value.number ?? sourceEvent?.issue?.number ?? sourceEvent?.pull_request?.number ?? event?.issue?.number ?? event?.pull_request?.number);
  if (!number) throw new Error("Owner-command context has no target number");
  const actor = normalizedLogin(value.actor ?? value.requestedBy ?? comment?.user?.login);
  if (!actor) throw new Error("Owner-command context has no owner actor");
  const headSha = String(value.headSha ?? value.expectedHead ?? "").trim();
  if (headSha && !/^[0-9a-f]{40}$/i.test(headSha)) throw new Error("Owner-command context head SHA is invalid");
  const reviewThreadId = value.reviewThreadId ?? value.threadId ?? null;
  if (reviewThreadId !== null && (typeof reviewThreadId !== "string" || !reviewThreadId.trim() || reviewThreadId.length > 512)) throw new Error("Owner-command context review thread ID is invalid");
  return {
    command,
    canonicalCommand: normalizeOwnerCommand(command),
    surface,
    targetNumber: number,
    actor,
    headSha,
    reviewThreadId,
    comment,
    sourceEvent,
    closedContext: closed,
    schemaVersion: closed ? value.schemaVersion : undefined,
    eventName: closed ? value.eventName : undefined,
    repository: closed ? value.repository : undefined,
    association: closed ? value.association : undefined,
    commentSha256: closed ? value.commentSha256 : undefined,
    executionKind: closed ? value.executionKind : undefined,
  };
}

function commentPath(comment, surface, repository, number) {
  const field = surface === "review-thread" ? comment?.pull_request_url : comment?.issue_url;
  if (typeof field !== "string") return false;
  try {
    const pathname = new URL(field).pathname.toLowerCase();
    const kind = surface === "review-thread" ? "pulls" : "issues";
    return pathname === `/repos/${String(repository).toLowerCase()}/${kind}/${number}`;
  } catch {
    return false;
  }
}

function sameCommentIdentity(expected, live, label) {
  const expectedId = numericCommentId(expected?.id);
  if (!expectedId || expectedId !== numericCommentId(live?.id) || typeof live?.body !== "string") throw new Error(`${label} no longer matches the live owner comment`);
  if (expected?.body !== undefined && String(expected.body) !== live.body) throw new Error(`${label} no longer matches the live owner comment`);
  const expectedAuthor = normalizedLogin(expected?.user?.login);
  if (expectedAuthor && expectedAuthor !== normalizedLogin(live.user?.login)) throw new Error(`${label} author changed before preparation`);
}

export async function verifyOwnerCommandContext({ context, event, github, repository, config, allowedCommands, surfaces }) {
  if (!context) return null;
  if (!allowedCommands.includes(context.command) || !surfaces.includes(context.surface)) throw new Error("Owner-command context does not match the preparation mode");
  if (!isConfiguredOwner(config, context.actor)) throw new Error(`Actor ${context.actor || "unknown"} is not an authorised repository owner`);
  if (context.repository !== undefined && context.repository !== null && context.repository !== repository) throw new Error("Owner-command context repository does not match the live repository");
  const comment = context.comment;
  const commentId = numericCommentId(comment?.id);
  if (!commentId) throw new Error("Owner-command context requires the original comment ID");
  const liveComment = context.surface === "review-thread" ? await github.getReviewComment(commentId) : await github.getIssueComment(commentId);
  sameCommentIdentity(comment, liveComment, "Owner-command comment");
  if (context.commentSha256 && sha256(liveComment.body) !== context.commentSha256) throw new Error("Owner-command comment digest does not match the live comment");
  if (!commentPath(liveComment, context.surface, repository, context.targetNumber)) throw new Error("Owner-command comment is not attached to the requested repository target");
  const author = normalizedLogin(liveComment.user?.login);
  if (author !== context.actor || !ASSOCIATIONS.has(String(liveComment.author_association ?? "").toUpperCase())) throw new Error("Owner-command comment is not from a trusted configured owner");
  if (context.association !== undefined && context.association !== liveComment.author_association) throw new Error("Owner-command comment association changed before preparation");
  if (parseOwnerCommand(liveComment.body, process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN) !== context.command) throw new Error("Owner-command context does not match the exact live command");
  if (event?.comment) sameCommentIdentity(event.comment, liveComment, "Owner-command event comment");
  return { ...context, commentId, liveComment };
}

export function ownerContextMetadata(context) {
  if (!context) return null;
  if (context.closedContext) {
    return {
      schemaVersion: context.schemaVersion,
      eventName: context.eventName,
      repository: context.repository,
      actor: context.actor,
      association: context.association,
      command: context.command,
      canonicalCommand: context.canonicalCommand,
      surface: context.surface,
      targetNumber: context.targetNumber,
      commentId: Number(context.commentId),
      commentSha256: context.commentSha256,
      executionKind: context.executionKind,
    };
  }
  return {
    command: context.command,
    canonicalCommand: context.canonicalCommand,
    surface: context.surface,
    targetNumber: context.targetNumber,
    actor: context.actor,
    commentId: context.commentId,
    reviewThreadId: context.reviewThreadId,
    headSha: context.headSha || null,
  };
}
