import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const profiles = {
  "pr-reviewer.md": {
    version: 8,
    sha256: "0a5fbe580ffe777c58655ac31f2491438e1fd2d4fc5763b598c93097c7d01581",
  },
  "issue-triager.md": {
    version: 5,
    sha256: "8825b1ee920a298931c6c7be372d7955536d109ba7fac4705dd1805cd5f69432",
  },
  "fixer.md": {
    version: 3,
    sha256: "d7761bf7e74962ce0b5be774f161a36636c9c7c4e3c6cc71d5a49693a3770b77",
  },
  "repository-auditor.md": {
    version: 4,
    sha256: "5b1b7f8fc57b68e33ada30ea926a22f3b41a486288dc676ada0850c6ba7f9197",
  },
};

test("agent profiles retain their evaluated identities", async () => {
  for (const [name, expected] of Object.entries(profiles)) {
    const contents = await readFile(
      new URL(`../assets/agents/${name}`, import.meta.url),
    );
    const text = contents.toString("utf8");

    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      expected.sha256,
      `${name} content hash`,
    );
    assert.match(
      text,
      new RegExp(`^Profile version: ${expected.version}$`, "m"),
    );
  }
});
