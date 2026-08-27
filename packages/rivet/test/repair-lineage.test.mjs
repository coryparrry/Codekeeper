import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeRepair,
  beginRepairLineage,
  recordRepair,
  recordRepairReReview,
  repairLineageComplete,
} from "../src/repair-lineage.mjs";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const FINDINGS_A = "1".repeat(64);
const FINDINGS_B = "2".repeat(64);

function reviewed() {
  return beginRepairLineage({
    repository: "acme/example",
    pullRequest: 42,
    reviewedHeadSha: HEAD_A,
    findingsFingerprint: FINDINGS_A,
  });
}

function authorized() {
  return authorizeRepair(reviewed(), {
    actor: "repository-owner",
    commentId: 91,
    liveHeadSha: HEAD_A,
  });
}

function repaired() {
  return recordRepair(authorized(), {
    liveHeadSha: HEAD_A,
    repairCommitSha: HEAD_B,
    validation: { commands: [{ command: "npm test", exitCode: 0 }] },
  });
}

test("records review, authorization, validation, and repair as immutable lineage", () => {
  const lineage = repaired();
  assert.deepEqual(lineage.authorization, {
    actor: "repository-owner",
    commentId: 91,
    headSha: HEAD_A,
  });
  assert.deepEqual(lineage.repair, {
    attempt: 1,
    originalHeadSha: HEAD_A,
    commitSha: HEAD_B,
    validation: {
      passed: true,
      commands: [{ command: "npm test", exitCode: 0 }],
    },
  });
  assert.equal(Object.isFrozen(lineage.repair.validation.commands), true);
  assert.equal(repairLineageComplete(lineage), false);
});

test("rejects authorization or publication after the reviewed head moves", () => {
  assert.throws(
    () =>
      authorizeRepair(reviewed(), {
        actor: "repository-owner",
        commentId: 91,
        liveHeadSha: HEAD_B,
      }),
    /reviewed head is stale/,
  );
  assert.throws(
    () =>
      recordRepair(authorized(), {
        liveHeadSha: HEAD_B,
        repairCommitSha: "c".repeat(40),
        validation: { commands: [{ command: "npm test", exitCode: 0 }] },
      }),
    /authorized head is stale/,
  );
});

test("rejects failed validation and no-change repair claims", () => {
  assert.throws(
    () =>
      recordRepair(authorized(), {
        liveHeadSha: HEAD_A,
        repairCommitSha: HEAD_B,
        validation: { commands: [{ command: "npm test", exitCode: 1 }] },
      }),
    /validation did not pass/,
  );
  assert.throws(
    () =>
      recordRepair(authorized(), {
        liveHeadSha: HEAD_A,
        repairCommitSha: HEAD_A,
        validation: { commands: [{ command: "npm test", exitCode: 0 }] },
      }),
    /did not create a new head/,
  );
});

test("rejects forged lineage and tampered validation receipts", () => {
  assert.throws(
    () =>
      authorizeRepair(
        { review: { headSha: HEAD_A, findingsFingerprint: FINDINGS_A } },
        {
          actor: "repository-owner",
          commentId: 91,
          liveHeadSha: HEAD_A,
        },
      ),
    /invalid lineage/,
  );
  const tampered = structuredClone(repaired());
  tampered.repair.validation.commands[0].exitCode = 1;
  assert.throws(
    () =>
      recordRepairReReview(tampered, {
        reviewedHeadSha: HEAD_B,
        findingsFingerprint: FINDINGS_B,
        blocking: false,
      }),
    /validation did not pass/,
  );
  assert.throws(
    () => repairLineageComplete({ reReview: { blocking: false } }),
    /invalid lineage/,
  );
});

test("completes only after a non-blocking review of the repair commit", () => {
  assert.throws(
    () =>
      recordRepairReReview(repaired(), {
        reviewedHeadSha: HEAD_A,
        findingsFingerprint: FINDINGS_B,
        blocking: false,
      }),
    /does not match the repair commit/,
  );
  const blocking = recordRepairReReview(repaired(), {
    reviewedHeadSha: HEAD_B,
    findingsFingerprint: FINDINGS_B,
    blocking: true,
  });
  assert.equal(repairLineageComplete(blocking), false);
  const complete = recordRepairReReview(repaired(), {
    reviewedHeadSha: HEAD_B,
    findingsFingerprint: FINDINGS_B,
    blocking: false,
  });
  assert.equal(repairLineageComplete(complete), true);
});
