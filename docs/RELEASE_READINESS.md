# Staging and release delivery

Codekeeper releases move through a protected staging branch, a protected main
branch, a reviewed Release Please pull request, and the existing verified npm
publisher. Building a staging candidate does not publish anything.

## Current boundary

- Feature pull requests target `staging` and require approval and all checks.
- Every push to `staging` builds a complete candidate and retains its evidence.
- A reviewed `staging` to `main` pull request is the production promotion.
- Release Please opens a second reviewed pull request that updates the package
  version, lockfiles, release manifest, and changelog.
- Merging that release pull request creates `codekeeper-vX.Y.Z` and a GitHub
  Release. The tag starts the npm publisher.
- Repository rules and release tags must be applied and checked separately as
  described in [Repository governance](REPOSITORY_GOVERNANCE.md).

## Produce a staged candidate

Push an approved change to `staging`, or run **Stage Codekeeper release
candidate** manually with an exact branch, tag, or commit. It performs the
repository, runtime, installer, and acceptance checks, packs the exact candidate
outside the checkout, and uploads:

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

The npm workflow must run only for the immutable tag created from an approved
Release Please pull request. It verifies that the source repository is public
before building because npm provenance is not available for private repositories.

## Release Please token

`RELEASE_PLEASE_TOKEN` must be a fine-grained personal access token or GitHub App
token with Contents and Pull requests write access to this repository. A separate
token is required because pull requests created with the workflow's default
`GITHUB_TOKEN` do not start the required pull-request checks. Store only the token
as an Actions secret; never commit it.
