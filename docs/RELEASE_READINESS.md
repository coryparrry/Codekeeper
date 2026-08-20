# Reviewed release delivery

Codekeeper uses one protected delivery branch: `main`. Feature pull requests and
Release Please pull requests both target `main`, require approval and the full
repository check suite, and dismiss stale approvals when new commits arrive.

## Delivery boundary

1. Open a feature pull request directly against `main`.
2. Merge it only after approval and all required checks pass.
3. Release Please opens or updates a separate reviewed version pull request.
4. That pull request updates the package version, lockfiles, changelog, release
   manifest, and exact source manifest.
5. Merging the version pull request creates `codekeeper-vX.Y.Z` and a GitHub
   Release. The immutable tag starts the protected npm publisher.

Preparing or reviewing a release pull request does not publish npm. Publication
remains isolated in the tag-triggered workflow and its protected `npm`
environment.

## Release-tag binding

`scripts/release-tag-integrity.mjs` resolves lightweight and annotated Git tags
through GitHub and requires the final commit to equal the release source commit.
Cycles, excessive indirection, malformed objects, and moved tags fail closed.

The same check runs immediately before registry and GitHub Release verification.
The immutable tag ruleset is the preventative boundary; the runtime check is an
independent detection boundary.

## Evidence required before publication

Retain evidence for the exact source commit and reviewed tag, package integrity,
successful repository/runtime/installer/acceptance checks, GitHub App
least-privilege permissions, immutable-tag protection, and explicit maintainer
approval. The npm workflow verifies that the source repository is public before
building because npm provenance is not available for private repositories.

## Release Please token

`RELEASE_PLEASE_TOKEN` must be a fine-grained personal access token or GitHub App
token with Contents and Pull requests write access to this repository. A separate
token is required because pull requests created with the workflow's default
`GITHUB_TOKEN` do not start the required pull-request checks. Store only the token
as an Actions secret; never commit it.
