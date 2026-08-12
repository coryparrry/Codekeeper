import { sha256 } from "./markers.mjs";

function boundedText(value, maximum, suffix = "\n…[truncated]") {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

export function frozenPullRepairReviewThreads(threads, reviewThreadIds) {
  if (reviewThreadIds.length === 0) return [];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const selected = reviewThreadIds.map((threadId) => {
    const thread = byId.get(threadId);
    if (!thread) throw new Error(`PR repair review thread ${threadId} no longer exists`);
    return {
      id: thread.id,
      isResolved: Boolean(thread.isResolved),
      isOutdated: Boolean(thread.isOutdated),
      comments: (thread.comments?.nodes ?? thread.comments ?? []).map((comment) => ({
        id: boundedText(comment.id, 512, "…"),
        databaseId: comment.databaseId,
        author: boundedText(comment.author?.login ?? comment.author, 256, "…"),
        body: boundedText(comment.body, 6000),
        bodySha256: sha256(String(comment.body ?? "")),
        url: boundedText(comment.url, 2048, "…"),
        path: boundedText(comment.path, 4096, "…"),
        line: comment.line ?? null,
        originalLine: comment.originalLine ?? null
      }))
    };
  });
  if (Buffer.byteLength(JSON.stringify(selected), "utf8") > 262144) {
    throw new Error("Selected PR repair review thread evidence exceeds 262144 bytes");
  }
  return selected;
}

export function frozenPullRepairSubject(pull, comments, reviewThreads = []) {
  return {
    number: pull?.number,
    title: boundedText(pull?.title, 512, "…"),
    body: boundedText(pull?.body, 30000),
    author: boundedText(pull?.user?.login, 256, "…"),
    url: boundedText(pull?.html_url, 2048, "…"),
    comments: Array.isArray(comments)
      ? comments.slice(-20).map((comment) => ({
        author: boundedText(comment?.user?.login, 256, "…"),
        body: boundedText(comment?.body, 12000),
        createdAt: comment?.created_at ?? ""
      }))
      : [],
    reviewThreads: Array.isArray(reviewThreads) ? reviewThreads : []
  };
}

export function frozenPullRepairSubjectSha256(pull, comments, reviewThreads = []) {
  return sha256(JSON.stringify(frozenPullRepairSubject(pull, comments, reviewThreads)));
}
