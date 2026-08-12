import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SOURCE_COMMIT } from "../src/constants.mjs";
import { REPOSITORY_ROOT } from "./helpers.mjs";

test("installer checks include hardening audit tests", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.test, /node --test test\/\*\.test\.mjs audit\/\*\.test\.mjs/);
  assert.match(packageJson.scripts.check, /audit\/\*\.mjs/);
  assert.match(packageJson.scripts.check, /node --test test\/\*\.test\.mjs audit\/\*\.test\.mjs/);
});

test("installer source pin is a full commit reachable from origin/main", () => {
  assert.match(SOURCE_COMMIT, /^[0-9a-f]{40}$/);
  execFileSync("git", ["merge-base", "--is-ancestor", SOURCE_COMMIT, "origin/main"], {
    cwd: REPOSITORY_ROOT,
    stdio: "pipe"
  });
});
