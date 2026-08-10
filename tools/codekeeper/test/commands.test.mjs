import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/lib/commands.mjs";

test("owner commands require an exact supported command", () => {
  assert.equal(parseCommand("/codekeeper status"), "status");
  assert.equal(parseCommand(" /CODEKEEPER rerun "), "rerun");
  assert.equal(parseCommand("/codekeeper fix"), null);
  assert.equal(parseCommand("/codekeeper stop now"), null);
});
