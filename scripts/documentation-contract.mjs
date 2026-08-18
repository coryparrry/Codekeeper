#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`Documentation contract: ${message}`);
}

export function validateDocumentationSources({
  readme,
  install,
  wikiReadme,
  wikiInstructions,
  wikiMetadata
}) {
  for (const pattern of [
    /shields\.io\/npm/i,
    /npmjs\.com\/package\/codekeeper/i,
    /\bnpx\s+codekeeper\b/i,
    /CLI IMAGE:/i
  ]) {
    if (pattern.test(readme)) fail(`README contains forbidden unpublished or placeholder content: ${pattern}`);
  }
  if (!/intentionally unpublished/i.test(readme)) {
    fail("README must state that Codekeeper is intentionally unpublished");
  }
  if (!/npm exec --package \/absolute\/path\/to\/codekeeper\.tgz/i.test(readme)) {
    fail("README must show the verified local-package evaluation path");
  }
  if (!/E404/i.test(install) || !/local, verified tarball/i.test(install)) {
    fail("INSTALL.md must preserve the current unpublished proof boundary");
  }
  if (!/Same repository, draft[\s\S]*Report-only/i.test(readme)) {
    fail("README must describe draft PRs as report-only");
  }

  let metadata;
  try {
    metadata = JSON.parse(wikiMetadata);
  } catch {
    fail("OpenWiki metadata must be valid JSON");
  }
  if (
    !FULL_SHA.test(String(metadata.gitHead ?? "")) ||
    !Number.isFinite(Date.parse(String(metadata.updatedAt ?? ""))) ||
    metadata.status !== "complete"
  ) {
    fail("OpenWiki metadata must contain a complete timestamped source commit");
  }
  if (!/non-authoritative/i.test(wikiReadme) || !wikiReadme.includes(metadata.gitHead)) {
    fail("OpenWiki README must identify the snapshot as non-authoritative and bind its source commit");
  }
  if (!/non-authoritative/i.test(wikiInstructions) || !/Do not invent installation commands/i.test(wikiInstructions)) {
    fail("OpenWiki instructions must preserve the documentation authority boundary");
  }
  return Object.freeze({ valid: true, wikiSourceCommit: metadata.gitHead });
}

export async function validateRepositoryDocumentation(root = ROOT) {
  const [readme, install, wikiReadme, wikiInstructions, wikiMetadata] = await Promise.all([
    readFile(path.join(root, "README.md"), "utf8"),
    readFile(path.join(root, "INSTALL.md"), "utf8"),
    readFile(path.join(root, "openwiki/README.md"), "utf8"),
    readFile(path.join(root, "openwiki/INSTRUCTIONS.md"), "utf8"),
    readFile(path.join(root, "openwiki/.last-update.json"), "utf8")
  ]);
  return validateDocumentationSources({
    readme,
    install,
    wikiReadme,
    wikiInstructions,
    wikiMetadata
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await validateRepositoryDocumentation();
  process.stdout.write(`documentation valid; OpenWiki source ${result.wikiSourceCommit}\n`);
}
