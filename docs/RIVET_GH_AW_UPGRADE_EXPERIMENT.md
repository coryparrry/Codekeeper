# Rivet gh-aw adjacent-version upgrade experiment

## Result

The adjacent upgrade from gh-aw
[`v0.86.2`](https://github.com/github/gh-aw/releases/tag/v0.86.2) to
[`v0.86.3`](https://github.com/github/gh-aw/releases/tag/v0.86.3) passed the
Rivet review fixture’s compile, trust, and migration gates. No workflow codemod
or manual source edit was required.

This result keeps the phase-one decision from the runtime mirror experiment:
Rivet continues using exact upstream action pins instead of adopting a runtime
mirror. The experiment records `v0.86.3` as an upgrade candidate; it does not
change Rivet’s supported compiler from `v0.86.2`.

## Immutable candidate receipts

| Boundary                               | Exact receipt                                                      |
| -------------------------------------- | ------------------------------------------------------------------ |
| Compiler tag                           | `v0.86.3`                                                          |
| Compiler commit                        | `6062cd2238b68226eb2bfd47607703ed7944330f`                         |
| Matching `github/gh-aw-actions` commit | `30aadb1626371455f145991c6385924babda2d04`                         |
| Published                              | `2026-08-15T17:18:49Z`                                             |
| Compiler assets                        | Six Rivet-supported platform assets with size and SHA-256 receipts |

The binary manager downloaded and verified the candidate before execution. The
compiler ran with strict validation, `--action-mode action`, and the matching
full action commit.

## Compiled comparison

The experiment compiled a temporary copy of the checked-in Rivet review
fixture. The source Markdown and native import required no changes.

| Surface                            | Result                     |
| ---------------------------------- | -------------------------- |
| Trigger and permissions            | Unchanged                  |
| Secrets and variables              | Unchanged                  |
| Native and runtime imports         | Unchanged                  |
| Local Rivet actions                | Unchanged                  |
| Checkout authority                 | Unchanged                  |
| Write-capable and Safe Output jobs | Unchanged                  |
| Base-branch trust assessment       | Trusted before and after   |
| Generated lock diff                | 32 additions, 30 deletions |

The generated changes were expected runtime supply-chain movement:

- `github/gh-aw-actions/setup` moved from the `v0.86.2` matching commit to the
  `v0.86.3` matching commit.
- The AWF runtime moved from `v0.27.44` to `v0.28.1`, including new SHA-256
  digests for its agent, API proxy, and Squid images.
- gh-aw added shell-expansion-guard outcome propagation.
- Compiler and runtime version receipts changed to `v0.86.3`.

The candidate lock file remained outside the repository because this PR proves
the upgrade path without promoting the supported compiler.

## Migration and mirror gates

The candidate compiler’s non-writing `gh aw fix rivet-review` scan reported
`No workflow fixes needed`. The source compiled directly, so manual conflict
resolution was zero files and zero lines.

The generated runtime mirror was not regenerated because Rivet has zero
overlays and the preceding experiment rejected adopting an unused mirror. The
exact matching upstream action commit was used instead. If Rivet later adopts a
mirror, the same adjacent-version exercise must also regenerate it and verify
its overlay receipts.

## Promotion boundary

Promoting `v0.86.3` is separate from this experiment. It requires changing the
supported release constant, regenerating the checked-in lock file, rerunning
the affected package and installer boundaries, and obtaining any required live
adopter evidence at that final exact commit.
