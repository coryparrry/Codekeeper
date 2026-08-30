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
| Pull-request review                          | Publishes bounded App-authored review output for eligible pull requests.                                                                                 |
| Issue triage                                 | Runs automatically with Issues write authority; issue implementation remains disabled.                                                                   |
| Repair                                       | Disabled by default. A repository administrator must explicitly widen the App authority and install repair mode; an exact owner command starts a repair. |
| Issue implementation, maintenance, and merge | Disabled in the shipped configuration. Rivet never merges a pull request.                                                                                |

## Requirements

- GitHub.com (GitHub Enterprise Server is not supported)
- Node.js 22 or newer
- An existing repository checkout, Git, and an authenticated
  [GitHub CLI](https://cli.github.com/)
- Repository administration permission; organization-owned Apps also require
  organization authority
- Access to a `CODEX_API_KEY` or `OPENAI_API_KEY` provider credential

## Quick start

From the root of the repository you want to configure, run:

```bash
npx @coryparry/rivet init
```

The guided installer detects the checkout, walks you through the unavoidable
GitHub App and model-key human steps, verifies the exact review authority, and
creates a draft setup pull request. App creation and installation remain
human-controlled GitHub.com operations. Rivet never bypasses 2FA or merges the
setup pull request. It never prints provider-secret values or puts them in
command arguments, and it keeps no local copy.

Guided init uses an existing Actions secret or asks the GitHub CLI to create
one; manual setups can use `gh secret set`. One of `CODEX_API_KEY` or
`OPENAI_API_KEY` is required for reviews. Rivet never prints the value or puts
it in command arguments, and it keeps no local copy. An exported value is read
only to pass it to `gh secret set` over standard input. Review starts with least
authority. Repair is a separate, explicit App authority upgrade.

See [INSTALL.md](INSTALL.md) for the complete guided, verification, and repair
flow.

## Advanced/manual setup

The explicit commands remain available for preview, recovery, and automation:

```bash
npx @coryparry/rivet app-plan --repository OWNER/REPOSITORY
npx @coryparry/rivet app-configure --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID --private-key-file /path/to/private-key.pem
npx @coryparry/rivet app-verify --repository OWNER/REPOSITORY \
  --client-id CLIENT_ID --private-key-file /path/to/private-key.pem
```

Use `init --review-only` or explicit `init --repair` when selecting a mode. Add
`--dry-run` to preview, `--setup-pr` to create a verified draft setup PR, or
omit both to write directly to the existing checkout. Repair requires widening
only the App's Contents permission and passing `app-verify --repair` first.

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

Bare `rivet init` starts the guided review-only setup and creates a verified
draft pull request. For explicit modes, `--dry-run` writes nothing to the
repository checkout, while `--setup-pr` requires a clean checkout at the
fetched remote default branch. Direct writes are available only through an
explicit mode without either option. Rivet creates no repository when the path
is wrong.

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
