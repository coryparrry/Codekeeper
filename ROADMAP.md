# Roadmap

This roadmap describes priorities, not promised dates or compatibility
commitments.

## Next: product hardening

- Preserve human-owned repository labels and namespace labels Codekeeper can
  remove.
- Include bounded issue conversation context and rerun triage when a reporter
  or maintainer supplies missing information.
- Keep maintenance quiet by default: manual/report-first, then explicit
  schedule, issue-publication, and repair decisions.
- Keep privileged jobs on isolated GitHub-hosted ephemeral runners.
- Require deterministic repository validation before code-changing automation.
- Present actual authority and automatic behavior before installation changes.

## Then: adoption evidence and broader review

- Add a safe read-only strategy for fork, stacked, draft, and merge-queue
  review rather than treating them as mutation-eligible by default.
- Publish versioned evaluation reports with stronger root-cause and
  reproduction scoring.
- Complete external package provenance and a post-publish canary before public
  npm installation guidance.
- Add explicit provider-data controls and predictable execution-budget
  controls.

## Ongoing

- Keep trust boundaries and policy schemas auditable.
- Reduce repeated workflow work without hiding permissions or credential
  mapping.
- Improve contributor documentation and real adopter examples as evidence is
  available.
