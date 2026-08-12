import { sha256 } from "./markers.mjs";
import { parseOwnerCommand } from "./owner-commands.mjs";

function boundedText(value, maximum, suffix = "\n…[truncated]") {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

function configuredOwnerLogins(policy) {
  if (!policy?.repository || !Array.isArray(policy.repository.ownerLogins)) {
    throw new Error("Review feedback construction requires repository owner policy");
  }
  return new Set(policy.repository.ownerLogins.map((login) => String(login).trim().toLowerCase()));
}

export async function completeReviewFeedback(github, pullNumber, policy) {
  const owners = configuredOwnerLogins(policy);
  const [reviews, threads] = await Promise.all([
    github.listPullReviews(pullNumber, 129),
    github.listPullReviewThreads(pullNumber, 129)
  ]);
  if (reviews.length > 128 || threads.length > 128) {
    throw new Error(`PR #${pullNumber} has more than 128 review records or threads`);
  }
  const automationLogin = String(process.env.CODEKEEPER_AUTOMATION_BOT_LOGIN ?? "").trim().toLowerCase();
  const isAutomationFeedback = (author) => {
    const normalizedAuthor = String(author ?? "").trim().toLowerCase();
    return Boolean(automationLogin && normalizedAuthor === automationLogin);
  };
  const isPersistedOwnerCommand = (author, body) =>
    owners.has(String(author ?? "").trim().toLowerCase())
    && parseOwnerCommand(body, automationLogin) !== null;
  const feedback = [];
  for (const review of reviews) {
    if (!String(review.body ?? "").trim()) continue;
    if (isAutomationFeedback(review.user?.login)) continue;
    const body = String(review.body ?? "");
    if (isPersistedOwnerCommand(review.user?.login, body)) continue;
    feedback.push({
      sourceKey: `review:${review.id}`,
      kind: "review",
      author: boundedText(review.user?.login, 256, "…"),
      body: boundedText(body, 6000),
      bodySha256: sha256(body),
      url: boundedText(review.html_url, 2048, "…"),
      state: boundedText(review.state, 64, "…"),
      threadId: null,
      resolved: false,
      outdated: false,
      path: null,
      line: null
    });
  }
  for (const thread of threads) {
    const rootCommentId = thread.comments?.nodes?.[0]?.databaseId ?? null;
    for (const comment of thread.comments?.nodes ?? []) {
      if (isAutomationFeedback(comment.author?.login)) continue;
      const body = String(comment.body ?? "");
      if (isPersistedOwnerCommand(comment.author?.login, body)) continue;
      feedback.push({
        sourceKey: `review_comment:${comment.databaseId}`,
        kind: "review_comment",
        author: boundedText(comment.author?.login, 256, "…"),
        body: boundedText(body, 6000),
        bodySha256: sha256(body),
        url: boundedText(comment.url, 2048, "…"),
        state: "commented",
        threadId: boundedText(thread.id, 512, "…"),
        rootCommentId,
        resolved: thread.isResolved === true,
        outdated: thread.isOutdated === true,
        path: comment.path ? boundedText(comment.path, 2048, "…") : null,
        line: Number.isSafeInteger(comment.line ?? comment.originalLine) ? (comment.line ?? comment.originalLine) : null
      });
    }
  }
  if (feedback.length > 128) throw new Error(`PR #${pullNumber} has more than 128 review feedback items`);
  return feedback.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}
