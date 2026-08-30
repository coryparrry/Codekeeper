# Rivet review-only installer core

## Scope

The first Rivet installer path manages review mode only. Repair, issue triage,
maintenance, and merge behavior remain disabled in `.github/rivet.json`.

```bash
rivet init --review-only --repository /path/to/repository --dry-run
```

Removing `--dry-run` writes the reviewed plan. The repository path must already
exist; Rivet does not create a repository when a path is mistyped.

## Managed installation

The installer renders and validates these Rivet-owned surfaces:

- `.github/rivet.json` with review enabled and every mutation mode disabled;
- `.github/rivet/installation.json` with the compiler/action receipt and exact
  managed-file inventory;
- the review workflow Markdown source and compiled lock;
- the local native import and dependency-free authority-receipt action.

The package assets are the canonical extension source. Tests and installation
use that same copy.

## Safety order

Before changing the adopter repository, Rivet:

1. creates an isolated staging directory;
2. renders the managed source and extension assets;
3. validates and compiles with the pinned gh-aw binary;
4. inspects the generated lock file;
5. requires the base-branch `pull_request_target` trust contract, including
   immutable action and container pins;
6. compares every managed destination with the planned bytes;
7. refuses any adopter-owned collision;
8. writes only files that do not already exist.

A compiler, validation, trust, or collision failure therefore occurs before
the installer writes a managed file. Re-running an identical installation is
idempotent and reports the files as unchanged.

## Deliberate boundary

This PR establishes the local installer core. It does not create or widen a
GitHub App, store secrets, create a setup branch, or open a pull request. Those
are external authority changes and remain separate layers on top of the
verified local plan. Until those layers land and pass live adopter validation,
this is not the milestone’s one-command external-repository installation.
