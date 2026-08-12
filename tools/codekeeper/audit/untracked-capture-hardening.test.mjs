import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectUntrackedFile } from "../src/lib/git.mjs";

test("untracked capture does not follow links, block on FIFOs, or exceed the read cap", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-untracked-capture-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const target = path.join(root, "target.txt");
  const link = path.join(root, "link.txt");
  await writeFile(target, "secret\n", "utf8");
  await symlink(target, link);

  const linked = await inspectUntrackedFile(link, 32);
  assert.equal(linked.symlink, true);
  assert.equal(linked.specialMode, true);

  const oversized = path.join(root, "oversized.txt");
  await writeFile(oversized, Buffer.alloc(64, "x"));
  const bounded = await inspectUntrackedFile(oversized, 32);
  assert.equal(bounded.captureSkipped, true);
  assert.ok(bounded.bytes >= 33);

  if (process.platform !== "win32") {
    const fifo = path.join(root, "pipe");
    execFileSync("mkfifo", [fifo]);
    const special = await Promise.race([
      inspectUntrackedFile(fifo, 32),
      new Promise((_, reject) => setTimeout(() => reject(new Error("FIFO capture blocked")), 250))
    ]);
    assert.equal(special.specialMode, true);
  }
});
