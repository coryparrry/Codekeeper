# Rivet runtime mirror experiment

## Decision

Rivet does not mirror `github/gh-aw-actions` in the first migration phase. The
compiled workflows continue to pin that repository at the exact action commit
selected by the pinned gh-aw compiler release.

The generator remains as an experiment boundary. It makes a future mirror
repeatable if Rivet develops an upstream overlay that cannot be supplied as a
separate extension action. It is not connected to workflow rendering,
packaging, or installation.

## Exact-commit result

The experiment checked out
[`github/gh-aw-actions@6aab9e5b5c91c615506061f09bedd81a23babe3c`](https://github.com/github/gh-aw-actions/tree/6aab9e5b5c91c615506061f09bedd81a23babe3c)
and generated a mirror with no overlays:

| Receipt          |                  Result |
| ---------------- | ----------------------: |
| Regular files    |                     588 |
| File bytes       |               5,465,124 |
| Executable files |                      43 |
| Rivet overlays   |                       0 |
| Required license | MIT `LICENSE` preserved |

The generated payload was written outside the repository and was not
committed. These measurements describe only that exact upstream commit.

## Generator contract

`generateRuntimeMirror`:

- copies regular files in deterministic path order and rejects symbolic links
  and special files;
- requires the upstream root `LICENSE`;
- preserves file modes and records each output size and SHA-256;
- records the exact upstream repository and full commit;
- applies an overlay only when its expected upstream SHA-256 still matches;
- writes into a new output directory and emits
  `rivet-runtime-manifest.json`.

An upstream change to an overlaid file therefore stops generation instead of
silently carrying a Rivet patch onto different code.

## Adoption gate

A later PR may adopt a generated mirror only when all of these are true:

1. Rivet has a concrete runtime change that cannot remain a separate local
   extension action.
2. The source commit, preserved license, output manifest, and overlay receipts
   are checked in or published together.
3. The generated payload is validated at its packaged and executed boundary,
   not only by source tests.
4. The maintenance cost is re-measured against the then-current pinned action
   commit.

Until that gate is met, direct immutable upstream action pins are the smaller
and more auditable design.
