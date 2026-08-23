import { isAmbiguousGitHubMutationError } from "./github.mjs";
import { warn } from "./io.mjs";
import { automaticRepairMarker } from "./markers.mjs";
import {
  acquireAutomaticRepairLease,
  publishReview as publishReviewImpl,
  releaseAutomaticRepairLease
} from "./publish/review.mjs";

export {
  acquireAutomaticRepairLease,
  isTrustedMaintenanceFindingIssue,
  isTrustedMaintenanceIssue,
  isTrustedRepairPull,
  publishAudit,
  publishFix,
  publishIssue,
  reconcileAutoMerge,
  repairBranch,
  replyToReviewFeedback,
  reviewPublicationDisposition,
  upsertDeferredReviewFeedback
} from "./publish/index.mjs";

// Live automatic-repair dispatch stays on this facade so source-scan contracts
// inspect authorization_mode and requested_by on the executed path.
async function dispatchAutomaticReviewRepair({
  github,
  pull,
  context,
  automationIdentity,
  repairFeedback,
  automaticRepair
}) {
  if (!automaticRepair.eligible) return;

  const lease = await acquireAutomaticRepairLease({ github, context, pull, automationIdentity });
  if (!lease.acquired) {
    automaticRepair.eligible = false;
    return;
  }

  let dispatchAttempted = false;
  let dispatchSucceeded = false;
  try {
    await github.upsertMarkerComment(
      pull.number,
      automaticRepairMarker(pull.head.sha),
      `Automatic repair dispatch is pending for head ${pull.head.sha}.`,
      automationIdentity
    );
    dispatchAttempted = true;
    await github.createRepositoryDispatch("codekeeper_fix", {
      number: pull.number,
      head_sha: pull.head.sha,
      authorization_mode: "policy",
      requested_by: automationIdentity.login,
      review_thread_ids: [...new Set(repairFeedback.flatMap((feedback) => feedback.threadIds))]
    });
    dispatchSucceeded = true;
    automaticRepair.dispatched = true;
    await github.upsertMarkerComment(
      pull.number,
      automaticRepairMarker(pull.head.sha),
      `Automatic repair was dispatched for head ${pull.head.sha}.`,
      automationIdentity
    );
    await releaseAutomaticRepairLease(github, lease, "completed");
  } catch (error) {
    let rollbackError = null;
    const ambiguousDispatch = !dispatchSucceeded && dispatchAttempted && isAmbiguousGitHubMutationError(error);
    if (!dispatchSucceeded) {
      try {
        await github.upsertMarkerComment(
          pull.number,
          automaticRepairMarker(pull.head.sha),
          ambiguousDispatch
            ? `Automatic repair dispatch is ambiguous for head ${pull.head.sha}.`
            : `Automatic repair dispatch failed for head ${pull.head.sha}.`,
          automationIdentity
        );
      } catch (cause) {
        warn(`Could not record automatic repair dispatch state for PR #${pull.number}: ${cause.message}`);
      }
    }
    try {
      await releaseAutomaticRepairLease(
        github,
        lease,
        ambiguousDispatch ? "ambiguous" : dispatchSucceeded ? "completed" : "failed"
      );
    } catch (cause) {
      if (ambiguousDispatch) {
        warn(`Could not record ambiguous automatic repair dispatch for PR #${pull.number}: ${cause.message}`);
      } else {
        rollbackError ??= cause;
      }
    }
    if (rollbackError) {
      throw new Error(
        `${error.message}; automatic repair lease rollback failed: ${rollbackError.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

export async function publishReview(options) {
  return publishReviewImpl({
    ...options,
    dispatchAutomaticReviewRepair
  });
}
