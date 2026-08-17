# Codekeeper package

This package contains Codekeeper's installer, TUI, production runtime, default
agent profiles, presets, reusable workflows, and locked installer/runtime
dependency graphs.

Source repository: [coryparrry/Codekeeper](https://github.com/coryparrry/Codekeeper).

Bundled source checkpoint: `f31d9a2e63c2746a47cc57c376a1ca90bb12053a`.

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
codekeeper doctor [--json]
codekeeper verify [--json] [--controlled]
```

`init` and `update` use `--current-package --package-integrity` only for an
exact local tarball. `doctor` is read-only. `verify` is post-merge evidence; it
does not turn an opened setup pull request into a working installation. While
the registry package is unavailable, it cannot prove the generated runtime's
package-acquisition path.

## Safety and operating model

- The installer creates a reviewed setup or update pull request; it never
  merges it.
- The Recommended path enables automatic PR review and manual maintenance;
  scheduled maintenance, tracing, repair, issue implementation, duplicate
  closure, and automatic merge start off.
- Each adopter owns its GitHub App, model credentials, Actions usage, and
  policy.
- Installed runtime workflows use GitHub-hosted ephemeral runners. Persistent
  shared self-hosted runners are outside the supported trust boundary.

Read [Authority, data, and cost](../../docs/authority-data-cost.md) before
providing repository content to a model or enabling code changes.

## Package metadata

The npm metadata points to the source repository, issue tracker, and homepage.
These links describe the source project; they do not imply that this package
version is publicly released.
