import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("packaged Fixer keeps Codex sandboxing usable on GitHub-hosted Ubuntu", async () => {
  const [isolation, config, schemas] = await Promise.all([
    readFile(
      new URL(
        "../../../tools/codekeeper/src/lib/orchestration/workspace-isolation.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../../../tools/codekeeper/src/lib/config.mjs", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../../tools/codekeeper/src/lib/schemas.mjs", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(isolation, /kernel\.unprivileged_userns_clone/);
  assert.match(isolation, /kernel\.apparmor_restrict_unprivileged_userns/);
  assert.match(isolation, /RUNNER_ENVIRONMENT === "github-hosted"/);
  assert.match(isolation, /await prepareCodexLinuxSandbox\(\)/);
  assert.match(
    config,
    /agent\.workspace\.allowWrites && mutationEnabled \? "workspace-write" : "read-only"/,
  );
  assert.match(schemas, /must describe a command that actually ran/);
});
