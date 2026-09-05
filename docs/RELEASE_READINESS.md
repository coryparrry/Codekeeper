# Rivet release delivery

Rivet uses Release Please to prepare a reviewed version bump, then publishes
the merged release to npm automatically.

[`rivet-release-please.yml`](../.github/workflows/rivet-release-please.yml) runs
on pushes to `main` and can be retried manually on `main`. It maintains a release
PR for `packages/rivet`, updating the package version, lockfile, root changelog,
and release manifest. It then regenerates `MANIFEST.sha256` on that fixed release
branch so the reviewed source inventory includes the version changes.

Merging the release PR lets Release Please create its GitHub release and tag.
Publication is driven by
[`rivet-release.yml`](../.github/workflows/rivet-release.yml). A protected
`rivet-v<version>` tag must exactly match the version in
[`packages/rivet/package.json`](../packages/rivet/package.json). The workflow
rechecks the tracked source inventory, validates the package, and publishes to
npm from the protected `npm` environment through OIDC trusted publishing. It
does not use a long-lived npm publication token.

Use [agent release safety](AGENT_RELEASE_SAFETY.md) for the exact source,
manifest, package, workflow, and live-publication evidence sequence. Use
[Rivet migration authority](RIVET_GH_AW_MIGRATION.md) and
[Rivet repair qualification](RIVET_REPAIR_QUALIFICATION.md) for product
authority and repair evidence boundaries.

## From reviewed source to a release

1. Update the README, install guide, configuration reference, and validation
   evidence for the actual workflow. Keep unreleased changes distinct from the
   version available through npm.
2. Pass the PR checks and required review, then merge the approved source change.
   Merging a source PR does not publish a package.
3. Review the generated `chore(release): prepare Rivet <version>` PR, including
   its changelog and source manifest. Run the checks described in
   [VALIDATION.md](../VALIDATION.md).
4. Merge that release PR when ready to publish. Release Please creates the
   matching `rivet-v<version>` tag, which starts `Publish Rivet`. Verify npm's
   resulting version, tarball integrity, and provenance. Install that published
   version in a clean consumer before claiming release completion.

## Release credentials and recovery

Release Please uses the existing `RELEASE_PLEASE_TOKEN` GitHub Actions secret
to create its PR and tag. It must have repository contents and pull-request
write access. Using the default `GITHUB_TOKEN` would suppress downstream CI and
tag-triggered publishing, so there is no fallback to that token. npm publishing
continues to use OIDC in the `npm` environment; the release token is not an npm
credential.

The release manifest starts at the existing `0.1.13` publication. Conventional
commits since that tag determine the next release. Before 1.0, features and
fixes use patch bumps; breaking changes use minor bumps. A normal source merge prepares the release PR; it does not publish.
If release preparation fails, rerun `Prepare Rivet release` on `main`. If npm
publication fails after tagging, rerun the failed `Publish Rivet` run after
resolving the failure. Do not move or recreate an immutable release tag.

## Qualify the workflow that will be enabled

A fresh install begins with bare `rivet init` in a clean checkout, proceeds
through App and model-secret verification, and ends with a verified draft setup
PR. The adopter reviews and merges it to activate the workflows. Existing
installations use an explicit review-only or repair mode; update proof does not
replace the fresh-install check.

The [recorded fresh-install acceptance](../VALIDATION.md#recorded-fresh-install-proof)
proves the tested candidate's review-only installation, model execution,
App-authored review, and final status label in a public disposable repository.
It is not an npm publication receipt or live repair qualification. Bind each
release claim to the exact source and package that exercised that boundary.
