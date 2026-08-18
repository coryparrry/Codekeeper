import assert from "node:assert/strict";
import test from "node:test";
import { validateDocumentationSources } from "./documentation-contract.mjs";

const valid = Object.freeze({
  readme: `Codekeeper is intentionally unpublished.
npm exec --package /absolute/path/to/codekeeper.tgz -- codekeeper init
| Same repository, draft | Report-only | Off |`,
  install: "The current E404 boundary uses a local, verified tarball.",
  wikiReadme: "This is a non-authoritative snapshot from 0123456789abcdef0123456789abcdef01234567.",
  wikiInstructions: "Generate a non-authoritative snapshot. Do not invent installation commands.",
  wikiMetadata: JSON.stringify({
    updatedAt: "2026-08-16T20:57:16.582Z",
    gitHead: "0123456789abcdef0123456789abcdef01234567",
    status: "complete"
  })
});

test("valid unpublished documentation and wiki evidence pass", () => {
  assert.deepEqual(validateDocumentationSources(valid), {
    valid: true,
    wikiSourceCommit: "0123456789abcdef0123456789abcdef01234567"
  });
});

test("public npm claims and internal image placeholders are rejected", () => {
  for (const fragment of [
    "npx codekeeper init",
    "https://www.npmjs.com/package/codekeeper",
    "https://img.shields.io/npm/v/codekeeper",
    "CLI IMAGE: Guided setup"
  ]) {
    assert.throws(
      () => validateDocumentationSources({ ...valid, readme: `${valid.readme}\n${fragment}` }),
      /forbidden unpublished or placeholder content/
    );
  }
});

test("OpenWiki status must match its exact source commit", () => {
  assert.throws(
    () => validateDocumentationSources({
      ...valid,
      wikiReadme: "This is a non-authoritative snapshot from another commit."
    }),
    /bind its source commit/
  );
  assert.throws(
    () => validateDocumentationSources({
      ...valid,
      wikiMetadata: JSON.stringify({ updatedAt: "invalid", gitHead: "short", status: "partial" })
    }),
    /complete timestamped source commit/
  );
});

test("draft review support cannot regress to an unsupported claim", () => {
  assert.throws(
    () => validateDocumentationSources({
      ...valid,
      readme: valid.readme.replace("| Same repository, draft | Report-only | Off |", "Drafts are unsupported")
    }),
    /draft PRs as report-only/
  );
});
