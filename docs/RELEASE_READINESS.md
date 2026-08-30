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
