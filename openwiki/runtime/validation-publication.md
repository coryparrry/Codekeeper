---
type: validation-publication
title: Validation, sealing, and GitHub publication
description: Deterministic result validation, repair verification, ownership markers, and final GitHub mutations.
tags: [validation, publication, github]
---

# Validation, sealing, and GitHub publication

`validate.mjs` validates mode-specific structured output against `schemas.mjs`, policy, frozen context, evidence boundaries, file/line references, and repair limits. `sealReview`, `sealAudit`, `sealIssue`, and `sealFix` produce candidate artifacts bound to configuration, profile, tooling, and context hashes. `verifyAudit` and `verifyFix` re-check patches in a fresh credential-free checkout before publication.

`publish.mjs` is the only mutation plane. It publishes labels, sticky comments, review feedback, issues, repair PRs, same-PR repair commits, and optional auto-merge. `markers.mjs` creates stable fingerprints and ownership markers; `github.mjs` performs conditional API operations. Publication re-reads live state, requires the configured App bot identity, and refuses stale expected heads, foreign markers, unsupported targets, or mismatched artifacts.

Repair flow is bounded by allowed paths, changed files/lines, validation commands, current-head agreement, and a single automatic repair lease. Auto-merge is independently policy-gated; model recommendations never bypass deterministic checks.

Tests: `tools/codekeeper/test/publish.test.mjs`, `git-validation.test.mjs`, workflow authorization/contract suites, and publication, pagination, and runtime audit tests. Use targeted tests for a mode change and `npm run check` for integration.
