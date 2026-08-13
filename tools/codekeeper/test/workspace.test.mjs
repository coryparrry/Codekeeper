import assert from "node:assert/strict";
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
