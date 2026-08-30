# Rivet review and repair installer

## Scope

Rivet installs review-only mode with automatic issue triage or enables
owner-authorized repair on top of a verified review installation. Issue
implementation, maintenance, and merge behavior remain disabled in
`.github/rivet.json`.

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

After the App passes `app-verify --repair`, preview the repair upgrade with:

```bash
rivet init --repair --repository /path/to/repository --dry-run
```

Removing `--dry-run` applies the verified plan. `--setup-pr` creates a draft
upgrade pull request on `rivet/setup-repair` by default.

## Managed installation

The installer renders and validates these Rivet-owned surfaces:

- `.github/rivet.json` with review and automatic issue triage enabled, issue
  implementation, maintenance, and merge disabled, and repair either disabled
  in review-only mode or owner-authorized in repair mode;
- `.github/rivet/installation.json` with the compiler/action receipt and exact
  managed-file inventory;
- the review workflow Markdown source and compiled lock;
- the local native import and dependency-free authority-receipt action.

Repair mode also manages the repair workflow source and compiled lock plus the
isolated validation and App-authenticated publication actions. Its receipt
preserves Issues write for automatic triage, widens only Contents from read to
write, and records owner authorization explicitly.

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
8. rechecks every destination immediately before applying the plan;
9. creates new files and updates only exact bytes from the prior managed review
   receipt.

A compiler, validation, trust, collision, or stale-plan failure therefore
occurs before the installer writes a managed file. Re-running an identical
installation is idempotent and reports the files as unchanged. Repair upgrade
refuses a modified review workflow, config, receipt, or repair asset; it has no
generic overwrite option.

The setup-PR path additionally requires a clean checkout whose `HEAD` exactly
matches the fetched remote default branch. It commits only the managed paths,
pushes that exact commit to a previously unused branch, creates a draft pull
request, and verifies its base, head, commit, draft state, and URL. It never
requests a merge.

## GitHub App boundary

The generated review workflow mints short-lived installation tokens from the
`RIVET_APP_CLIENT_ID` and `RIVET_APP_BOT_LOGIN` repository variables plus the
`RIVET_APP_PRIVATE_KEY` secret.
The installer records the minimum review-only App authority: Contents read,
Issues write, Metadata read, and Pull requests write. Repair preserves those
permissions and widens only Contents to write. `rivet app-plan` produces a
private, webhook-free registration URL.

`rivet app-configure` uploads the PEM as a repository secret and sets the
verified variables. App creation and installation remain administrator-controlled
GitHub operations. `rivet app-verify --repair` must pass before enabling repair.
