import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export async function currentReviewLock(packageRoot, workflow) {
  if (workflow.includes("\n  create-issue:\n")) {
    return readFile(
      path.join(
        packageRoot,
        "test/fixtures/review/.github/workflows/rivet-review.lock.yml",
      ),
      "utf8",
    );
  }
  const encoded = await readFile(
    path.join(
      packageRoot,
      "test/fixtures/review/rivet-review-disabled.lock.yml.gz.b64",
    ),
    "utf8",
  );
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}
