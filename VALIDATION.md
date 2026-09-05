# Rivet validation

Validation follows the current `packages/rivet` CLI and managed GitHub Agentic
Workflows. The retired `tools/codekeeper`, `packages/codekeeper`, and offline
`acceptance` commands are not current verification gates.

A source test proves only its boundary. Use
[agent release safety](docs/AGENT_RELEASE_SAFETY.md) to identify the downstream
package, installed-workflow, App, and publication checks affected by a change.

## Local checks

Use Node.js 22 or newer and the npm version pinned in `package.json`:

```bash
npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The root check runs the Rivet package tests, lint and formatting, governance
contracts, module-size and import-cycle checks, and source-manifest verification.
For a targeted change, start with its relevant test, then run the affected gates:

```bash
node --test packages/rivet/test/cli.test.mjs packages/rivet/test/guided-init.test.mjs
npm run rivet:check
npm run architecture:check
npm run governance:check
```

Installer coverage includes configuration preservation, nested-directory guided
setup, safe App-key reads, exact App authority, dry runs, stale plans, file
collisions, trusted historical upgrades, custom finding limits, draft setup-PR
verification, and preservation of semantically unchanged compiled locks.

For workflow or compiler changes, also run:

```bash
npm --prefix packages/rivet run review-lock:check
```

Use the pinned compiler, YAML parsing, and actionlint on the relevant workflow
surface. A parsed workflow or passing source test alone does not prove a live
GitHub run. CI runs package checks on pinned Node 22 and 24 versions and checks
GitHub Actions workflows with actionlint.

## Source and package integrity

Finish source changes and commit them without `MANIFEST.sha256`. From that clean
source commit, regenerate the compatibility manifest with its owning script:

```bash
node scripts/refresh-release-manifest.mjs
bash scripts/release-source.sh --verify
```

The refresh script commits only the manifest. Never hand-edit hashes. If tracked
content changes afterward, repeat the sequence and record the final passing SHA.
The verifier archives tracked Git content and checks both hashes and inventory;
working-tree-only files and credentials cannot enter that source archive.

Before a release, validate the package tag against the actual package version,
then pack and install the exact candidate in a clean consumer:

```bash
cd packages/rivet
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run release:check -- --tag "rivet-v<package-version>"
npm run pack:check
```

Replace `<package-version>` with `packages/rivet/package.json`'s version. Retain
the npm pack receipt, version, SHA-512 integrity, source commit, and installed
consumer evidence. A local pack does not prove npm publication; follow the
[release delivery guide](docs/RELEASE_READINESS.md) for that separate boundary.

## Fresh installation acceptance

Use a disposable GitHub.com repository with no previous Rivet files. Keep it
private by default, or use an explicitly approved public repository containing
only nonsensitive test content when public-runner acceptance is needed.

1. Start from a clean checkout matching the remote default branch. Run the exact
   packed candidate's guided command, for example
   `node /absolute/path/to/installed/rivet/bin/rivet.mjs init`, not an update
   command or fixture adapter.
2. Complete GitHub App registration and authentication, download its PEM, and
   install it only on the selected repository. Review-only requires Contents
   read, Metadata read, Pull requests write, and Issues write when automatic
   triage is enabled. Webhooks and unrelated permissions remain disabled.
3. Let the CLI configure and verify the App. Supply the provider credential
   through the supported environment or secure prompt, never command arguments,
   committed files, or public logs. Verify secret names without exposing values.
4. Confirm every planned managed file is new and the CLI creates a verified
   draft setup PR containing only those files. Review and merge that PR to
   activate the test installation; the CLI itself never merges.
5. Open a controlled same-repository PR against the default branch. Verify the
   public or private Actions run, actual model execution, App-authored review
   bound to the exact head, and managed status-label reconciliation.
6. Record the candidate SHA and integrity, setup PR, installed default-branch
   commit, smoke-test head, workflow run, and review. Keep pending, defective,
   fixed-head, stale-head, and repair scenarios separate from a basic smoke test.

For an update test, install a supported prior version first, retain customized
settings, and use the appropriate explicit `init --review-only` or `init --repair`
mode. Verify settings are preserved and compiler-comment-only differences do not
rewrite lock files. An update pass is not fresh-install evidence.

Repair needs its own authority upgrade and live proof. Follow
[repair qualification](docs/RIVET_REPAIR_QUALIFICATION.md). A green review run
does not establish repair readiness or authorize automatic merging.

## Recorded fresh-install proof

On 2026-09-05, the packed source candidate
`75ce0bb96e9351f1bc1f2c0e0e1a9990e8d1e27e` completed the fresh guided flow in an
explicitly approved public test repository. It created all 15 managed files in
[setup PR #1](https://github.com/coryparrry/rivet-fresh-install-test/pull/1), merged
as installed commit `d36921ba01c4256d9a1c062bf669029470c0bce1`.

[Smoke-test PR #2](https://github.com/coryparrry/rivet-fresh-install-test/pull/2)
received an App-authored review for head
`cec07c1120a5ee45f2f4c2b6d92812ff24003598` and the `merge ready` label.
[All nine workflow jobs passed](https://github.com/coryparrry/rivet-fresh-install-test/actions/runs/33977208536),
including model execution and publication. The CLI was restarted once to supply
the approved provider credential through its environment; installer output was
not replaced with hand-written fixture files.

This proves that candidate's fresh review-only path. It does not prove a later
package publication, every review scenario, or owner-authorized repair.

## Evaluation and evidence gaps

Use [Rivet evaluations](docs/EVALUATIONS.md) for repeated immutable-head review
and audit grading. Keep answer keys outside the adopter repository. Evaluation
success does not authorize additional GitHub mutations or a release.

Unavailable runners, billing, credentials, networks, or model services are
infrastructure gaps, not product passes. Report the affected command or run,
exact candidate, and boundary that remains unverified.
