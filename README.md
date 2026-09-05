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

| Capability                                   | Default behavior                                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull-request review                          | Publishes bounded App-authored review output and reconciles status and missing-test labels for eligible pull requests.                                   |
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

From a clean checkout of the repository you want to configure, run:

```bash
npx @coryparry/rivet init
```

The checkout must match the fetched remote default branch. Guided init resolves
its Git root, so invoking it from a subdirectory still loads the repository's
settings. The flow is:

1. Check the checkout, GitHub access, and pinned workflow compiler.
2. Open GitHub's App registration page with review-only permissions. Complete
   GitHub authentication, generate a private key, and install the App only on
   the selected repository.
3. Enter the App client ID and PEM file path; `~/Downloads/...` paths work.
   Rivet verifies the App and stores its credentials in repository Actions
   secrets and variables.
4. Use an existing `CODEX_API_KEY` or `OPENAI_API_KEY` Actions secret, pass an
   exported credential over stdin to `gh secret set`, or enter it securely
   when prompted. Rivet does not print the value, put it in command arguments,
   or keep a local copy.
5. Review the verified draft setup PR, mark it ready, and merge it to activate
   the workflows. Rivet does not merge it for you.

Progress appears on interactive stderr. Explicit commands keep their result on
stdout as JSON. The App, workflows, provider credentials, and Actions usage
belong to the adopter repository; no separate hosted Rivet service is required.

These docs describe the current source. Changes reach `npx @coryparry/rivet`
through a versioned npm release, not by merging the source PR alone.

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
  stale plans, unsafe checkout state, behavior-changing workflow drift, and
  unexpected App authority. Semantically identical compiled locks retain their
  existing bytes.
- **Pinned compiler.** Managed workflows are compiled with a checksum-verified
  `gh-aw` binary and retain its trust-boundary checks.

Read the [GitHub App authority guide](docs/RIVET_GITHUB_APP_AUTHORITY.md),
[installer contract](docs/RIVET_REVIEW_ONLY_INSTALLER.md), and
[repair qualification](docs/RIVET_REPAIR_QUALIFICATION.md) for the exact
boundaries.

## Review status and existing installations

Eligible review events apply `review needed`. Successful publication reconciles
that to `changes required`, `review needed`, or `merge ready`, with `needs tests`
when warranted.
Rivet preserves human-owned labels. These labels report Rivet's assessment;
they do not replace required tests, approvals, or merge rules.

Guided init is for review-only setup. To refresh an existing installation, run
an explicit mode from the repository root:

```bash
npx @coryparry/rivet init --review-only --setup-pr
# For an existing owner-authorized repair installation:
npx @coryparry/rivet init --repair --setup-pr
```

Explicit init preserves validated settings in `.github/rivet.json` while applying
requested overrides. It recognizes supported prior installations and refuses
unrecognized edits. Compiler-comment differences do not cause lock-file updates
or unnecessary historical recompilation. An up-to-date setup reports that the
installation is already current, exits with status 1, and creates no PR.

Use `--dry-run` to preview without changing repository files. Both guided setup
and `--setup-pr` require a clean checkout at the fetched remote default branch.
Explicit mode without either option writes directly to the existing checkout.
Rivet does not create a repository when the path is missing.

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
