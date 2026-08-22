import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeSource = () =>
  readFile(
    new URL(
      "../../../tools/codekeeper/src/lib/agents-runtime.mjs",
      import.meta.url,
    ),
    "utf8",
  );

test("packaged release preserves frozen issue evidence when workspace triage is skipped", async () => {
  const source = await runtimeSource();

  assert.match(source, /ISSUE-ONLY EXECUTION MODE:/);
  assert.match(
    source,
    /complete bounded triage evidence; do not require a workspace result/,
  );
  assert.match(
    source,
    /buildIssuePrompt\(context, config, frozenProfile\.text\)/,
  );
  assert.match(
    source,
    /writeFile\(path\.join\(directory, "prompt\.md"\), directPrompt, "utf8"\)/,
  );
  assert.match(
    source,
    /received workspace runtime metadata without specialist evidence/,
  );
});
