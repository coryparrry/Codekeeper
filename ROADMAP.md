# Roadmap

This roadmap describes priorities, not promised dates or compatibility
commitments.

## Next: adoption proof and review coverage

- Prove the complete automatic review-label lifecycle in a controlled adopter,
  including pending, blocking, missing-test, manual-review, and merge-ready
  states while preserving every human-owned label.
- Add a safe read-only strategy for fork, stacked, draft, and merge-queue review
  instead of treating those pull requests as mutation-eligible.
- Publish versioned evaluation reports with stronger root-cause and
  reproduction scoring.
- Retain exact package-provenance and post-publish adopter canaries for every
  release.

## Then: explicit advanced controls

- Add a guided repair-authority upgrade after the review-only guided setup is
  proven across adopters.
- Add explicit provider-data controls and predictable execution-budget
  controls.
- Expand maintenance only when a report-first adopter use case proves the added
  authority is necessary.

## Ongoing

- Keep trust boundaries, policy schemas, historical upgrade inputs, and managed
  label ownership auditable.
- Reduce repeated workflow work without hiding permissions or credential
  mapping.
- Improve contributor documentation and real adopter examples as evidence is
  available.
