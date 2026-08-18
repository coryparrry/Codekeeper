# Codekeeper package

This package contains Codekeeper's installer, TUI, production runtime, default
agent profiles, presets, reusable workflows, and locked installer/runtime
dependency graphs.

Source repository: [coryparrry/Codekeeper](https://github.com/coryparrry/Codekeeper).

Bundled source checkpoint: `fd0044a6bd704157c56d50dc5a92bfabe4fa705a`.

## Availability

The version in this source tree is **not currently available from npm**. On
2026-08-17, `npm view codekeeper@0.2.0` returned `E404`. Do not publish or
recommend `npx codekeeper@0.2.0` until an authorized public release has
completed its provenance and post-publish checks.

For source evaluation, build an exact local tarball from the repository and
run it with its matching SHA-512 receipt:

```bash
npm exec --package /absolute/path/to/codekeeper.tgz -- \
  codekeeper init --current-package --package-integrity 'sha512-...'
```

See the [source/local installation guide](../../INSTALL.md) for the complete
packing, GitHub App, and proof sequence.

## CLI surface

The local package exposes:

```text
codekeeper init
codekeeper update
codekeeper update --to X.Y.Z
codekeeper update --check
codekeeper rollback --to X.Y.Z
codekeeper doctor [--json]
codekeeper verify [--json] [--controlled]
codekeeper status [--json]
codekeeper explain [--json] [--capability ID]
codekeeper plan --config FILE [--package-integrity SHA512] [--json] [--apply]
codekeeper resume [--branch codekeeper/setup] [--json] [--apply]
codekeeper remove [--json] [--apply]
```

`update` resolves the latest published release and runs it only when it is
strictly newer than the installed release. `--to X.Y.Z` selects one exact,
strictly newer semantic-version release after npm returns and verifies its
SHA-512 receipt. `update --check` reads the installed release manifest and
registry metadata without changing repository files or GitHub settings.

`status` and `explain` are read-only views of the installed package, workflows,
owners, models, App permissions, capabilities, triggers, validation, and
budgets. They show required secret names but never read secret values.

`plan --config` uses a strict credential-free JSON file and the normal
installer preflight and plan builders. It is read-only by default. Applying it
requires `CODEKEEPER_NONINTERACTIVE_APPLY=true`, rechecks repository state, and
refuses changes requiring secret entry. It can open a setup/update pull request
but never merges it.

`rollback --to X.Y.Z` creates a normal forward update pull request from one
verified older release. It never resets, reverts, or force-pushes.

`resume` inspects an already-pushed `codekeeper/setup` or
`codekeeper/update-<sha>` branch. Without `--apply`, it is read-only. Apply mode
can establish a safe disabled startup variable and recreate a missing pull
request, but cannot read or replace secret values.

`remove` is plan-only unless `--apply` is supplied. It verifies every
release-owned file against `.github/codekeeper-release.json`, disables
Codekeeper, creates one exact deletion commit, pushes a dedicated branch, and
opens a pull request. It does not merge, delete secrets or variables, remove
labels, or uninstall the adopter-owned GitHub App.

While the registry package is unavailable, verification cannot prove the
generated runtime's public package-acquisition path.

## Safety and operating model

- Installation, update, noninteractive configuration, and removal arrive as
  reviewed pull requests; the CLI never merges them.
- Machine-readable plans hash variable values and contain no credentials.
- Recovery only reconciles an existing pushed branch; it does not regenerate or
  overwrite repository code.
- Removal deletes only manifest-owned files whose current SHA-256 still matches
  the installed release receipt.
- The Recommended path enables automatic PR review and manual maintenance;
  schedules, tracing, repair, issue implementation, duplicate closure, and
  automatic merge start off.
- Each adopter owns its GitHub App, model credentials, Actions usage, and policy.
- Installed runtime workflows use GitHub-hosted ephemeral runners.

Read [CLI control surface](../../docs/CONTROL_SURFACE.md),
[Installer recovery and removal](../../docs/INSTALLER_RECOVERY.md), and
[Authority, data, and cost](../../docs/authority-data-cost.md) before enabling
mutation authority.

## Package metadata

The npm metadata points to the source repository, issue tracker, and homepage.
These links describe the source project; they do not imply that this package
version is publicly released.
