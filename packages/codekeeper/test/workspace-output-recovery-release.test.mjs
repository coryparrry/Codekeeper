import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the packaged runtime retains bounded workspace output recovery", async () => {
  const [core, provider] = await Promise.all([
    readFile(
      new URL("../../../tools/codekeeper/src/lib/agents-runtime-core.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../tools/codekeeper/src/lib/agents-runtime-provider.mjs", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(core, /buildWorkspaceOutputRepairPrompt/);
  assert.match(core, /attempt <= settings\.maximumAttempts/);
  assert.match(core, /attempt === 1 \? settings\.workspaceSandbox : "read-only"/);
  assert.match(core, /attempts: attempt/);
  assert.match(core, /workspace .* pass failed after/);
  assert.match(provider, /isPlainObject\(structuredContent\)/);
});
