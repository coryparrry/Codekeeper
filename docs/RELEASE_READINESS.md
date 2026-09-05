# Rivet release delivery

The legacy Codekeeper release automation has been retired as part of the
migration to Rivet. Its release-preparation and tag-triggered publication
workflows are no longer present.

Rivet releases are driven by
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
3. Prepare the intended package version and exact source manifest checkpoint;
   run the local package and protected release checks described in
   [VALIDATION.md](../VALIDATION.md).
4. Publish only through the protected matching version tag and verify npm's
   resulting version, tarball integrity, and provenance. Install that published
   version in a clean consumer before claiming release completion.

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
