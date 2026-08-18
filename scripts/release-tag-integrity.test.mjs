import assert from "node:assert/strict";
import test from "node:test";
import { resolveReleaseTagCommit, verifyReleaseTag } from "./release-tag-integrity.mjs";

const COMMIT = "a".repeat(40);
const TAG_OBJECT = "b".repeat(40);
const NESTED_TAG_OBJECT = "c".repeat(40);

function fixture(responses) {
  const requested = [];
  return {
    requested,
    async fetchJson(endpoint) {
      requested.push(endpoint);
      assert.ok(Object.hasOwn(responses, endpoint), `unexpected endpoint ${endpoint}`);
      return structuredClone(responses[endpoint]);
    },
  };
}

test("resolves and verifies a lightweight release tag", async () => {
  const api = fixture({
    "repos/coryparrry/Codekeeper/git/ref/tags/codekeeper-v0.2.0": {
      ref: "refs/tags/codekeeper-v0.2.0",
      object: { type: "commit", sha: COMMIT },
    },
  });
  const result = await verifyReleaseTag({
    repository: "coryparrry/Codekeeper",
    tag: "codekeeper-v0.2.0",
    expectedCommit: COMMIT,
    fetchJson: api.fetchJson,
  });
  assert.deepEqual(result, {
    repository: "coryparrry/Codekeeper",
    tag: "codekeeper-v0.2.0",
    commit: COMMIT,
    verified: true,
  });
  assert.equal(api.requested.length, 1);
});

test("dereferences nested annotated tags deterministically", async () => {
  const api = fixture({
    "repos/coryparrry/Codekeeper/git/ref/tags/codekeeper-v0.2.0": {
      ref: "refs/tags/codekeeper-v0.2.0",
      object: { type: "tag", sha: TAG_OBJECT },
    },
    [`repos/coryparrry/Codekeeper/git/tags/${TAG_OBJECT}`]: {
      object: { type: "tag", sha: NESTED_TAG_OBJECT },
    },
    [`repos/coryparrry/Codekeeper/git/tags/${NESTED_TAG_OBJECT}`]: {
      object: { type: "commit", sha: COMMIT },
    },
  });
  assert.equal(
    await resolveReleaseTagCommit({
      repository: "coryparrry/Codekeeper",
      tag: "codekeeper-v0.2.0",
      fetchJson: api.fetchJson,
    }),
    COMMIT,
  );
  assert.equal(api.requested.length, 3);
});

test("rejects a release tag that moved to another commit", async () => {
  const api = fixture({
    "repos/coryparrry/Codekeeper/git/ref/tags/codekeeper-v0.2.0": {
      ref: "refs/tags/codekeeper-v0.2.0",
      object: { type: "commit", sha: "d".repeat(40) },
    },
  });
  await assert.rejects(
    verifyReleaseTag({
      repository: "coryparrry/Codekeeper",
      tag: "codekeeper-v0.2.0",
      expectedCommit: COMMIT,
      fetchJson: api.fetchJson,
    }),
    /resolves to d{40}, expected a{40}/,
  );
});

test("rejects annotated tag cycles", async () => {
  const api = fixture({
    "repos/coryparrry/Codekeeper/git/ref/tags/codekeeper-v0.2.0": {
      ref: "refs/tags/codekeeper-v0.2.0",
      object: { type: "tag", sha: TAG_OBJECT },
    },
    [`repos/coryparrry/Codekeeper/git/tags/${TAG_OBJECT}`]: {
      object: { type: "tag", sha: NESTED_TAG_OBJECT },
    },
    [`repos/coryparrry/Codekeeper/git/tags/${NESTED_TAG_OBJECT}`]: {
      object: { type: "tag", sha: TAG_OBJECT },
    },
  });
  await assert.rejects(
    resolveReleaseTagCommit({
      repository: "coryparrry/Codekeeper",
      tag: "codekeeper-v0.2.0",
      fetchJson: api.fetchJson,
    }),
    /contains a cycle/,
  );
});

test("rejects malformed release identities before GitHub access", async () => {
  let called = false;
  const fetchJson = async () => {
    called = true;
    return {};
  };
  await assert.rejects(
    verifyReleaseTag({
      repository: "not-a-repository",
      tag: "latest",
      expectedCommit: "short",
      fetchJson,
    }),
    /expected commit must be a full 40-character SHA/,
  );
  assert.equal(called, false);
});
