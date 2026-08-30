# Rivet

Rivet installs GitHub Agentic Workflows for bounded pull-request review and
owner-authorized repair. It compiles workflows with a pinned, checksum-verified
`gh-aw` release; users do not need to install `gh-aw` separately.

## Requirements

- Node.js 22 or newer
- An existing GitHub repository checkout
- Git and an authenticated [GitHub CLI](https://cli.github.com/) for App
  configuration and the setup-pull-request flow

## Quick start: review-only

Run Rivet without a global install:

```bash
npx --yes @coryparry/rivet app-plan --repository OWNER/REPOSITORY
```

The command prints the minimum review authority and a private, webhook-free
GitHub App registration URL. Open that URL, create the App, and download its
private key. For an organization-owned App, add `--owner-type Organization`.

Configure the repository with the App client ID and private key:

```bash
npx --yes @coryparry/rivet app-configure \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

Rivet verifies the key before setting the repository variables and secret. Use
the returned installation URL to install the App on the selected repository,
then verify its effective authority:

```bash
npx --yes @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

The shipped review workflow uses the Codex engine. Add either `CODEX_API_KEY`
or `OPENAI_API_KEY` as a repository secret before the first review. Neither App
setup nor `rivet init` configures model-provider credentials:

```bash
gh secret set CODEX_API_KEY --repo OWNER/REPOSITORY
```

Preview the managed workflow files without changing the checkout:

```bash
npx --yes @coryparry/rivet init --review-only \
  --repository /path/to/repository \
  --dry-run
```

From a clean checkout whose `HEAD` matches the remote default branch, create a
draft setup pull request:

```bash
npx --yes @coryparry/rivet init --review-only \
  --repository /path/to/repository \
  --setup-pr
```

Rivet creates `rivet/setup-review` by default, verifies the pushed commit and
draft pull request, and never merges it automatically. Use
`--setup-branch <name>` to select another unused branch.

## Repair

Repair is an explicit authority upgrade. Widen the App's Contents permission
from read to write in GitHub, verify the exact scope with `app-verify --repair`,
then preview or create the repair setup pull request:

```bash
npx --yes @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem \
  --repair

npx --yes @coryparry/rivet init --repair \
  --repository /path/to/repository \
  --dry-run
```

Replace `--dry-run` with `--setup-pr` to create the draft repair upgrade pull
request. Issue implementation, maintenance, and merge authority remain
disabled in the shipped configuration.

## Installation behavior

`--dry-run` writes nothing to the repository checkout. Without `--dry-run` or
`--setup-pr`, `rivet init` applies the verified plan directly to the existing
repository path. Rivet refuses adopter-owned file collisions and rechecks
managed destinations before writing.

For the complete authority and installer contracts, see the
[GitHub App guide](https://github.com/coryparrry/Rivet/blob/main/docs/RIVET_GITHUB_APP_AUTHORITY.md)
and
[installer guide](https://github.com/coryparrry/Rivet/blob/main/docs/RIVET_REVIEW_ONLY_INSTALLER.md).

## License

Apache-2.0
