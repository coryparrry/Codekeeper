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

function normalizedReviewer(review) {
  const login = String(review?.user?.login ?? "").trim().toLowerCase();
  return login || null;
}

function submittedReviewOrdering(review) {
  const submittedAt = Date.parse(String(review?.submitted_at ?? ""));
  const id = Number(review?.id);
  if (!Number.isFinite(submittedAt) || !Number.isSafeInteger(id) || id <= 0) return null;
  return { submittedAt, id };
}

function reviewState(review) {
  return String(review?.state ?? "").trim().toUpperCase();
}

function hasReviewBody(review) {
  return Boolean(String(review?.body ?? "").trim());
}

function activeReviewBodies(reviews) {
  const submittedByReviewer = new Map();
  const fallbackReviews = [];
  for (const review of reviews) {
    const reviewer = normalizedReviewer(review);
    const ordering = submittedReviewOrdering(review);
    if (reviewer && ordering) {
      const submitted = submittedByReviewer.get(reviewer) ?? [];
      submitted.push({ review, ordering });
      submittedByReviewer.set(reviewer, submitted);
    } else {
      fallbackReviews.push({ review, reviewer });
    }
  }

  const active = [];
  for (const submitted of submittedByReviewer.values()) {
    submitted.sort((left, right) =>
      left.ordering.submittedAt - right.ordering.submittedAt || left.ordering.id - right.ordering.id
    );
    const latest = submitted.at(-1).review;
    if (["APPROVED", "DISMISSED"].includes(reviewState(latest))) continue;
    const latestBody = submitted.map(({ review }) => review).reverse().find((review) =>
      hasReviewBody(review) && !["APPROVED", "DISMISSED"].includes(reviewState(review))
    );
    if (latestBody) active.push({ review: latestBody, state: reviewState(latest) });
  }

  // REST review records normally contain both submitted_at and an ID. Preserve
  // the historical body-only behavior only when no submitted record for that
  // reviewer is available; malformed records can never override authoritative
  // review state.
  for (const { review, reviewer } of fallbackReviews) {
    if (reviewer && submittedByReviewer.has(reviewer)) continue;
    if (
      hasReviewBody(review) &&
      !["APPROVED", "DISMISSED"].includes(reviewState(review))
    ) {
      active.push({ review, state: reviewState(review) });
    }
  }
  return active;
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
  for (const { review, state } of activeReviewBodies(reviews)) {
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
      state: boundedText(state, 64, "…"),
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
