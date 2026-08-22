import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../src/lib/markers.mjs";
import { advanceEnvelope, assertEnvelope, createEnvelope, envelopeBytes, envelopeSha256, parseEnvelope } from "../src/lib/orchestration/envelope.mjs";
import {
  HANDOFF_ENVELOPE_FILE,
  HANDOFF_MANIFEST_FILE,
  assertHandoffManifest,
  collectHandoffInventory,
  createHandoff,
  handoffInventoryDigest,
  verifyHandoff,
} from "../src/lib/orchestration/handoff.mjs";

const digest = (letter) => letter.repeat(64);
const baseInput = {
  mode: "fix",
  run: { repository: "owner/repository", runId: "123456", attempt: 1 },
  package: {
    name: "@coryparry/codekeeper",
    version: "0.4.0",
    integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    sourceCommit: "a".repeat(40),
  },
  request: {
    eventName: "issue_comment",
    targetNumber: 197,
    requestedBy: "coryparry",
  },
  repository: {
    defaultBranch: "main",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
  },
  digests: {
    modePlan: digest("1"),
    policy: digest("2"),
    profile: digest("3"),
    context: digest("4"),
  },
};

function rawPayloads(includeValidation = false) {
  const values = {
    "mode-plan.json": "mode-plan",
    "policy.json": "policy",
    "profile.json": "profile",
    "context.json": "context",
    "workspace-result.json": "workspace",
    "candidate.json": "candidate",
  };
  if (includeValidation) values["validation-receipt.json"] = "validation";
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, Buffer.from(value)]));
}

function computeEnvelope() {
  const values = rawPayloads();
  const digests = {
    modePlan: sha256(values["mode-plan.json"]),
    policy: sha256(values["policy.json"]),
    profile: sha256(values["profile.json"]),
    context: sha256(values["context.json"]),
  };
  return advanceEnvelope(createEnvelope({ ...baseInput, digests }), "compute-complete", {
    digests: {
      workspaceResult: sha256(values["workspace-result.json"]),
      candidate: sha256(values["candidate.json"]),
    },
  });
}

function validationEnvelope() {
  const values = rawPayloads(true);
  return advanceEnvelope(computeEnvelope(), "validation-complete", {
    validationRequired: true,
    digests: { validationReceipt: sha256(values["validation-receipt.json"]) },
  });
}

function noValidationEnvelope() {
  return advanceEnvelope(computeEnvelope(), "validation-not-required", {
    validationRequired: false,
  });
}

function sealedEnvelope() {
  return advanceEnvelope(validationEnvelope(), "sealed");
}

function canonical(value) {
  return `${JSON.stringify(value)}\n`;
}

function expectedFiles(envelope, extras = []) {
  const files = [HANDOFF_ENVELOPE_FILE, "candidate.json", "context.json", "mode-plan.json", "policy.json", "profile.json", "workspace-result.json", ...extras];
  if (envelope.digests.validationReceipt) files.push("validation-receipt.json");
  return [...new Set(files)].sort();
}

async function trustedOptions(directory, envelope, kind, extras = []) {
  const manifestBytes = await readFile(path.join(directory, HANDOFF_MANIFEST_FILE));
  return {
    directory,
    expectedEnvelope: envelope,
    expectedKind: kind,
    expectedManifestSha256: sha256(manifestBytes),
    expectedFiles: expectedFiles(envelope, extras),
  };
}

async function trustedVerify(directory, envelope, kind, extras = []) {
  return verifyHandoff(await trustedOptions(directory, envelope, kind, extras));
}

async function rewriteManifest(directory, mutate) {
  const manifestPath = path.join(directory, HANDOFF_MANIFEST_FILE);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(manifest);
  await writeFile(manifestPath, canonical(manifest));
}

async function createValidHandoff(envelope = computeEnvelope(), kind = "compute", options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  await createHandoff({
    directory,
    envelope,
    kind,
    files: payloads(envelope),
    ...options,
  });
  return directory;
}

function payloads(envelope) {
  return rawPayloads(Boolean(envelope.digests.validationReceipt));
}

test("envelopes use an exact closed schema and canonical bytes", () => {
  const envelope = createEnvelope(baseInput);
  assert.equal(parseEnvelope(envelopeBytes(envelope)).mode, "fix");
  assert.match(envelopeSha256(envelope), /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.run), true);
  assert.throws(() => {
    envelope.mode = "review";
  }, TypeError);
  assert.throws(() => assertEnvelope({ ...envelope, extra: true }), /unexpected or missing/);
  assert.throws(
    () =>
      parseEnvelope(
        JSON.stringify({
          ...envelope,
          package: { ...envelope.package, name: "codekeeper" },
        }),
      ),
    /must be/,
  );
});

test("envelope construction cannot skip the created state or override its schema", () => {
  for (const state of ["created", "compute-complete", "sealed", "published"]) {
    assert.throws(
      () => createEnvelope({ ...baseInput, state }),
      /cannot override state or schemaVersion/,
    );
  }
  assert.throws(
    () => createEnvelope({ ...baseInput, schemaVersion: 2 }),
    /cannot override state or schemaVersion/,
  );
});

test("envelope validation rejects malformed fields, unknown fields, and prototype tricks", () => {
  const cases = [
    [
      "schema",
      (value) => {
        value.schemaVersion = 2;
      },
    ],
    [
      "state",
      (value) => {
        value.state = "skipped";
      },
    ],
    [
      "mode",
      (value) => {
        value.mode = "../fix";
      },
    ],
    [
      "run repository",
      (value) => {
        value.run.repository = "owner";
      },
    ],
    [
      "run id",
      (value) => {
        value.run.runId = "";
      },
    ],
    [
      "run attempt",
      (value) => {
        value.run.attempt = 0;
      },
    ],
    [
      "package name",
      (value) => {
        value.package.name = "codekeeper";
      },
    ],
    [
      "package version",
      (value) => {
        value.package.version = "latest";
      },
    ],
    [
      "package integrity",
      (value) => {
        value.package.integrity = "sha256-bad";
      },
    ],
    [
      "package source",
      (value) => {
        value.package.sourceCommit = "short";
      },
    ],
    [
      "request event",
      (value) => {
        value.request.eventName = "IssueComment";
      },
    ],
    [
      "request target",
      (value) => {
        value.request.targetNumber = 0;
      },
    ],
    [
      "request user",
      (value) => {
        value.request.requestedBy = "bad\nuser";
      },
    ],
    [
      "repository branch",
      (value) => {
        value.repository.defaultBranch = "../main";
      },
    ],
    [
      "repository base",
      (value) => {
        value.repository.baseSha = "short";
      },
    ],
    [
      "repository head",
      (value) => {
        value.repository.headSha = "short";
      },
    ],
    [
      "digest",
      (value) => {
        value.digests.modePlan = "bad";
      },
    ],
    [
      "unknown top field",
      (value) => {
        value.unknown = true;
      },
    ],
    [
      "unknown nested field",
      (value) => {
        value.run.unknown = true;
      },
    ],
    [
      "unknown digest field",
      (value) => {
        value.digests.unknown = true;
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const invalid = structuredClone(baseInput);
    mutate(invalid);
    assert.throws(() => createEnvelope(invalid), /invalid|unexpected|missing|must be|unsupported|unknown|override/i, name);
  }
  const prototypeEnvelope = structuredClone(baseInput);
  prototypeEnvelope.run = Object.assign(Object.create({ polluted: true }), prototypeEnvelope.run);
  assert.throws(() => createEnvelope(prototypeEnvelope), /plain object/);
  const nullPrototype = structuredClone(baseInput);
  nullPrototype.digests = Object.assign(Object.create(null), nullPrototype.digests);
  assert.throws(() => createEnvelope(nullPrototype), /plain object/);
});

test("every post-created state requires every core digest", () => {
  const states = ["compute-complete", "validation-complete", "validation-not-required", "sealed", "published"];
  for (const state of states) {
    for (const key of ["modePlan", "policy", "profile", "context", "workspaceResult", "candidate"]) {
      const invalid = structuredClone(computeEnvelope());
      invalid.state = state;
      invalid.digests[key] = null;
      if (state === "validation-complete") invalid.digests.validationReceipt = digest("7");
      if (state === "validation-not-required") invalid.digests.validationReceipt = null;
      assert.throws(() => assertEnvelope(invalid), /requires/, `${state}.${key}`);
    }
  }
});

test("envelope transitions are monotonic and bind stage outputs", () => {
  const created = createEnvelope(baseInput);
  const compute = computeEnvelope();
  assert.equal(compute.state, "compute-complete");
  assert.throws(() => advanceEnvelope(created, "sealed"), /Invalid run envelope transition/);
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-complete", {
        validationRequired: true,
        digests: { validationReceipt: null },
      }),
    /requires a validation receipt/,
  );
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-not-required", {
        validationRequired: false,
        digests: { validationReceipt: digest("8") },
      }),
    /does not allow/,
  );
  const sealed = advanceEnvelope(validationEnvelope(), "sealed", {
    digests: {},
  });
  assert.equal(sealed.state, "sealed");
  assert.equal(advanceEnvelope(sealed, "published").state, "published");
  assert.throws(() => advanceEnvelope(sealed, "compute-complete"), /Invalid run envelope transition/);
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-not-required", {
        validationRequired: false,
        digests: { modePlan: digest("9") },
      }),
    /does not allow/,
  );
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-complete", {
        digests: { validationReceipt: digest("8") },
      }),
    /explicit validationRequired/,
  );
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-complete", {
        validationRequired: false,
        digests: { validationReceipt: digest("8") },
      }),
    /does not match/,
  );
  assert.equal(
    advanceEnvelope(compute, "validation-not-required", {
      validationRequired: false,
    }).state,
    "validation-not-required",
  );
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-not-required", {
        validationRequired: true,
      }),
    /does not match/,
  );
  assert.throws(
    () =>
      advanceEnvelope(validationEnvelope(), "sealed", {
        validationRequired: true,
      }),
    /only valid/,
  );
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-complete", {
        validationRequired: true,
        digests: null,
      }),
    /plain object/,
  );
  assert.throws(
    () =>
      advanceEnvelope(created, "compute-complete", {
        digests: { modePlan: created.digests.modePlan },
      }),
    /does not allow/,
  );
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-complete", {
        validationRequired: true,
        digests: {
          candidate: compute.digests.candidate,
          validationReceipt: digest("8"),
        },
      }),
    /does not allow/,
  );
  assert.throws(
    () =>
      advanceEnvelope(compute, "validation-not-required", {
        validationRequired: false,
        digests: { validationReceipt: null },
      }),
    /does not allow/,
  );
  const noValidation = advanceEnvelope(compute, "validation-not-required", {
    validationRequired: false,
  });
  assert.throws(
    () =>
      advanceEnvelope(noValidation, "sealed", {
        digests: { validationReceipt: digest("8") },
      }),
    /does not allow/,
  );
  assert.throws(
    () =>
      advanceEnvelope(validationEnvelope(), "sealed", {
        digests: { validationReceipt: digest("8") },
      }),
    /does not allow/,
  );
  const sealedForPublish = advanceEnvelope(validationEnvelope(), "sealed");
  assert.throws(
    () =>
      advanceEnvelope(sealedForPublish, "published", {
        digests: { candidate: sealedForPublish.digests.candidate },
      }),
    /does not allow/,
  );
});

test("handoff creation and verification bind exact files, state, run, and package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  const envelope = computeEnvelope();
  const created = await createHandoff({
    directory,
    envelope,
    kind: "compute",
    files: payloads(envelope),
  });
  assert.equal(created.manifest.state, "compute-complete");
  assert.equal(Object.isFrozen(created.manifest), true);
  assert.equal(Object.isFrozen(created.manifest.files), true);
  assert.equal(created.manifest.files.find(({ path: filePath }) => filePath === "candidate.json").bytes, payloads(envelope)["candidate.json"].byteLength);
  const verified = await trustedVerify(directory, envelope, "compute");
  assert.equal(verified.envelopeSha256, created.envelopeSha256);
  assert.deepEqual(
    verified.files.map(({ path: filePath }) => filePath),
    ["candidate.json", "context.json", HANDOFF_ENVELOPE_FILE, "mode-plan.json", "policy.json", "profile.json", "workspace-result.json"],
  );
  assert.equal((await readFile(path.join(directory, HANDOFF_MANIFEST_FILE), "utf8")).endsWith("\n"), true);
});

test("validation-complete handoffs require the receipt and reject a replayed run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  const envelope = validationEnvelope();
  await createHandoff({
    directory,
    envelope,
    kind: "validation",
    files: payloads(envelope),
  });
  await assert.doesNotReject(trustedVerify(directory, envelope, "validation"));
  const replay = structuredClone(envelope);
  replay.run.runId = "different-run";
  await assert.rejects(trustedVerify(directory, replay, "validation"), /does not match/);
});

test("trusted verification requires an anchored manifest and exact options", async () => {
  const envelope = computeEnvelope();
  const directory = await createValidHandoff(envelope);
  const options = await trustedOptions(directory, envelope, "compute");
  assert.ok(Buffer.isBuffer(await readFile(path.join(directory, HANDOFF_MANIFEST_FILE))));
  const manifestHash = options.expectedManifestSha256;
  assert.match(manifestHash, /^[a-f0-9]{64}$/);
  await assert.doesNotReject(verifyHandoff(options));
  await assert.rejects(verifyHandoff(directory), /plain object/);
  const missing = { ...options };
  delete missing.expectedFiles;
  await assert.rejects(verifyHandoff(missing), /unexpected or missing/);
  await assert.rejects(verifyHandoff({ ...options, typo: true }), /unexpected or missing/);

  const manifestBeforeRewrite = await readFile(path.join(directory, HANDOFF_MANIFEST_FILE));
  await writeFile(path.join(directory, HANDOFF_MANIFEST_FILE), Buffer.concat([manifestBeforeRewrite, Buffer.from("\n")]));
  await assert.rejects(verifyHandoff(options), /manifest digest/);

  const reorderedEnvelopeDirectory = await createValidHandoff(envelope);
  const envelopeObject = JSON.parse(await readFile(path.join(reorderedEnvelopeDirectory, HANDOFF_ENVELOPE_FILE), "utf8"));
  const reorderedEnvelope = Object.fromEntries(Object.entries(envelopeObject).reverse());
  await writeFile(path.join(reorderedEnvelopeDirectory, HANDOFF_ENVELOPE_FILE), `${JSON.stringify(reorderedEnvelope)}\n`);
  await assert.rejects(trustedVerify(reorderedEnvelopeDirectory, envelope, "compute"), /canonical schema order/);

  const missingNewlineDirectory = await createValidHandoff(envelope);
  const canonicalEnvelope = JSON.parse(await readFile(path.join(missingNewlineDirectory, HANDOFF_ENVELOPE_FILE), "utf8"));
  await writeFile(path.join(missingNewlineDirectory, HANDOFF_ENVELOPE_FILE), JSON.stringify(canonicalEnvelope));
  await assert.rejects(trustedVerify(missingNewlineDirectory, envelope, "compute"), /canonical schema order/);

  const reorderedManifestDirectory = await createValidHandoff(envelope);
  const manifestObject = JSON.parse(await readFile(path.join(reorderedManifestDirectory, HANDOFF_MANIFEST_FILE), "utf8"));
  const reorderedManifest = Object.fromEntries(Object.entries(manifestObject).reverse());
  const reorderedManifestBytes = Buffer.from(canonical(reorderedManifest));
  await writeFile(path.join(reorderedManifestDirectory, HANDOFF_MANIFEST_FILE), reorderedManifestBytes);
  await assert.rejects(
    verifyHandoff({
      ...(await trustedOptions(reorderedManifestDirectory, envelope, "compute")),
      expectedManifestSha256: sha256(reorderedManifestBytes),
    }),
    /canonical form/,
  );

  const anchoredRewriteDirectory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  const created = await createHandoff({
    directory: anchoredRewriteDirectory,
    envelope,
    kind: "compute",
    files: payloads(envelope),
  });
  const anchoredManifest = JSON.parse(await readFile(path.join(anchoredRewriteDirectory, HANDOFF_MANIFEST_FILE), "utf8"));
  const extraBytes = Buffer.from("rewritten payload");
  await writeFile(path.join(anchoredRewriteDirectory, "rewritten.txt"), extraBytes);
  anchoredManifest.files.push({
    path: "rewritten.txt",
    bytes: extraBytes.byteLength,
    sha256: sha256(extraBytes),
  });
  anchoredManifest.files.sort((left, right) => left.path.localeCompare(right.path));
  anchoredManifest.inventorySha256 = handoffInventoryDigest(anchoredManifest.files);
  await writeFile(path.join(anchoredRewriteDirectory, HANDOFF_MANIFEST_FILE), canonical(anchoredManifest));
  await assert.rejects(
    verifyHandoff({
      directory: anchoredRewriteDirectory,
      expectedEnvelope: envelope,
      expectedKind: "compute",
      expectedManifestSha256: created.manifestSha256,
      expectedFiles: expectedFiles(envelope, ["rewritten.txt"]),
    }),
    /manifest digest/,
  );
});

test("all handoff kinds preserve their state contract, including same-run retries", async () => {
  const cases = [
    ["compute", computeEnvelope(), "compute-complete"],
    ["validation", noValidationEnvelope(), "validation-not-required"],
    ["validation", validationEnvelope(), "validation-complete"],
    ["sealed", sealedEnvelope(), "sealed"],
  ];
  for (const [kind, envelope, state] of cases) {
    const directory = await createValidHandoff(envelope, kind);
    const first = await trustedVerify(directory, envelope, kind);
    const retry = await trustedVerify(directory, envelope, kind);
    assert.equal(retry.inventorySha256, first.inventorySha256);
  }
  const noValidationSealed = advanceEnvelope(noValidationEnvelope(), "sealed");
  assert.equal(advanceEnvelope(noValidationSealed, "published").state, "published");
  const invalid = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  await assert.rejects(
    createHandoff({
      directory: invalid,
      envelope: sealedEnvelope(),
      kind: "compute",
      files: payloads(sealedEnvelope()),
    }),
    /cannot carry/,
  );
});

test("each bound payload digest independently rejects stale bytes", async () => {
  const paths = [
    ["modePlan", "mode-plan.json"],
    ["policy", "policy.json"],
    ["profile", "profile.json"],
    ["context", "context.json"],
    ["workspaceResult", "workspace-result.json"],
    ["candidate", "candidate.json"],
  ];
  for (const [name, relativePath] of paths) {
    const envelope = computeEnvelope();
    const directory = await createValidHandoff(envelope);
    await writeFile(path.join(directory, relativePath), Buffer.from(`tampered-${name}`));
    await assert.rejects(trustedVerify(directory, envelope, "compute"), /inventory|digest|stale/);
  }
  const validation = validationEnvelope();
  const receiptDirectory = await createValidHandoff(validation, "validation");
  await writeFile(path.join(receiptDirectory, "validation-receipt.json"), "tampered-receipt");
  await assert.rejects(trustedVerify(receiptDirectory, validation, "validation"), /inventory|digest|stale/);

  const receiptEnvelopeDirectory = await createValidHandoff(validation, "validation");
  const receiptEnvelope = JSON.parse(await readFile(path.join(receiptEnvelopeDirectory, HANDOFF_ENVELOPE_FILE), "utf8"));
  receiptEnvelope.digests.validationReceipt = digest("e");
  await writeFile(path.join(receiptEnvelopeDirectory, HANDOFF_ENVELOPE_FILE), canonical(receiptEnvelope));
  await assert.rejects(trustedVerify(receiptEnvelopeDirectory, validation, "validation"), /envelope does not match|envelope digest|stale/);
});

test("envelope and manifest tampering cannot be repaired without the trusted digest", async () => {
  for (const key of ["modePlan", "policy", "profile", "context", "workspaceResult", "candidate"]) {
    const envelope = computeEnvelope();
    const directory = await createValidHandoff(envelope);
    const onDisk = JSON.parse(await readFile(path.join(directory, HANDOFF_ENVELOPE_FILE), "utf8"));
    onDisk.digests[key] = digest("f");
    await writeFile(path.join(directory, HANDOFF_ENVELOPE_FILE), canonical(onDisk));
    await assert.rejects(trustedVerify(directory, envelope, "compute"), /envelope digest|does not match|stale/);
  }
  const fields = [
    [
      "envelope hash",
      (manifest) => {
        manifest.envelopeSha256 = digest("f");
      },
    ],
    [
      "inventory hash",
      (manifest) => {
        manifest.inventorySha256 = digest("f");
      },
    ],
    [
      "file bytes",
      (manifest) => {
        manifest.files[0].bytes += 1;
      },
    ],
    [
      "file digest",
      (manifest) => {
        manifest.files[0].sha256 = digest("f");
      },
    ],
    [
      "wrong run",
      (manifest) => {
        manifest.run.runId = "other-run";
      },
    ],
    [
      "wrong attempt",
      (manifest) => {
        manifest.run.attempt = 2;
      },
    ],
    [
      "wrong state",
      (manifest) => {
        manifest.state = "sealed";
      },
    ],
    [
      "wrong kind",
      (manifest) => {
        manifest.kind = "sealed";
      },
    ],
    [
      "unknown top field",
      (manifest) => {
        manifest.extra = true;
      },
    ],
    [
      "unknown run field",
      (manifest) => {
        manifest.run.extra = true;
      },
    ],
    [
      "unknown file field",
      (manifest) => {
        manifest.files[0].extra = true;
      },
    ],
    [
      "duplicate",
      (manifest) => {
        manifest.files.push(structuredClone(manifest.files[0]));
      },
    ],
    [
      "unsorted",
      (manifest) => {
        manifest.files.reverse();
      },
    ],
  ];
  for (const [name, mutate] of fields) {
    const directory = await createValidHandoff();
    await rewriteManifest(directory, mutate);
    await assert.rejects(
      trustedVerify(directory, computeEnvelope(), "compute"),
      /manifest|mismatch|stale|unexpected|duplicate|sorted|does not match|cannot carry|digest/,
      name,
    );
  }
});

test("handoff file sets reject missing, extra, duplicate, and optional patch drift", async () => {
  const missing = await createValidHandoff();
  await rm(path.join(missing, "candidate.json"));
  await assert.rejects(trustedVerify(missing, computeEnvelope(), "compute"), /manifest|mismatch|missing|digest/);

  const extra = await createValidHandoff();
  await writeFile(path.join(extra, "unexpected.json"), "unexpected");
  await assert.rejects(trustedVerify(extra, computeEnvelope(), "compute"), /manifest|mismatch|unexpected/);

  const withPatch = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  const envelope = computeEnvelope();
  const expectedFiles = [
    "candidate.json",
    "context.json",
    HANDOFF_ENVELOPE_FILE,
    "mode-plan.json",
    "patch.diff",
    "policy.json",
    "profile.json",
    "workspace-result.json",
  ];
  await createHandoff({
    directory: withPatch,
    envelope,
    kind: "compute",
    files: { ...payloads(envelope), "patch.diff": Buffer.from("patch") },
    expectedFiles,
  });
  await assert.doesNotReject(trustedVerify(withPatch, envelope, "compute", ["patch.diff"]));
});

test("unsafe paths, hidden entries, links, empty directories, and special files fail closed", async () => {
  for (const relativePath of ["/absolute", "./dot", "a/../b", "a\\b", "a\u0000b", ".hidden/file", "a/.hidden"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
    await assert.rejects(
      createHandoff({
        directory,
        envelope: computeEnvelope(),
        kind: "compute",
        files: { [relativePath]: "bad" },
      }),
      /unsafe/,
    );
  }
  const fileLink = await createValidHandoff();
  await symlink("/etc/hosts", path.join(fileLink, "linked-file"));
  await assert.rejects(trustedVerify(fileLink, computeEnvelope(), "compute"), /symlinks|regular/);

  const directoryLink = await createValidHandoff();
  await symlink(os.tmpdir(), path.join(directoryLink, "linked-directory"));
  await assert.rejects(trustedVerify(directoryLink, computeEnvelope(), "compute"), /symlinks|regular/);
  const rootLinkTarget = await createValidHandoff();
  const rootLink = `${rootLinkTarget}-alias`;
  await symlink(rootLinkTarget, rootLink);
  await assert.rejects(trustedVerify(rootLink, computeEnvelope(), "compute"), /root|regular/);
  const createRootTarget = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  const createRootLink = `${createRootTarget}-alias`;
  await symlink(createRootTarget, createRootLink);
  await assert.rejects(
    createHandoff({
      directory: createRootLink,
      envelope: computeEnvelope(),
      kind: "compute",
      files: payloads(computeEnvelope()),
    }),
    /root|regular/,
  );

  const emptyDirectory = await createValidHandoff();
  await mkdir(path.join(emptyDirectory, "empty"));
  await assert.rejects(trustedVerify(emptyDirectory, computeEnvelope(), "compute"), /empty directory/);

  const reservedEnvelope = await createValidHandoff();
  await rm(path.join(reservedEnvelope, HANDOFF_ENVELOPE_FILE));
  await symlink("/etc/hosts", path.join(reservedEnvelope, HANDOFF_ENVELOPE_FILE));
  await assert.rejects(trustedVerify(reservedEnvelope, computeEnvelope(), "compute"), /regular/);
  const reservedManifest = await createValidHandoff();
  await rm(path.join(reservedManifest, HANDOFF_MANIFEST_FILE));
  await symlink("/etc/hosts", path.join(reservedManifest, HANDOFF_MANIFEST_FILE));
  await assert.rejects(trustedVerify(reservedManifest, computeEnvelope(), "compute"), /regular/);

  const socketDirectory = await createValidHandoff();
  const socketPath = path.join(socketDirectory, "socket-entry");
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return;
    throw error;
  }
  try {
    await assert.rejects(trustedVerify(socketDirectory, computeEnvelope(), "compute"), /regular|only regular/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(socketPath, { force: true });
  }
});

test("handoff identity checks reject wrong run, attempt, state, package, and source", async () => {
  const envelope = computeEnvelope();
  const directory = await createValidHandoff(envelope);
  const options = await trustedOptions(directory, envelope, "compute");
  const wrongRun = structuredClone(envelope);
  wrongRun.run.runId = "wrong";
  await assert.rejects(verifyHandoff({ ...options, expectedEnvelope: wrongRun }), /envelope/);
  const wrongAttempt = structuredClone(envelope);
  wrongAttempt.run.attempt = 2;
  await assert.rejects(verifyHandoff({ ...options, expectedEnvelope: wrongAttempt }), /envelope/);
  const wrongState = structuredClone(envelope);
  wrongState.state = "validation-not-required";
  await assert.rejects(verifyHandoff({ ...options, expectedEnvelope: wrongState }), /envelope|requires/);
  await assert.rejects(verifyHandoff({ ...options, expectedKind: "sealed" }), /kind/);
  const wrongPackage = structuredClone(envelope);
  wrongPackage.package.version = "9.9.9";
  await assert.rejects(verifyHandoff({ ...options, expectedEnvelope: wrongPackage }), /envelope/);
  const wrongSource = structuredClone(envelope);
  wrongSource.package.sourceCommit = "d".repeat(40);
  await assert.rejects(verifyHandoff({ ...options, expectedEnvelope: wrongSource }), /envelope/);
});

test("inventory ordering is deterministic and manifest outputs are immutable", async () => {
  const envelope = computeEnvelope();
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  const files = payloads(envelope);
  const reversed = Object.fromEntries(Object.entries(files).reverse());
  const created = await createHandoff({
    directory,
    envelope,
    kind: "compute",
    files: reversed,
  });
  assert.deepEqual(
    created.manifest.files.map(({ path: filePath }) => filePath),
    [...created.manifest.files.map(({ path: filePath }) => filePath)].sort(),
  );
  assert.throws(() => {
    created.manifest.files[0].path = "changed";
  }, TypeError);
  const verified = await trustedVerify(directory, envelope, "compute");
  assert.equal(Object.isFrozen(verified.envelope), true);
  assert.equal(Object.isFrozen(verified.manifest), true);
});

test("manifest validators reject non-plain nested objects and unknown schema properties", async () => {
  const envelope = computeEnvelope();
  const directory = await createValidHandoff(envelope);
  const manifest = JSON.parse(await readFile(path.join(directory, HANDOFF_MANIFEST_FILE), "utf8"));
  const prototypeManifest = Object.assign(Object.create({ polluted: true }), manifest);
  assert.throws(() => assertHandoffManifest(prototypeManifest, envelope), /plain object/);
  const prototypeFile = structuredClone(manifest);
  prototypeFile.files[0] = Object.assign(Object.create({ polluted: true }), prototypeFile.files[0]);
  assert.throws(() => assertHandoffManifest(prototypeFile, envelope), /plain object/);
  const prototypeFiles = structuredClone(manifest);
  Object.setPrototypeOf(prototypeFiles.files, { polluted: true });
  assert.throws(() => assertHandoffManifest(prototypeFiles, envelope), /plain array/);
  const unknown = structuredClone(manifest);
  unknown.files[0].extra = true;
  assert.throws(() => assertHandoffManifest(unknown, envelope), /unexpected/);
});

test("handoffs reject tampering, extra files, unsafe paths, links, and special entries", async (t) => {
  const cases = [
    ["extra file", async (directory) => writeFile(path.join(directory, "unexpected.json"), "x"), /inventory mismatch/],
    [
      "unsafe payload",
      async (directory, envelope) =>
        createHandoff({
          directory: path.join(directory, "unsafe"),
          envelope,
          kind: "compute",
          files: { "../escape": "x" },
        }),
      /unsafe/,
    ],
    ["symlink", async (directory) => symlink("/etc/hosts", path.join(directory, "linked.json")), /symlinks/],
    ["digest", async (directory) => writeFile(path.join(directory, "candidate.json"), "changed"), /digest|stale/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
      const envelope = computeEnvelope();
      await createHandoff({
        directory,
        envelope,
        kind: "compute",
        files: payloads(envelope),
      });
      if (name === "unsafe payload") {
        await assert.rejects(mutate(directory, envelope), expected);
      } else {
        await mutate(directory, envelope);
        await assert.rejects(trustedVerify(directory, envelope, "compute"), expected);
      }
    });
  }
});

test("inventory rejects hidden, backslash, NUL, duplicate, and special entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codekeeper-handoff-"));
  await mkdir(path.join(directory, ".hidden"));
  await assert.rejects(collectHandoffInventory(directory), /unsafe/);
});
