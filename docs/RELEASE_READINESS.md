# Unpublished release readiness

Codekeeper is intentionally **not published to npm yet**. This document defines
the proof required before public installation guidance or a production release
is enabled. Completing a local pack or this workflow does not publish anything.

## Current boundary

- Source evaluation uses the verified local-tarball process in
  [INSTALL.md](../INSTALL.md).
- `npx @coryparry/codekeeper ...` is future public-release syntax, not a currently proven
  installation route.
- The publication workflow remains dormant until a reviewed
  `codekeeper-vX.Y.Z` tag is deliberately created.
- Repository rules and release tags must be applied and checked separately as
  described in [Repository governance](REPOSITORY_GOVERNANCE.md).

## Produce an unpublished candidate

Run **Codekeeper unpublished release readiness** manually with an exact branch,
tag, or commit. It performs the repository, runtime, installer, and acceptance
checks, packs the exact candidate outside the checkout, and uploads:

- the candidate npm tarball;
- its npm-generated integrity receipt; and
- `release-readiness-evidence.json`, which binds the repository, source ref,
  source commit, optional release tag, package identity, and workflow run.

The workflow has read-only repository permission and contains no npm publish or
GitHub Release mutation.

## Release-tag binding

When a release tag is supplied, `scripts/release-tag-integrity.mjs` resolves
both lightweight and annotated Git tags through GitHub and requires the final
commit to equal the candidate source commit. Cycles, excessive indirection,
malformed objects, and moved tags fail closed.

The same check must run immediately before any future registry or GitHub Release
mutation. The repository tag ruleset is preventative; the runtime check is the
independent detection boundary.

## Evidence required before publication

Retain one evidence index containing:

1. the exact source commit and reviewed release tag;
2. the candidate SHA-512 integrity and release-manifest digest;
3. successful source, runtime, installer, and acceptance checks;
4. a disposable adopter-repository run for review, issue triage, maintenance,
   and bounded repair;
5. interruption and rerun evidence around every durable GitHub write boundary;
6. verified GitHub App least-privilege permissions;
7. repository rules and immutable-tag checks;
8. dependency, secret, license, and archive scans; and
9. explicit maintainer approval to publish and change public documentation.

Until all nine items are recorded against one exact commit, Codekeeper remains
an unpublished source evaluation and the npm workflow must not be triggered.
The release workflow also verifies that the source repository is public before
building because npm provenance is not available for private repositories.
