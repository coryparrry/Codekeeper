# Rivet

Rivet installs GitHub Agentic Workflows for bounded pull-request review and
incoming issue triage. Owner-authorized repair is optional. Rivet compiles the
managed workflows with a pinned, checksum-verified `gh-aw` release; you do not
need to install `gh-aw`.

## Quick start

From the root of the GitHub repository you want to configure:

```bash
npx @coryparry/rivet init
```

The guided installer detects the repository, walks you through the unavoidable
GitHub App and model-key steps, verifies the exact review authority, and creates
a draft setup pull request. It never merges. App creation and installation
remain human-controlled GitHub.com operations; Rivet does not bypass 2FA or
print provider-secret values or put them in command arguments, and it keeps no
local copy.

## Requirements

- GitHub.com (GitHub Enterprise Server is not supported)
- Node.js 22 or newer
- An existing repository checkout, Git, and an authenticated
  [GitHub CLI](https://cli.github.com/)
- Repository administration permission; organization-owned Apps also require
  organization authority
- Access to a `CODEX_API_KEY` or `OPENAI_API_KEY` provider credential

The model secret is required for reviews. Guided init uses an existing Actions
secret or asks the GitHub CLI to create one; manual setups can use
`gh secret set`. Rivet never prints the value or puts it in command arguments,
and it keeps no local copy. An exported value is read only to pass it to
`gh secret set` over standard input. Review starts with least authority. Repair
is a separate, explicit App authority upgrade.

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
opened issues. It may publish at most one App-authored triage comment; it does
not label or close the issue, implement a fix, open a pull request, or merge.

The same setting lets a pull-request review defer at most one verified,
out-of-scope finding to a new issue. That is separate from triaging an incoming
issue and does not authorize implementation. Set triage to `disabled` to
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
separate authority upgrade and `app-verify --repair` first.

## License

Apache-2.0
