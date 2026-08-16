import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertRunnerOwnedDirectory } from "../src/lib/workspace.mjs";

test("runner-owned directories cannot overlap the checkout", () => {
  const root = path.parse(process.cwd()).root;
  const checkout = path.join(root, "workspace", "repository");
  const checkoutParent = path.dirname(checkout);
  const runnerTemp = path.join(checkoutParent, "runner-temp");

  for (const directory of [
    checkout,
    path.join(checkout, "artifact"),
    checkoutParent,
    root,
  ]) {
    assert.throws(
      () => assertRunnerOwnedDirectory(directory, checkout),
      /--directory must be outside the checked-out repository/,
    );
  }

  assert.equal(assertRunnerOwnedDirectory(runnerTemp, checkout), runnerTemp);
});

test("runner-owned directories reject symlinks that resolve into the checkout", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-runner-directory-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "checkout");
  const checkoutSink = path.join(checkout, "sink");
  const external = path.join(root, "external");
  const safeTarget = path.join(root, "safe-target");
  await Promise.all([
    mkdir(checkoutSink, { recursive: true }),
    mkdir(external, { recursive: true }),
    mkdir(safeTarget, { recursive: true }),
  ]);

  const finalSymlink = path.join(external, "runner");
  await symlink(checkoutSink, finalSymlink);
  assert.throws(
    () => assertRunnerOwnedDirectory(finalSymlink, checkout),
    /--directory must be outside the checked-out repository/,
  );

  const parentSymlink = path.join(external, "parent");
  await symlink(checkout, parentSymlink);
  assert.throws(
    () => assertRunnerOwnedDirectory(path.join(parentSymlink, "artifact"), checkout),
    /--directory must be outside the checked-out repository/,
  );

  const safeSymlink = path.join(external, "safe");
  await symlink(safeTarget, safeSymlink);
  assert.equal(
    assertRunnerOwnedDirectory(path.join(safeSymlink, "new-artifact"), checkout),
    path.join(await realpath(safeTarget), "new-artifact"),
  );
});
