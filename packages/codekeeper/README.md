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
codekeeper resume [--branch codekeeper/setup] [--json] [--apply]
codekeeper remove [--json] [--apply]
```

`update` resolves the latest published release and runs it only when it is
strictly newer than the installed release. `--to X.Y.Z` selects one exact,
strictly newer semantic-version release after npm returns and verifies its
SHA-512 receipt.
`update --check` reads the installed release manifest, resolves registry
metadata, and reports the installed and latest published versions without
changing repository files, GitHub settings, or pull requests.

`rollback --to X.Y.Z` uses the same verified package path, then asks the target
CLI's existing forward-update protocol to create a normal release-update pull
request for that older release. The target must be older than the installed
release. It never resets, reverts, or force-pushes. If the verified target
cannot complete that protocol, the launcher fails closed without claiming that
rollback succeeded.

`resume` inspects an already-pushed `codekeeper/setup` or
`codekeeper/update-<sha>` branch. Without `--apply`, it is read-only. With
`--apply`, it can set a missing startup variable to `false` and recreate a
missing pull request after proving the remote branch tip and committed
Codekeeper policy. It never reads secret values; missing secrets and
identity variables remain explicit actions.

`remove` is plan-only unless `--apply` is supplied. It verifies every
release-owned file against `.github/codekeeper-release.json`, disables
Codekeeper, creates one exact deletion commit, pushes a dedicated branch, and
opens a pull request. It does not merge, delete secrets or variables, remove
labels, or uninstall the adopter-owned GitHub App.

`init`, exact updates, and rollback's target-side forward update use
`--current-package --package-integrity` only for an exact local tarball or
verified staged package. `doctor` is read-only. `verify` is post-merge evidence;
it does not turn an opened setup pull request into a working installation.
While the registry package is unavailable, it cannot prove the generated
runtime's package-acquisition path.

## Safety and operating model

- The installer creates a reviewed setup or update pull request; it never
  merges it.
- Recovery only reconciles an existing pushed branch; it does not regenerate or
  overwrite repository code.
- Removal deletes only manifest-owned files whose current SHA-256 still matches
  the installed release receipt.
- The Recommended path enables automatic PR review and manual maintenance;
  scheduled maintenance, tracing, repair, issue implementation, duplicate
  closure, and automatic merge start off.
- Each adopter owns its GitHub App, model credentials, Actions usage, and
  policy.
- Installed runtime workflows use GitHub-hosted ephemeral runners. Persistent
  shared self-hosted runners are outside the supported trust boundary.

Read [Installer recovery and removal](../../docs/INSTALLER_RECOVERY.md) before
resuming an interrupted setup or removing an installation. Read
[Authority, data, and cost](../../docs/authority-data-cost.md) before providing
repository content to a model or enabling code changes.

## Package metadata

The npm metadata points to the source repository, issue tracker, and homepage.
These links describe the source project; they do not imply that this package
version is publicly released.
