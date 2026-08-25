import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceLineageState,
  assertHumanDecision,
  assertIntentPreserved,
  assertLineageState,
  bindHumanDecision,
  createDecisionIdentity,
  createFindingLineage,
  createLineageState,
  createRepairAttempt,
  findingFingerprint,
  freezeIntent,
  lineageStateMarker,
  parseLineageStateMarker,
} from "../src/lib/orchestration/lineage.mjs";

const BASE = "a".repeat(40);
const FIRST_HEAD = "b".repeat(40);
const CURRENT_HEAD = "c".repeat(40);
const APP = { login: "codekeeper[bot]", id: "123" };
const SOURCE_DIGEST = `sha256:${"d".repeat(64)}`;

function source(kind, overrides = {}) {
  return {
    kind,
    ref: kind,
    digest: SOURCE_DIGEST,
    author: null,
    authority: null,
    ...overrides,
  };
}

function frozenIntent(overrides = {}, options) {
  return freezeIntent(
    {
      goal: "Keep retries deterministic",
      acceptanceCriteria: ["Retries stop at the configured limit"],
      explicitDecisions: ["Preserve the public retry contract"],
      nonGoals: ["Change provider selection"],
      authorizedPaths: ["tools/codekeeper/src/retry.mjs"],
      authorizedEffects: ["Correct retry accounting"],
      originalBaseSha: BASE,
      originalHeadSha: FIRST_HEAD,
      sourceRefs: [source("pr-body"), source("original-diff")],
      ...overrides,
    },
    options,
  );
}

function finding(intent, head = FIRST_HEAD) {
  return createFindingLineage({
    rootCause: "Retry attempts are counted after dispatch",
    owningPath: "tools/codekeeper/src/retry.mjs",
    behavior: "One extra retry is sent",
    intent,
    firstHeadSha: head,
    currentHeadSha: head,
    status: "unresolved",
  });
}

test("frozen intent binds canonical trusted provenance and rejects regeneration", () => {
  const intent = frozenIntent();
  const reordered = frozenIntent({
    sourceRefs: [source("original-diff"), source("pr-body")],
  });
  assert.equal(reordered.intentDigest, intent.intentDigest);
  assert.equal(Object.isFrozen(intent.sourceRefs), true);

  for (const kind of ["fixer-commit", "model-summary"]) {
    assert.throws(
      () => frozenIntent({ sourceRefs: [source(kind)] }),
      /kind is untrusted/,
    );
  }
  assert.throws(
    () => frozenIntent({ sourceRefs: [source("accepted-thread")] }),
    /verified maintainer authority/,
  );
  assert.doesNotThrow(() =>
    frozenIntent(
      {
        sourceRefs: [
          source("accepted-thread", {
            author: "Maintainer",
            authority: "repository-owner",
          }),
        ],
      },
      { authorizedMaintainers: ["maintainer"] },
    ),
  );

  const changed = frozenIntent({ goal: "Replace retry behavior" });
  assert.throws(
    () => assertIntentPreserved(intent, changed),
    /replacement changes frozen intent/,
  );
  assert.notEqual(
    frozenIntent({ sourceRefs: [source("linked-issue")] }).intentDigest,
    intent.intentDigest,
  );
  assert.throws(
    () => frozenIntent({ goal: "\uFDFA".repeat(8192) }),
    /bounded non-empty text/,
  );
});

test("finding identity survives wording, line, and path-alias movement", () => {
  const intent = frozenIntent();
  const input = {
    rootCause: "Retry attempts are counted after dispatch",
    owningPath: "tools/codekeeper/src/retry.mjs",
    behavior: "One extra retry is sent",
    intent,
  };
  const original = findingFingerprint({
    ...input,
    title: "Off by one",
    line: 12,
  });
  assert.equal(
    findingFingerprint({
      ...input,
      owningPath: "./tools/codekeeper/src/./retry.mjs",
      title: "Retry limit is exceeded",
      line: 400,
    }),
    original,
  );
  assert.notEqual(
    findingFingerprint({ ...input, rootCause: "Timeout state is reused" }),
    original,
  );
  assert.notEqual(
    findingFingerprint({
      ...input,
      intent: frozenIntent({ goal: "Remove retries" }),
    }),
    original,
  );
});

test("App-owned marker reload preserves monotonic finding and attempt history", () => {
  const intent = frozenIntent();
  const firstFinding = finding(intent);
  const firstAttempt = createRepairAttempt({
    findingId: firstFinding.findingId,
    intent,
    firstHeadSha: FIRST_HEAD,
  });
  const initial = createLineageState({
    intent,
    findings: [firstFinding],
    appOwnedThreadIds: ["PRRT_1"],
    attemptLinks: [firstAttempt],
  });
  const advanced = advanceLineageState(initial, {
    currentHeadSha: CURRENT_HEAD,
    status: "rereview-resolved",
    findingUpdates: [{ findingId: firstFinding.findingId, status: "resolved" }],
    appOwnedThreadIds: ["PRRT_2"],
    evidenceAdded: ["claim-resolution"],
    evidenceRetired: ["claim-old"],
  });
  const marker = lineageStateMarker(advanced, {
    intent,
    currentHeadSha: CURRENT_HEAD,
  });
  assert.ok(Buffer.byteLength(marker, "utf8") < 65536);
  const comment = {
    body: `Review lineage\n${marker}`,
    user: { login: APP.login, id: Number(APP.id), type: "Bot" },
  };
  const restored = parseLineageStateMarker(comment, {
    appIdentity: APP,
    intent,
    currentHeadSha: CURRENT_HEAD,
  });

  assert.equal(restored.firstHeadSha, FIRST_HEAD);
  assert.equal(restored.currentHeadSha, CURRENT_HEAD);
  assert.equal(restored.findings[0].findingId, firstFinding.findingId);
  assert.equal(restored.findings[0].firstHeadSha, FIRST_HEAD);
  assert.equal(restored.findings[0].status, "resolved");
  assert.deepEqual(restored.attemptLinks, [firstAttempt]);
  assert.deepEqual(restored.appOwnedThreadIds, ["PRRT_1", "PRRT_2"]);
  assert.deepEqual(restored.evidenceRetired, ["claim-old"]);

  assert.throws(
    () =>
      parseLineageStateMarker(
        { ...comment, user: { login: "person", id: 123, type: "User" } },
        { appIdentity: APP, intent, currentHeadSha: CURRENT_HEAD },
      ),
    /not App-owned/,
  );
  assert.throws(
    () => parseLineageStateMarker(comment, { appIdentity: APP }),
    /frozen intent|currentHeadSha/,
  );
  assert.throws(
    () =>
      parseLineageStateMarker(
        { ...comment, body: `${marker}\nforged suffix` },
        { appIdentity: APP, intent, currentHeadSha: CURRENT_HEAD },
      ),
    /not terminal/,
  );
});

test("lineage rejects stale heads, forged attempts, and destructive transitions", () => {
  const intent = frozenIntent();
  const firstFinding = finding(intent);
  assert.throws(
    () => createLineageState({ intent, currentHeadSha: CURRENT_HEAD }),
    /initial lineage head/,
  );
  assert.throws(
    () =>
      createLineageState({
        intent,
        findings: [firstFinding],
        attemptLinks: [
          {
            attemptId: `repair-attempt-${"e".repeat(64)}`,
            findingId: firstFinding.findingId,
            intentDigest: intent.intentDigest,
            firstHeadSha: FIRST_HEAD,
            attemptNumber: 1,
          },
        ],
      }),
    /attempt ID is forged/,
  );
  assert.throws(
    () =>
      createLineageState({
        intent,
        findings: [{ ...firstFinding, firstHeadSha: BASE }],
      }),
    /initial lineage children/,
  );

  const state = createLineageState({ intent, findings: [firstFinding] });
  assert.throws(
    () => assertLineageState({ ...state, firstHeadSha: BASE }, { intent }),
    /first head is not bound|state digest is forged/,
  );
  assert.throws(
    () =>
      advanceLineageState(state, {
        currentHeadSha: CURRENT_HEAD,
        findingUpdates: [{ findingId: "finding-unknown", status: "resolved" }],
      }),
    /unknown lineage/,
  );
  const advanced = advanceLineageState(state, {
    currentHeadSha: CURRENT_HEAD,
  });
  assert.equal(advanced.findings.length, 1);
  assert.equal(advanced.findings[0].findingId, firstFinding.findingId);
  assert.throws(
    () =>
      advanceLineageState(state, {
        currentHeadSha: CURRENT_HEAD,
        findings: [],
      }),
    /unexpected properties/,
  );
});

test("human answers require trusted App context, author authority, and exact head", () => {
  const intent = frozenIntent();
  const decision = createDecisionIdentity({
    category: "behavior-change",
    question: "May this change the public retry limit?",
    intent,
  });
  const authorizedAuthors = [
    { login: "Maintainer", authority: "repository-owner" },
  ];
  const answer = bindHumanDecision({
    decision,
    author: "Maintainer",
    response: "Preserve the existing public behavior.",
    currentHeadSha: CURRENT_HEAD,
    authorizedAuthors,
    appIdentity: APP,
  });
  assert.deepEqual(
    assertHumanDecision(answer, {
      decision,
      currentHeadSha: CURRENT_HEAD,
      authorizedAuthors,
      appIdentity: APP,
    }),
    answer,
  );
  assert.throws(
    () => assertHumanDecision(answer, { decision, authorizedAuthors }),
    /App identity|currentHeadSha/,
  );
  assert.throws(
    () =>
      assertHumanDecision(answer, {
        decision,
        currentHeadSha: FIRST_HEAD,
        authorizedAuthors,
        appIdentity: APP,
      }),
    /stale head/,
  );
  assert.throws(
    () =>
      bindHumanDecision({
        decision,
        author: "outsider",
        response: "Change it",
        currentHeadSha: CURRENT_HEAD,
        authorizedAuthors,
        appIdentity: APP,
      }),
    /not authorized/,
  );
  assert.throws(
    () =>
      bindHumanDecision({
        decision,
        author: APP.login,
        response: "Waive it",
        currentHeadSha: CURRENT_HEAD,
        authorizedAuthors: [APP.login],
        appIdentity: APP,
      }),
    /App-authored decision/,
  );
  const changed = createDecisionIdentity({
    category: "behavior-change",
    question: "May this remove retries entirely?",
    intent,
  });
  assert.throws(
    () =>
      assertHumanDecision(answer, {
        decision: changed,
        currentHeadSha: CURRENT_HEAD,
        authorizedAuthors,
        appIdentity: APP,
      }),
    /fingerprint is stale/,
  );
});
