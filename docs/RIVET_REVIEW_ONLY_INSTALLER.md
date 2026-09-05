# Rivet review and repair installer

## Scope

Rivet installs review-only mode with automatic issue triage or enables
owner-authorized repair on top of a verified review installation. Maintenance
is a separate manual or weekly report-only artifact; it has no GitHub App
permission or mutation path. Issue implementation and merge behavior remain
disabled in `.github/rivet.json`.

For the normal interactive path, run bare init from any directory inside a
clean Git checkout:

```bash
npx @coryparry/rivet init
```

Rivet resolves the repository root, validates that `HEAD` matches the fetched
remote default branch, and compiles the planned workflows. It then opens the
GitHub App registration and installation pages for the administrator to
complete, configures and verifies the App repository credentials, configures a
model secret, and creates a verified draft setup pull request. The administrator
reviews, marks ready, and merges that pull request to activate Rivet; the CLI
never merges it.

```bash
npx @coryparry/rivet init --review-only --repository /path/to/repository --dry-run
```

Removing `--dry-run` writes the reviewed plan. The repository path must already
exist; Rivet does not create a repository when a path is mistyped.

To create a reviewable setup change from a clean checkout of the remote default
branch:

```bash
npx @coryparry/rivet init --review-only --repository /path/to/repository --setup-pr
```

Rivet creates `rivet/setup-review` by default. `--setup-branch <name>` selects a
different unused branch.

After the App passes `app-verify --repair`, preview the repair upgrade with:

```bash
npx @coryparry/rivet init --repair --repository /path/to/repository --dry-run
```

Removing `--dry-run` applies the verified plan. `--setup-pr` creates a draft
upgrade pull request on `rivet/setup-repair` by default.

## Managed installation

The installer renders and validates these Rivet-owned surfaces:

- `.github/rivet.json` with review and automatic issue triage enabled, issue
  implementation and merge disabled, optional report-only maintenance, and
  repair either disabled in review-only mode or owner-authorized in repair
  mode;
- `.github/rivet/installation.json` with the compiler/action receipt and exact
  managed-file inventory;
- the `pr-reviewer` agent profile, review workflow Markdown source, and compiled
  lock;
- the incoming issue-triage profile, Markdown source, and compiled lock when
  automatic triage is enabled;
- the local native import plus dependency-free prepare-review-context and
  authority-receipt actions.

Repair mode also manages the repair workflow source and compiled lock plus the
isolated validation and App-authenticated publication actions. Its receipt
preserves Issues write for automatic triage, widens only Contents from read to
write, and records owner authorization explicitly.

The package assets are the canonical extension source. Tests and installation
use that same copy.

When maintenance is enabled, the installer manages the scheduled or manual
report-only workflow and its validator action. The workflow uses the packaged
`repository-auditor` identity, uploads the validated artifact, and adds no App
authority or mutation path.

An existing valid `.github/rivet.json` remains the installation configuration.
Explicit overrides change only the selected issue, maintenance, or repair
setting; customized values such as the model and maximum finding count remain
intact. Recognized historical managed workflows can be upgraded in place.
Semantically equivalent compiled locks retain their existing bytes, avoiding
format-only churn, while locally edited or unknown managed states fail closed.

## Safety order

Before changing the adopter repository, Rivet:

1. creates an isolated staging directory;
2. renders the managed source and extension assets;
3. validates and compiles with the pinned gh-aw binary;
4. inspects the generated lock files;
5. requires the base-branch `pull_request_target` review trust contract and,
   when enabled, the issues-only triage trust contract, including immutable
   action and container pins;
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

Bare `npx @coryparry/rivet init` stops with a
`review-only installation is already up to date` error before creating a setup
pull request when no managed change is needed. When the installed configuration
already enables repair, bare init stops early and directs the operator to
`npx @coryparry/rivet init --repair --setup-pr`.

Explicit init writes its result as JSON on standard output. Progress appears on
standard error only when it is a TTY, so noninteractive callers receive no
progress chatter and keep stable machine-readable output.

## GitHub App boundary

The generated review workflow mints short-lived installation tokens from the
`RIVET_APP_CLIENT_ID` and `RIVET_APP_BOT_LOGIN` repository variables plus the
`RIVET_APP_PRIVATE_KEY` secret.
The default installer records the minimum authority for review plus automatic
issue triage: Contents read, Issues write, Metadata read, and Pull requests
write. Disabling triage removes Issues permission. Repair preserves the selected
review permissions and widens only Contents to write.
`npx @coryparry/rivet app-plan` produces a private, webhook-free registration
URL for the administrator to use on GitHub.com; it does not create the App.

`npx @coryparry/rivet app-configure` accepts absolute or `~/` PEM paths, safely
reads a bounded regular file, uploads the key as a repository secret, and sets
the verified variables. App creation and installation remain
administrator-controlled GitHub operations.
`npx @coryparry/rivet app-verify --repair` must pass before enabling repair.
