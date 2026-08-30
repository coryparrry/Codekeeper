# Rivet repair qualification

Rivet repair is a gated candidate, not an installed capability. The candidate tests the pinned gh-aw `push-to-pull-request-branch` primitive against the repair boundary before Rivet gains write authority.

## Candidate controls

The repair source requires:

- the exact `/rivet-repair` command on a pull request comment;
- an actor with GitHub's exact `admin` repository role;
- a same-repository triggering pull request;
- one push back to that triggering pull request;
- no fallback pull request after a non-fast-forward failure;
- blocked protected files;
- at most 25 changed files and a 1 MiB patch; and
- a separate Rivet App token for the safe-output path.

The agent job retains read-only GitHub permissions and does not receive `RIVET_APP_PRIVATE_KEY`. The pinned compiler places the App credential only in deterministic activation and safe-output jobs. The candidate exposes neither pull-request creation nor merge output.

## Pinned compiler result

The checked-in source compiles cleanly with gh-aw `v0.86.2` in strict action mode using the pinned actions commit. Inspection of the generated workflow confirms:

- the exact-command condition is preserved in activation;
- the only event is `issue_comment` filtered to pull requests;
- every checkout stays in the current repository;
- checkout credentials are not persisted in the agent job;
- all third-party actions and containers are immutable; and
- the Rivet App private key is absent from the agent job.

The generated lock file is deliberately not installed or checked in at this gate.

## Remaining hard gates

The upstream primitive enforces same-repository targeting, protected paths, patch limits, and non-fast-forward failure. It does not by itself prove that the configured validation commands ran successfully, and prompt instructions are not a deterministic validation gate.

Before repair can be installed, Rivet still needs:

1. a narrow validation receipt checked before publication;
2. a review, authorization, original-head, repair-commit, and re-review lineage receipt;
3. live verification that the Rivet App was widened from Contents read to Contents write; and
4. an installer/update PR that enables repair only after those checks pass.

Until then, review remains the only operational Rivet workflow and repair authority remains disabled in schema v4.
