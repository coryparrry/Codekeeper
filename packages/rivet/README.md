# Rivet

Rivet installs GitHub Agentic Workflows for bounded pull-request review and
incoming issue triage. Owner-authorized repair is optional. Rivet compiles the
managed workflows with a pinned, checksum-verified `gh-aw` release; you do not
need to install `gh-aw`.

## Quick start

From any directory inside a clean GitHub repository checkout whose `HEAD`
matches the fetched remote default branch:

```bash
npx @coryparry/rivet init
```

The guided installer resolves the repository root, opens the GitHub App
registration and installation pages, and pauses for you to complete those
GitHub.com steps. It configures and verifies the App for the target repository
in selected-repository mode, configures model access, and creates a verified draft setup pull
request. Review it, mark it ready, and merge it through your normal controls to
activate Rivet. Rivet never merges it.

## Requirements

- GitHub.com (GitHub Enterprise Server is not supported)
- Node.js 22 or newer
- An existing repository checkout, Git, and an authenticated
  [GitHub CLI](https://cli.github.com/)
- Repository administration permission; organization-owned Apps also require
  organization authority
- Access to a `CODEX_API_KEY` or `OPENAI_API_KEY` provider credential

The default review App authority is Contents read, Metadata read, Pull requests
write, and Issues write for automatic issue triage, with webhooks disabled.
Guided init reuses an existing Actions model secret, accepts an exported
`CODEX_API_KEY` or `OPENAI_API_KEY`, or asks for it through a secure prompt. New
secret values and the App PEM go to `gh secret set` over standard input; Rivet
does not print them, put them in command arguments, or keep local copies.
Private-key paths may begin with `~/`.

On an existing review-only installation, the same command preserves customized
configuration and upgrades recognized historical Rivet-managed workflows. An
already-current installation stops with a
`review-only installation is already up to date` error and creates no pull
request. An existing repair installation instead directs you to
`npx @coryparry/rivet init --repair --setup-pr`.

## Maintenance reports

The repository-auditor identity supports a manual or weekly report-only
maintenance run. It produces a validated JSON artifact for review and does not
create an issue, pull request, comment, commit, label, or merge. It needs no
GitHub App permission; use the configured `models.review` engine and model
(Codex `gpt-5.6-luna` by default).

```bash
npx @coryparry/rivet init --review-only --maintenance scheduled --setup-pr
```

Use `--maintenance disabled` to remove a previously enabled Rivet-owned
maintenance workflow.

## Issue triage

With `issues.triage` set to `automatic`, Rivet installs a workflow for newly
opened issues. It may publish one App-authored triage comment, remember the
specific information it requested, and reassess the issue when the reporter or
a repository collaborator replies. It does not label or close the issue,
implement a fix, open a pull request, or merge.

Pull-request reviews also receive bounded prior Rivet reviews, comments, and
exact-head source context so repeated findings can be suppressed only when the
current change still supports that conclusion. Each completed review also
reconciles one status label (`changes required`, `review needed`, or
`merge ready`) and the optional `needs tests` label without changing unrelated
repository labels. The same setting lets a review
defer at most one independently verified, out-of-scope finding to a new issue.
That is separate from incoming issue triage and does not authorize
implementation. Set triage to `disabled` to
install neither issue workflow nor Issues permission. Enabling it requires the
GitHub App to have Issues: write; an existing installation may need explicit
approval from a GitHub administrator.

## Advanced/manual setup

Use [INSTALL.md](https://github.com/coryparrry/Rivet/blob/main/INSTALL.md) for
the full guided, verification, and repair flow. The lower-level commands remain
available when you need manual recovery:

```bash
npx @coryparry/rivet app-plan --repository OWNER/REPOSITORY
npx @coryparry/rivet app-configure --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID --private-key-file /path/to/private-key.pem
npx @coryparry/rivet app-verify --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID --private-key-file /path/to/private-key.pem
```

For explicit modes, use `init --review-only` or `init --repair`. Add
`--dry-run` to preview, `--setup-pr` to create a verified draft setup PR, or
omit both to write directly to the existing checkout. Repair requires the
separate authority upgrade and `app-verify --repair` first. Explicit init keeps
standard output as JSON, reports progress to TTY standard error, and emits no
progress text to non-TTY standard error.

## License

Apache-2.0
