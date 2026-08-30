const SHA = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(message) {
  throw new Error(`Rivet repair lineage: ${message}`);
}

function required(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail(`invalid ${label}`);
}

function validRepository(repository) {
  return (
    REPOSITORY.test(repository ?? "") &&
    repository
      .split("/")
      .every((segment) => segment !== "." && segment !== "..")
  );
}

function immutable(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

function snapshot(value) {
  return immutable(structuredClone(value));
}

function validationReceipt(value) {
  if (!Array.isArray(value?.commands)) fail("validation did not pass");
  if (
    value.commands.length < 1 ||
    value.commands.length > 10 ||
    value.commands.some(
      ({ command, exitCode } = {}) =>
        typeof command !== "string" ||
        command.length < 1 ||
        command.length > 256 ||
        /[\0\r\n]/.test(command) ||
        !Number.isSafeInteger(exitCode),
    )
  ) {
    fail("invalid validation commands");
  }
  if (value.commands.some(({ exitCode }) => exitCode !== 0)) {
    fail("validation did not pass");
  }
  return {
    passed: true,
    commands: value.commands.map(({ command, exitCode }) => ({
      command,
      exitCode,
    })),
  };
}

function baseLineage(lineage) {
  if (
    lineage?.version !== 1 ||
    !validRepository(lineage.repository) ||
    !Number.isSafeInteger(lineage.pullRequest) ||
    lineage.pullRequest < 1 ||
    !SHA.test(lineage?.review?.headSha ?? "") ||
    !FINGERPRINT.test(lineage?.review?.findingsFingerprint ?? "")
  ) {
    fail("invalid lineage");
  }
}

function repairAuthorization(lineage) {
  const authorization = lineage?.authorization;
  if (
    typeof authorization?.actor !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(authorization.actor) ||
    !Number.isSafeInteger(authorization.commentId) ||
    authorization.commentId < 1 ||
    authorization.headSha !== lineage.review.headSha
  ) {
    fail("invalid repair authorization");
  }
}

function repairReceipt(lineage) {
  if (
    lineage?.repair?.attempt !== 1 ||
    lineage.repair.originalHeadSha !== lineage.review.headSha ||
    !SHA.test(lineage.repair.commitSha ?? "") ||
    lineage.repair.commitSha === lineage.review.headSha
  ) {
    fail("invalid repair receipt");
  }
  validationReceipt(lineage.repair.validation);
}

function reReviewReceipt(lineage) {
  if (
    lineage?.reReview?.headSha !== lineage.repair.commitSha ||
    !FINGERPRINT.test(lineage.reReview.findingsFingerprint ?? "") ||
    typeof lineage.reReview.blocking !== "boolean"
  ) {
    fail("invalid re-review receipt");
  }
}

export function beginRepairLineage({
  repository,
  pullRequest,
  reviewedHeadSha,
  findingsFingerprint,
}) {
  if (!validRepository(repository)) fail("invalid repository");
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    fail("invalid pull request");
  }
  required(reviewedHeadSha, SHA, "reviewed head");
  required(findingsFingerprint, FINGERPRINT, "findings fingerprint");
  return snapshot({
    version: 1,
    repository,
    pullRequest,
    review: { headSha: reviewedHeadSha, findingsFingerprint },
    authorization: null,
    repair: null,
    reReview: null,
  });
}

export function authorizeRepair(
  lineage,
  { actor, commentId, liveHeadSha },
) {
  baseLineage(lineage);
  if (lineage.authorization) fail("repair is already authorized");
  if (lineage.repair || lineage.reReview) fail("lineage is out of order");
  if (liveHeadSha !== lineage.review.headSha) fail("reviewed head is stale");
  if (typeof actor !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(actor)) {
    fail("invalid authorization actor");
  }
  if (!Number.isSafeInteger(commentId) || commentId < 1) {
    fail("invalid authorization comment");
  }
  return snapshot({
    ...lineage,
    authorization: { actor, commentId, headSha: liveHeadSha },
  });
}

export function recordRepair(
  lineage,
  { liveHeadSha, repairCommitSha, validation },
) {
  baseLineage(lineage);
  if (!lineage.authorization) fail("repair is not authorized");
  repairAuthorization(lineage);
  if (lineage.repair || lineage.reReview) fail("lineage is out of order");
  if (
    liveHeadSha !== lineage.review.headSha ||
    liveHeadSha !== lineage.authorization.headSha
  ) {
    fail("authorized head is stale");
  }
  required(repairCommitSha, SHA, "repair commit");
  if (repairCommitSha === liveHeadSha) fail("repair did not create a new head");
  return snapshot({
    ...lineage,
    repair: {
      attempt: 1,
      originalHeadSha: liveHeadSha,
      commitSha: repairCommitSha,
      validation: validationReceipt(validation),
    },
  });
}

export function recordRepairReReview(
  lineage,
  { reviewedHeadSha, findingsFingerprint, blocking },
) {
  baseLineage(lineage);
  if (!lineage.repair) fail("repair has not been recorded");
  repairAuthorization(lineage);
  repairReceipt(lineage);
  if (lineage.reReview) fail("repair is already re-reviewed");
  if (reviewedHeadSha !== lineage.repair.commitSha) {
    fail("re-review does not match the repair commit");
  }
  required(findingsFingerprint, FINGERPRINT, "findings fingerprint");
  if (typeof blocking !== "boolean") fail("invalid re-review outcome");
  return snapshot({
    ...lineage,
    reReview: {
      headSha: reviewedHeadSha,
      findingsFingerprint,
      blocking,
    },
  });
}

export function repairLineageComplete(lineage) {
  if (!lineage?.reReview) return false;
  baseLineage(lineage);
  repairAuthorization(lineage);
  repairReceipt(lineage);
  reReviewReceipt(lineage);
  return lineage.reReview.blocking === false;
}
