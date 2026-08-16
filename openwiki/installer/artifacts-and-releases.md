---
type: release-integrity
title: Package, tooling, and release integrity
description: Source-to-consumer chain for building, verifying, staging, packing, installing, and bootstrapping Codekeeper.
tags: [release, artifacts, supply-chain]
---

# Package, tooling, and release integrity

The source-to-consumer chain starts with tracked source and ends with a verified run-scoped runtime artifact:

1. `scripts/build-codekeeper-package.mjs` stages CLI, runtime, assets, profiles, presets, workflows, and lockfiles.
2. `scripts/pack-codekeeper-package.mjs` verifies staged content and produces the npm tarball.
3. `release-verifier.mjs` and `bin/verify-package.mjs` check identity, closed inventory, hashes, source commit, and absence of links/hidden paths.
4. `repository-artifacts.mjs` and `plan.mjs` render only catalogued adopter destinations.
5. `tools/codekeeper/action.yml` verifies tooling manifest and uploads a run-scoped artifact.
6. Later jobs independently reverify before runtime and publication.

`tools/codekeeper/tooling-manifest.json`, `MANIFEST.sha256`, package lockfiles, workflow digests, and the synchronized installer/runtime policy validator are integrity contracts. The package/source manifest digests prove the closed file inventory and source bytes; the npm SHA-512 integrity receipt proves the externally acquired tarball. `assets.mjs:loadVerifiedAssets` additionally checks bundled asset provenance, inventory, bytes, and staged paths. `activeRepositoryArtifacts` records active, renamed, and retired artifacts so updates remove only release-owned prior destinations. Generated assets must be regenerated rather than hand-edited. `scripts/sync-policy-validator.mjs` detects policy drift; source release verification checks clean tracked content and the manifest.

Tests: `package-stage.test.mjs`, `package-contract.test.mjs`, `runner-package.test.mjs`, `installer-trust.test.mjs`, `package-acquisition-action.test.mjs`, `repository-artifacts.test.mjs`, tooling-artifact tests, and release-source verification. Commands: `npm run package:stage:check`, `npm run package:pack -- --destination <dir>`, and `bash scripts/release-source.sh --verify`.
