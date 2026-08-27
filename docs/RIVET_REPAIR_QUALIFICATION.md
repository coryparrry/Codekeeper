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

## Repair lineage

Rivet records repair progress as one immutable sequence:

1. review head and findings fingerprint;
2. authorization actor, comment, and still-live head;
3. successful command exit codes and the new repair commit; and
4. a fresh review of that exact repair commit.

The sequence rejects moved heads, failed commands, no-change repairs, reordered steps, forged base records, and altered validation receipts. A repair is complete only when the fresh review of the repair commit has no blocking result. Each new repair attempt starts a new lineage from the newly reviewed head.

This state machine validates receipts supplied by deterministic workflow steps. It does not treat an agent's claim that validation ran as proof.

## Remaining hard gates

The upstream primitive enforces same-repository targeting, protected paths, patch limits, and non-fast-forward failure. It does not by itself prove that the configured validation commands ran successfully, and prompt instructions are not a deterministic validation gate.

Before repair can be installed, Rivet still needs:

1. wire a deterministic validation runner and the lineage state machine into publication;
2. persist the lineage through a Rivet-owned GitHub marker or check result;
3. verify live that the Rivet App was widened from Contents read to Contents write; and
4. enable repair in an installer/update PR only after those checks pass.

Until then, review remains the only operational Rivet workflow and repair authority remains disabled in schema v4.
