# Rivet

[![npm](https://img.shields.io/npm/v/@coryparry/rivet?style=for-the-badge&label=npm)](https://www.npmjs.com/package/@coryparry/rivet)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)
[![License](https://img.shields.io/badge/License-Apache--2.0-2563eb?style=for-the-badge)](LICENSE)

Rivet installs GitHub Agentic Workflows for bounded pull-request review and
owner-authorized repair. It compiles the managed workflows with a pinned,
checksum-verified `gh-aw` release, so adopters do not need to install `gh-aw`
separately.

Rivet is early software. Start with review-only mode, inspect the generated
setup pull request, and keep your existing tests, approvals, security checks,
and deployment gates independently required.

## Current capability

| Capability                                   | Shipped behavior                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull-request review                          | Runs automatically for supported same-repository pull requests and publishes bounded App-authored review output.                                         |
| Issue triage                                 | Runs automatically with Issues write authority; issue implementation remains disabled.                                                                  |
| Repair                                       | Disabled by default. A repository administrator must explicitly widen the App authority and install repair mode; an exact owner command starts a repair. |
| Issue implementation, maintenance, and merge | Disabled in the shipped configuration. Rivet never merges a pull request.                                                                                |

## Requirements

- Node.js 22 or newer
- An existing GitHub.com repository checkout
- Git and an authenticated [GitHub CLI](https://cli.github.com/)
- Repository administration permission for App and credential configuration
- A Codex provider key stored as the repository secret `CODEX_API_KEY` or
  `OPENAI_API_KEY`

## Quick start: review-only

Run Rivet without a global install. First, generate the minimum GitHub App
authority and a private, webhook-free registration URL:

```bash
npx --yes @coryparry/rivet app-plan --repository OWNER/REPOSITORY
```

Open the returned URL, create the App, and download its private key. For an
organization-owned App, add `--owner-type Organization`.

Configure the selected repository with the App client ID and private key:

```bash
npx --yes @coryparry/rivet app-configure \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

Use the returned installation URL to install the App only on the selected
repository, then verify its effective authority:

```bash
npx --yes @coryparry/rivet app-verify \
  --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID \
  --private-key-file /path/to/private-key.pem
```

The default `codex` engine also needs one model-provider secret. Set it through
the GitHub CLI so the value is read securely and never appears in the command:

```bash
gh secret set CODEX_API_KEY --repo OWNER/REPOSITORY
```

`OPENAI_API_KEY` is accepted instead. Neither `app-configure` nor `rivet init`
sets either provider secret.

Preview the managed files without changing the checkout:

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
draft pull request, and never merges it. Use `--setup-branch <name>` to choose
another unused branch.

See [INSTALL.md](INSTALL.md) for the complete review and repair setup flow.

## Repair

Repair is an explicit authority upgrade. Change the App's Contents permission
from read to write in GitHub, verify that exact scope, and then preview the
managed upgrade:

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
request. A repository administrator starts a repair with the exact
`/rivet-repair` pull-request comment after the upgrade is merged.

## Safety model

- **Repository-owned automation.** The workflows, App, credentials, policy,
  and Actions usage stay in the adopter repository.
- **Review before mutation.** `--setup-pr` creates a verified draft pull
  request and never merges it.
- **Least authority first.** Review-only uses Contents read authority; repair
  requires a separate, verified Contents write upgrade.
- **Fail-closed installation.** Rivet refuses adopter-owned file collisions,
  stale plans, unsafe checkout state, compiler drift, and unexpected App
  authority.
- **Pinned compiler.** Managed workflows are compiled with a checksum-verified
  `gh-aw` binary and retain its trust-boundary checks.

Read the [GitHub App authority guide](docs/RIVET_GITHUB_APP_AUTHORITY.md),
[installer contract](docs/RIVET_REVIEW_ONLY_INSTALLER.md), and
[repair qualification](docs/RIVET_REPAIR_QUALIFICATION.md) for the exact
boundaries.

## Installation behavior

`--dry-run` writes nothing to the repository checkout. `--setup-pr` requires a
clean checkout at the fetched remote default branch and creates a verified
draft pull request. Without either option, `rivet init` applies the verified
plan directly to the existing repository path. Rivet creates no repository
when the path is wrong.

## Develop from source

```bash
env npm_config_cache=/tmp/rivet-npm-cache npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Use [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations and
[docs/AGENT_RELEASE_SAFETY.md](docs/AGENT_RELEASE_SAFETY.md) for release work.
Documents explicitly marked as a legacy baseline or migration record preserve
Codekeeper history; they are not current installation instructions.

## Security

Do not commit model-provider keys, GitHub App private keys, tokens, or live
traces. Report vulnerabilities through GitHub private vulnerability reporting
as described in [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
