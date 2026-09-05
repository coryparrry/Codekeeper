# Install Rivet in a GitHub.com repository

Rivet is installed from npm and run anywhere inside the repository checkout you
want to configure. Start from a clean checkout whose `HEAD` matches the fetched
remote default branch:

```bash
cd /path/to/repository/or/a/nested/directory
npx @coryparry/rivet init
```

The guided installer resolves the Git repository root, opens the private GitHub
App registration page, and pauses for you to create and install the App on
GitHub.com. It then configures the repository credentials, verifies the exact
App and selected repository, configures model access, and creates a verified
draft setup pull request. Rivet never merges that pull request.

## Requirements

- GitHub.com; GitHub Enterprise Server is not supported.
- Node.js 22 or newer, Git, and an authenticated
  [GitHub CLI](https://cli.github.com/).
- Repository administration permission. An organization-owned App also needs
  organization authority.
- A clean checkout at the fetched remote default-branch commit.
- Access to a `CODEX_API_KEY` or `OPENAI_API_KEY` provider credential.

The model secret is required for reviews. Guided init reuses an existing Actions
secret, accepts an exported provider key, or asks for the value through a secure
prompt. It sends a new value only to `gh secret set` over standard input. Rivet
never prints the value, puts it in command arguments, or keeps a local copy.
Review starts with least authority. Repair remains a separate, explicit
authority upgrade.

## What the guided installer does

Rivet guides the human-controlled setup in this order:

1. Resolves the repository root even when invoked from a nested directory, then
   validates the clean checkout, GitHub.com origin, administrator access, and
   exact remote default-branch commit.
2. Compiles and checks the planned managed workflows before changing the
   repository or its settings.
3. Opens a private, webhook-free GitHub App registration page with the default
   review permissions: Contents read, Metadata read, Pull requests write, and
   Issues write for automatic issue triage. You create the App and download its
   private-key PEM on GitHub.com.
4. Authenticates the PEM, saves `RIVET_APP_CLIENT_ID` and
   `RIVET_APP_BOT_LOGIN` as repository variables, and sends the key to the
   `RIVET_APP_PRIVATE_KEY` repository secret over standard input.
5. Opens the App installation page for you to select only this repository, then
   verifies that repository selection, identity, permissions, events, variables,
   and secret metadata.
6. Reuses an existing model secret or securely stores the selected
   `CODEX_API_KEY` or `OPENAI_API_KEY`, then creates and verifies the draft
   `rivet/setup-review` pull request.

Review the draft pull request and its checks. Mark it ready for review and merge
it through your repository's normal controls to activate Rivet.

On an existing review-only installation, bare `init` loads the installed
configuration from the resolved repository root and preserves its settings,
including customized review limits and model choices. It can upgrade recognized
historical Rivet-managed workflow versions while rejecting locally edited
managed files. If the installation is already current, it stops with a
`review-only installation is already up to date` error and creates no setup pull
request. If repair is already enabled, it directs you to:

```bash
npx @coryparry/rivet init --repair --setup-pr
```

## Advanced/manual setup

Use these lower-level commands for explicit planning, recovery, or automation.
They are not required for the normal guided install.
Explicit `init` does not search parent directories for the Git root, so run it
from the repository root or pass `--repository /path/to/repository`.

### Plan, configure, and verify the App

Generate the minimum review-only App authority and a private, webhook-free
GitHub App registration URL:

```bash
npx @coryparry/rivet app-plan --repository OWNER/REPOSITORY
```

For an organization-owned App, add `--owner-type Organization`. Open the
returned URL, create the App on GitHub.com, download its private key, keep the
generated permissions unchanged, and install it only on the selected
repository.

Configure the repository variables and private-key secret:

```bash
npx @coryparry/rivet app-configure \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

Rivet authenticates the key before changing repository metadata and sends the
private key to `gh secret set` over standard input. Absolute paths and paths
beginning with `~/` are supported. The reader accepts only a bounded regular
file, refuses symlinks where the platform supports that check, detects a key
that changes while being read, and validates the key before use. Manual
`app-configure` does not handle the model-provider secret. Verify the App's live
identity and least-privilege scope after installing it:

```bash
npx @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

The review-only App requires Contents read, Metadata read, Pull requests write,
Issues write for automatic triage, and no webhook events or additional
repository permissions. The private key is stored as `RIVET_APP_PRIVATE_KEY`;
the verified client ID and App bot login are stored as repository variables.

### Configure model access

Store one accepted provider credential as a repository Actions secret. Enter
the value only when the GitHub CLI reads it securely; do not put it in the
command, repository, setup pull request, or logs:

```bash
gh secret set CODEX_API_KEY --repo OWNER/REPOSITORY
```

`OPENAI_API_KEY` is an accepted alternative. Manual `app-configure` and
explicit `init --review-only` do not set provider credentials; guided init asks
you to provide the selected secret directly to the GitHub CLI.

### Explicit review-only installation

Select `init --review-only` when a script or recovery procedure must choose the
mode explicitly. From the target checkout, preview without writing:

```bash
npx @coryparry/rivet init --review-only --dry-run
```

The recommended write path is a draft setup pull request from a clean checkout
whose `HEAD` exactly matches the fetched remote default branch:

```bash
npx @coryparry/rivet init --review-only --setup-pr
```

Rivet commits only managed paths, pushes the exact commit, opens a draft pull
request, and verifies its base, head, commit, draft state, and URL. Use
`--setup-branch <name>` to choose another unused branch.

Explicit init writes machine-readable JSON to standard output. When standard
error is a TTY it reports progress there; non-TTY runs remain quiet on standard
error.

For direct installation into the existing checkout, omit both `--dry-run` and
`--setup-pr`:

```bash
npx @coryparry/rivet init --review-only
```

The repository must already exist. Rivet refuses adopter-owned file collisions
and rechecks managed destinations immediately before writing.

### Owner-authorized repair

Repair is a separate authority upgrade. In GitHub, widen only the App's
Contents permission from read to write, then verify that exact scope:

If GitHub requests approval for the updated App permissions, complete that
[approval](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)
before running the verification command.

```bash
npx @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem \
  --repair
```

Preview the repair workflow, or create its draft upgrade pull request:

```bash
npx @coryparry/rivet init --repair --dry-run
npx @coryparry/rivet init --repair --setup-pr
```

The default branch is `rivet/setup-repair`. After that pull request merges, a
repository administrator can post the exact `/rivet-repair` command on an
eligible pull request. Issue implementation and merge remain disabled; Rivet
never merges.

### Report-only maintenance

Maintenance is disabled by default. Enable a manual or weekly audit in the
setup pull request without adding GitHub App authority:

```bash
npx @coryparry/rivet init --review-only --maintenance scheduled --setup-pr
```

Use `manual` instead of `scheduled` to omit the weekly trigger. Both modes run
the repository-auditor identity on the default branch and retain one validated
seven-day JSON artifact. They cannot create or change GitHub objects or code.
Use `--maintenance disabled` to remove an existing Rivet-owned maintenance
workflow through the same verified setup flow.

## Prove the first live review

After merging the setup pull request, open a small pull request against the
default branch. A successful Rivet App-authored review proves that GitHub can
mint an installation token from the stored credentials.
Keep Rivet's review result optional in branch protection until this live proof
succeeds; existing build, test, approval, security, and deployment gates remain
independently required.

## Supported limits

- Issue implementation and merge remain disabled.
- Maintenance is disabled by default and report-only when enabled.
- Persistent shared self-hosted runners are outside the supported trust
  boundary.
- Repair must use repository-specific deterministic validation commands; the
  shipped fallback is only a starting point to review before enabling repair.

See [Rivet GitHub App authority](docs/RIVET_GITHUB_APP_AUTHORITY.md),
[Rivet installer contract](docs/RIVET_REVIEW_ONLY_INSTALLER.md), and
[Rivet repair qualification](docs/RIVET_REPAIR_QUALIFICATION.md) for the full
security and evidence boundaries.
