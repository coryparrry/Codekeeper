import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifySourceManifest } from "./verify-source-manifest.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(files, base, overrides = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codekeeper-source-manifest-"));
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(target), { recursive: true }));
    await writeFile(target, contents);
  }
  await writeFile(path.join(root, "MANIFEST.sha256"), base);
  if (overrides !== null) await writeFile(path.join(root, "MANIFEST.overrides.sha256"), overrides);
  const inventory = path.join(root, "inventory.txt");
  await writeFile(
    inventory,
    [...Object.keys(files), "MANIFEST.sha256", ...(overrides === null ? [] : ["MANIFEST.overrides.sha256"])]
      .sort()
      .join("\n") + "\n",
  );
  return { root, inventory };
}

test("verifies a complete base manifest", async (context) => {
  const files = { "README.md": "hello\n", "src/app.mjs": "export {};\n" };
  const base = Object.entries(files).sort().map(([name, value]) => `${digest(value)}  ${name}\n`).join("");
  const item = await fixture(files, base);
  context.after(() => rm(item.root, { recursive: true, force: true }));
  assert.deepEqual(await verifySourceManifest(item), { files: 2, overrides: 0 });
});

test("overrides replace stale hashes and add new inventory paths", async (context) => {
  const files = { "README.md": "new\n", "src/new.mjs": "export const value = 1;\n" };
  const base = `${digest("old\n")}  README.md\n`;
  const overrides = `${digest(files["README.md"])}  README.md\n${digest(files["src/new.mjs"])}  src/new.mjs\n`;
  const item = await fixture(files, base, overrides);
  context.after(() => rm(item.root, { recursive: true, force: true }));
  assert.deepEqual(await verifySourceManifest(item), { files: 2, overrides: 2 });
});

test("rejects stale checksums", async (context) => {
  const item = await fixture({ "README.md": "new\n" }, `${digest("old\n")}  README.md\n`);
  context.after(() => rm(item.root, { recursive: true, force: true }));
  await assert.rejects(verifySourceManifest(item), /checksum mismatch for README.md/);
});

test("rejects unsafe and duplicate override paths", async (context) => {
  const files = { "README.md": "hello\n" };
  const base = `${digest(files["README.md"])}  README.md\n`;
  const item = await fixture(files, base, `${digest("x")}  ../escape\n`);
  context.after(() => rm(item.root, { recursive: true, force: true }));
  await assert.rejects(verifySourceManifest(item), /unsafe path/);
});

test("requires manifest coverage to equal the source inventory", async (context) => {
  const files = { "README.md": "hello\n", "extra.txt": "extra\n" };
  const base = `${digest(files["README.md"])}  README.md\n`;
  const item = await fixture(files, base);
  context.after(() => rm(item.root, { recursive: true, force: true }));
  await assert.rejects(verifySourceManifest(item), /inventory mismatch/);
});
