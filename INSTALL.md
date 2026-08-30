# Install Rivet in a GitHub.com repository

Rivet is installed from npm and run from the repository checkout you want to
configure. The normal path is one guided command:

```bash
cd /path/to/repository
npx @coryparry/rivet init
```

The guided installer detects the checkout, walks you through the unavoidable
GitHub App creation/installation and model-key steps, verifies the exact
review authority, and creates a draft setup pull request. It never merges.
App creation and installation remain human-controlled GitHub.com operations;
Rivet does not bypass 2FA. It never prints provider-secret values or puts them
in command arguments, and it keeps no local copy.

## Requirements

- GitHub.com; GitHub Enterprise Server is not supported.
- Node.js 22 or newer, Git, and an authenticated
  [GitHub CLI](https://cli.github.com/).
- Repository administration permission. An organization-owned App also needs
  organization authority.
- Access to a `CODEX_API_KEY` or `OPENAI_API_KEY` provider credential.

The model secret is required for reviews. Guided init uses an existing Actions
secret or asks the GitHub CLI to create one; manual setups can use
`gh secret set`. Rivet never prints the value or puts it in command arguments,
and it keeps no local copy. An exported value is read only to pass it to
`gh secret set` over standard input. Review starts with least authority. Repair
remains a separate, explicit authority upgrade.

## What the guided installer does

Rivet guides the human-controlled setup in this order:

1. Detects and validates the current GitHub repository checkout.
2. Provides the minimum review-only GitHub App authority and the GitHub.com
   steps needed to create and install that App.
3. Prompts for the remaining setup information, passes any model secret to
   `gh secret set` over standard input, and verifies the App's effective
   authority. The value is never printed or put in command arguments, and
   Rivet keeps no local copy.
4. Compiles and validates the managed workflows and creates a verified draft
   `rivet/setup-review` pull request.

Review the draft pull request and merge it through your repository's normal
controls. Rivet never merges it automatically.

## Advanced/manual setup

Use these lower-level commands for explicit planning, recovery, or automation.
They are not required for the normal guided install.

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
private key to `gh secret set` over standard input. Manual `app-configure` does
not handle the model-provider secret. Verify the App's live identity and
least-privilege scope after installing it:

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
eligible pull request. Issue implementation, maintenance, and merge remain
disabled in the shipped configuration; Rivet never merges.

## Prove the first live review

After merging the setup pull request, open a small pull request against the
default branch. A successful Rivet App-authored review proves that GitHub can
mint an installation token from the stored credentials.
Keep Rivet's review result optional in branch protection until this live proof
succeeds; existing build, test, approval, security, and deployment gates remain
independently required.

## Supported limits

- Issue implementation, maintenance, and merge remain disabled.
- Persistent shared self-hosted runners are outside the supported trust
  boundary.
- Repair must use repository-specific deterministic validation commands; the
  shipped fallback is only a starting point to review before enabling repair.

See [Rivet GitHub App authority](docs/RIVET_GITHUB_APP_AUTHORITY.md),
[Rivet installer contract](docs/RIVET_REVIEW_ONLY_INSTALLER.md), and
[Rivet repair qualification](docs/RIVET_REPAIR_QUALIFICATION.md) for the full
security and evidence boundaries.
