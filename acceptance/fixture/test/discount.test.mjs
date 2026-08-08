import test from "node:test";
import assert from "node:assert/strict";
import { discountedTotal } from "../src/discount.mjs";

test("discountedTotal calculates a deterministic percentage discount", () => {
  assert.equal(discountedTotal(19.99, 25), 14.99);
});

test("discountedTotal rejects an invalid discount", () => {
  assert.throws(() => discountedTotal(19.99, 101), TypeError);
});
