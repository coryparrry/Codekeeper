import { REVIEW_MARKER, sha256 } from "./markers.mjs";

function boundedText(value, maximum, suffix = "\n…[truncated]") {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

function normalizedLogin(value) {
  return String(value ?? "").trim().toLowerCase();
}

function frozenRepairComments(comments, evidencePolicy) {
  if (!evidencePolicy) {
    return comments.slice(-20).map((comment) => ({
      author: boundedText(comment?.user?.login, 256, "…"),
      body: boundedText(comment?.body, 12000),
      createdAt: comment?.created_at ?? ""
    }));
  }
  const owners = new Set(evidencePolicy.ownerLogins.map(normalizedLogin));
  const ownerComments = comments
    .filter((comment) => owners.has(normalizedLogin(comment?.user?.login)))
    .slice(-5);
  let trustedReview = null;
  let selected = new Set(ownerComments);
  if (evidencePolicy.authorizationMode === "policy") {
    const actor = normalizedLogin(evidencePolicy.actor);
    trustedReview = comments.findLast((comment) =>
      comment?.user?.type === "Bot" &&
      normalizedLogin(comment?.user?.login) === actor &&
      typeof comment?.body === "string" &&
      comment.body.endsWith(REVIEW_MARKER)
    );
    if (!trustedReview) throw new Error("Automatic PR repair requires the triggering Codekeeper review comment");
    selected = new Set([trustedReview, ...ownerComments]);
  }
  return comments
    .filter((comment) => selected.has(comment))
    .map((comment) => ({
      author: boundedText(comment?.user?.login, 256, "…"),
      body: boundedText(comment?.body, comment === trustedReview ? 12000 : 2000),
      createdAt: comment?.created_at ?? ""
    }));
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

export function frozenPullRepairSubject(pull, comments, reviewThreads = [], evidencePolicy = null) {
  return {
    number: pull?.number,
    title: boundedText(pull?.title, 512, "…"),
    body: boundedText(pull?.body, evidencePolicy ? 12000 : 30000),
    author: boundedText(pull?.user?.login, 256, "…"),
    url: boundedText(pull?.html_url, 2048, "…"),
    comments: Array.isArray(comments) ? frozenRepairComments(comments, evidencePolicy) : [],
    reviewThreads: Array.isArray(reviewThreads) ? reviewThreads : []
  };
}

export function frozenPullRepairSubjectSha256(pull, comments, reviewThreads = [], evidencePolicy = null) {
  return sha256(JSON.stringify(frozenPullRepairSubject(pull, comments, reviewThreads, evidencePolicy)));
}
