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

## Pre-publication customer lifecycle

Every pull request must pass both `installer-checks (22.23.2)` and
`installer-checks (24.19.0)`. Configure both matrix entries as required
checks for `main`. They pack the candidate from the pull-request snapshot and run
the same credential-free verifier used by the release workflow.

The tag workflow inserts `candidate-lifecycle` between `build` and `publish`.
It downloads the exact `codekeeper-release-${version}-${github.sha}` artifact and
reuses the build job's filename, package identity, version, SHA-512 integrity,
source commit, and manifest SHA-256. The protected `publish` job depends on both
`build` and `candidate-lifecycle`; the lifecycle job has no npm environment,
secrets, write permission, or OIDC authority.

The verifier checks the tarball receipt before extraction, serves only that
tarball from a temporary loopback npm-compatible endpoint, and runs the literal
`npx --yes @coryparry/codekeeper@<candidate-version> init` command in a fresh Git
repository with no origin. Success means package acquisition completed and setup
emitted the expected repository-readiness stop for that no-origin fixture. This is
an observed regression oracle, not an unforgeable proof based on diagnostic text.
The verifier then installs and reverifies the exact candidate, installs the nested
runtime, parses every packaged and generated workflow with Ruby/Psych, and
exercises the production package and GitHub App verification adapters with a
hermetic runner. Any missing runtime asset, changed receipt, truncated subprocess,
YAML parse failure, or unexpected secret/variable mutation call fails closed.

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

The candidate lifecycle is pre-publication evidence, not live adopter evidence.
After npm publication, retain the public registry receipt and exact-version
install canary from the publisher. Separately run `codekeeper verify` in an
installed adopter repository to prove the real GitHub App identity, selected
repository installation, stored private key, and correlated no-mutation App
credential workflow. Live App/adopter acceptance cannot be replaced by the
hermetic pre-publication adapter proof.

## Release Please token

`RELEASE_PLEASE_TOKEN` must be a fine-grained personal access token or GitHub App
token with Contents and Pull requests write access to this repository. A separate
token is required because pull requests created with the workflow's default
`GITHUB_TOKEN` do not start the required pull-request checks. Store only the token
as an Actions secret; never commit it.
