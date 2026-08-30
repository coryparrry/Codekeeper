# Rivet review-only installer core

## Scope

The first Rivet installer path manages review mode only. Repair, issue triage,
maintenance, and merge behavior remain disabled in `.github/rivet.json`.

```bash
rivet init --review-only --repository /path/to/repository --dry-run
```

Removing `--dry-run` writes the reviewed plan. The repository path must already
exist; Rivet does not create a repository when a path is mistyped.

To create a reviewable setup change from a clean checkout of the remote default
branch:

```bash
rivet init --review-only --repository /path/to/repository --setup-pr
```

Rivet creates `rivet/setup-review` by default. `--setup-branch <name>` selects a
different unused branch.

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

The setup-PR path additionally requires a clean checkout whose `HEAD` exactly
matches the fetched remote default branch. It commits only the managed paths,
pushes that exact commit to a previously unused branch, creates a draft pull
request, and verifies its base, head, commit, draft state, and URL. It never
requests a merge.

## GitHub App boundary

The generated review workflow mints short-lived installation tokens from the
`RIVET_APP_CLIENT_ID` repository variable and `RIVET_APP_PRIVATE_KEY` secret.
The installer records the minimum review-only App authority, and `rivet
app-plan` produces a private, webhook-free registration URL.

Rivet does not yet upload the PEM, set the variable, install the App, or verify
its effective repository permissions. Those human-controlled GitHub changes
remain a separate layer on top of the verified setup PR. Until that layer lands
and passes live adopter validation, this is not the milestone's one-command
external-repository installation.
