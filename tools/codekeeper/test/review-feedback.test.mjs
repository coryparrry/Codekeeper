import assert from "node:assert/strict";
import test from "node:test";
import { completeReviewFeedback } from "../src/lib/review-feedback.mjs";

const policy = { repository: { ownerLogins: [] } };

function review(id, login, state, body, submittedAt) {
  return {
    id,
    user: { login },
    state,
    body,
    submitted_at: submittedAt,
    html_url: `https://github.test/reviews/${id}`,
  };
}

test("later approval or dismissal supersedes a reviewer's prior body without affecting inline threads", async () => {
  const feedback = await completeReviewFeedback(
    {
      async listPullReviews() {
        return [
          review(
            102,
            "approved-reviewer",
            "APPROVED",
            "",
            "2026-08-17T12:00:00.000Z",
          ),
          review(
            101,
            "approved-reviewer",
            "CHANGES_REQUESTED",
            "Handle nil value",
            "2026-08-17T12:00:00.000Z",
          ),
          review(
            "not-a-number",
            "approved-reviewer",
            "CHANGES_REQUESTED",
            "Malformed old feedback",
            "not-a-date",
          ),
          review(
            202,
            "dismissed-reviewer",
            "DISMISSED",
            "",
            "2026-08-17T13:00:00.000Z",
          ),
          review(
            201,
            "dismissed-reviewer",
            "CHANGES_REQUESTED",
            "Add a regression",
            "2026-08-17T12:00:00.000Z",
          ),
          review(
            301,
            "current-reviewer",
            "CHANGES_REQUESTED",
            "Keep this active",
            "2026-08-17T12:00:00.000Z",
          ),
        ];
      },
      async listPullReviewThreads() {
        return [
          {
            id: "PRRT_inline",
            isResolved: false,
            isOutdated: false,
            comments: {
              nodes: [
                {
                  databaseId: 401,
                  body: "Inline feedback remains independent.",
                  url: "https://github.test/comments/401",
                  path: "README.md",
                  line: 1,
                  author: { login: "approved-reviewer" },
                },
              ],
            },
          },
        ];
      },
    },
    7,
    policy,
  );

  assert.deepEqual(
    feedback.map(({ sourceKey, body, state }) => ({ sourceKey, body, state })),
    [
      {
        sourceKey: "review_comment:401",
        body: "Inline feedback remains independent.",
        state: "commented",
      },
      {
        sourceKey: "review:301",
        body: "Keep this active",
        state: "CHANGES_REQUESTED",
      },
    ],
  );
});
