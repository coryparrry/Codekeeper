import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/lib/config.mjs";

const source = JSON.parse(
  await readFile(new URL("../../../.github/ai-maintainer.json", import.meta.url), "utf8")
);

async function writeConfig(value) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-maintainer-config-test-"));
  const file = path.join(directory, "policy.json");
  await writeFile(file, JSON.stringify(value), "utf8");
  return file;
}

test("configuration validator rejects unsafe or incomplete policy values", async () => {
  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      audit: {
        ...source.audit,
        repair: { ...source.audit.repair, maximumPatchBytes: 0 }
      }
    })),
    /audit\.repair\.maximumPatchBytes must be a positive integer/
  );

  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      review: { ...source.review, allowedLabels: [...source.review.allowedLabels, "undefined-label"] }
    })),
    /review references undefined label undefined-label/
  );

  const missingRuntimeLabel = structuredClone(source);
  delete missingRuntimeLabel.labels["ai-maintainer:ready"];
  await assert.rejects(
    loadConfig(await writeConfig(missingRuntimeLabel)),
    /runtime requires undefined label ai-maintainer:ready/
  );

  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      issues: { ...source.issues, managedLabels: ["undefined-label"] }
    })),
    /issues references undefined label undefined-label/
  );

  await assert.rejects(
    loadConfig(await writeConfig({
      ...source,
      repository: { ...source.repository, automationBranchPrefix: "automation/ai-maintainer" }
    })),
    /automationBranchPrefix must end with/
  );
});
