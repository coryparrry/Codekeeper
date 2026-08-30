import assert from "node:assert/strict";
import test from "node:test";
import { runValidateRepairAction } from "../assets/repair/.github/rivet/actions/validate-repair/index.mjs";

const patch = [
  "diff --git a/src/discount.mjs b/src/discount.mjs",
  "index 1234567..89abcde 100644",
  "--- a/src/discount.mjs",
  "+++ b/src/discount.mjs",
  "@@ -1 +1 @@",
  "-export const valid = false;",
  "+export const valid = true;",
  "",
].join("\n");

const event = {
  repository: { full_name: "owner/repository" },
  issue: {
    number: 12,
    pull_request: { url: "https://api.github.com/pulls/12" },
  },
  comment: {
    id: 34,
    body: "/rivet-repair",
    author_association: "OWNER",
    created_at: "2026-08-27T12:00:00Z",
    user: { login: "owner" },
  },
};

test("emits an exact-head receipt after isolated validation", async () => {
  const headSha = "a".repeat(40);
  const pull = {
    head: {
      sha: headSha,
      ref: "repair-branch",
      repo: { full_name: "owner/repository" },
    },
  };
  const responses = [pull, pull];
  const calls = [];
  const written = new Map();
  const receipt = await runValidateRepairAction({
    env: {
      GITHUB_EVENT_PATH: "/event.json",
      GH_AW_AGENT_OUTPUT: "/output.json",
      GITHUB_WORKSPACE: "/workspace",
      RUNNER_TEMP: "/runner",
      GITHUB_TOKEN: "read-only-token",
      RIVET_VALIDATION_COMMANDS_BASE64: Buffer.from(
        JSON.stringify(["npm test"]),
      ).toString("base64"),
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => responses.shift(),
    }),
    readFileImpl: async (filePath) =>
      JSON.stringify(
        filePath === "/event.json"
          ? event
          : { items: [{ type: "validate_repair", patch }] },
      ),
    writeFileImpl: async (filePath, content) => written.set(filePath, content),
    mkdirImpl: async () => {},
    runImpl: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "diff" && args.includes("--name-only")) {
        return "src/discount.mjs\0";
      }
      if (args[0] === "diff") return patch;
      return "";
    },
  });
  assert.equal(
    calls.some(([command, first]) => command === "/bin/sh" && first === "-c"),
    true,
  );
  assert.equal(receipt.headSha, headSha);
  assert.deepEqual(receipt.validation, [{ command: "npm test", exitCode: 0 }]);
  assert.equal(written.get("/runner/rivet-repair/patch.diff"), patch);
  assert.match(
    written.get("/runner/rivet-repair/receipt.json"),
    /"schemaVersion":1/,
  );
});
