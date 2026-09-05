# Security policy

Do not report vulnerabilities in public issues. Use this repository's private
vulnerability reporting channel on GitHub. If it is unavailable, contact the
maintainers privately through the repository owner.

Include the affected Rivet workflow or CLI command, a minimal reproduction,
impact, and any proposed mitigation. Do not include credentials, private keys,
live tokens, or private repository contents.

## Supported security boundary

Security reports are assessed for the active `@coryparry/rivet` CLI, installer,
managed workflows and actions, policy schema, upgrade paths, and release
artifacts. The retired Codekeeper runtime and package trees are historical and
are not active release surfaces.

Rivet's review caller runs from the default branch on `pull_request_target`.
Pull-request code and text are untrusted: the caller does not check out or
execute the pull-request head, and publication rechecks the exact repository,
pull request, base, and head before mutation. Managed workflows use pinned
third-party actions and a pinned, checksum-verified gh-aw compiler.

Review publication can submit App-authored review comments and reconcile only
these Rivet-managed labels: `changes required`, `review needed`, `merge ready`,
and `needs tests`. Human-owned and unrelated labels remain outside Rivet's
removal set. Maintenance is report-only and receives no App publication token.
Repair is a separate owner-authorized mode with isolated validation and a wider
App Contents permission.

## Installation and secrets

The guided `rivet init` flow displays the review-only App authority before
configuration. It requires a clean checkout at the exact remote default-branch
head, verifies repository admin access, verifies a selected-repository App installation
for the target with the exact permissions and no webhook events, and creates a
draft setup pull request. The administrator selects only the intended repository
on GitHub; verification checks selected-repository mode, not the number of other
repositories selected. Rivet activates only after the user
reviews and merges that pull request.

The installer sends the GitHub App private key and selected model credential to
`gh secret set` over standard input. GitHub stores them as encrypted Actions
secrets; Rivet does not write either key to the setup branch, configuration, or
installation receipt. The App client ID and bot login are non-secret repository
variables. Use a dedicated model credential and a repository-scoped App, rotate
them after suspected exposure, and never place them in logs or fixtures.

## Adopter responsibility

Adopters remain responsible for their GitHub App ownership, Actions secrets,
branch rules, repository policy, provider account, billing, and access to
workflow logs and artifacts. Review
[authority, provider data, and cost](docs/authority-data-cost.md) before
installation and follow the provider's retention and training terms for the
repository data Rivet sends.
