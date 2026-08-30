# Agent change and release safety

This document is the release-safety contract for agents editing the Rivet
repository. It covers the active `@coryparry/rivet` package and workflows.
Codekeeper appears only in explicitly marked historical or migration records;
its retired source trees are not active release surfaces. This contract maps
the places where one source change can silently invalidate another
representation and gives the verification required before a release claim.

The central rule is:

> A check is a pass only for the boundary it exercises. A green unit suite does
> not prove that generated assets, packaged files, adopter workflows, GitHub
> rulesets, npm state, or a live adopter installation are correct.

If the checkout, branch, commit, dependency installation, generated output, or
external state changes during verification, invalidate affected evidence and
start that verification again.

## 1. Before editing

Record the exact state before opening a change:

```bash
git status --short --branch
git rev-parse HEAD
git branch --show-current
git log -1 --oneline --decorate
```

Then:

1. Preserve every unrelated modified and untracked path. Do not reset, clean,
   stash, overwrite, or commit another agent's work.
2. Confirm the repository is on the intended non-release branch. Do not infer
   that the current `HEAD` is still the one reviewed earlier.
3. Classify every touched path using the impact map below.
4. Find the canonical producer and every generated, copied, staged, installed,
   or executed consumer before editing.
5. Treat credentials, App keys, live traces, npm tokens, and adopter evidence as
   external secrets. Never put them in arguments, logs, fixtures, commits, or
   evidence bundles.
6. If another process advances `HEAD` or changes an affected file, stop and
   rebind the review to the new state.

A release requires a clean checkout. The legacy Codekeeper package-stage and
candidate-pack paths are retired. Current releases use the protected
`rivet-vX.Y.Z` workflow to publish `@coryparry/rivet` through npm OIDC trusted
publishing.

## 2. The coupled release graph

The same product crosses several independently fallible boundaries:

```text
packages/rivet source and managed assets
        |  package tests, pinned compiler receipt, and workflow compilation
        v
published npm package and exact registry receipt
        |  verified installer plan and compiled workflow locks
        v
installed adopter workflows and managed actions
        |  App authorization, publication, evidence, GitHub state
        v
live release, live adopter acceptance, and registry receipt
```

The root source archive is a separate integrity plane:

```text
tracked Git content -> MANIFEST.sha256 -> git archive -> source-release verifier
```

A change is not release-ready until the affected paths in both graphs have
passed their relevant gates.

## 3. Impact map

Use the narrowest row that covers the change, then include every downstream row
named in its “also verify” column.

| Touched surface | Typical breaking point | Required local verification | Also verify |
|---|---|---|---|
| `packages/rivet/**` | The public CLI, managed assets, compiler receipt, App authority, setup-PR behavior, or package release identity changes without a matching test and packed consumer | `npm run rivet:check`; run focused installer, App, workflow, release-contract, and pack tests | generated workflow locks, clean adopter installation, npm receipt, live review or repair proof as applicable |
| `.github/workflows/**` or managed actions under `packages/rivet/assets/**` | Trigger, secret, permission, job dependency, checkout ref, action pin, runner, compiler, or publication contract breaks | root `npm run check`; actionlint; YAML parsing; focused workflow and managed-action tests | packed assets, compiled adopter workflow locks, protected live checks |
| Review or `pull_request_target` caller | Untrusted pull-request code is checked out or executed on a privileged runner, or required review authority is bypassed | workflow contract tests plus static inspection of checkout refs and job permissions | a controlled same-repository adopter PR |
| `package.json`, package lockfiles, Node/npm versions | Lifecycle scripts, dependencies, package metadata, or supported Node lines change without reproducible installs | clean `npm ci --ignore-scripts --no-audit --no-fund` on Node 22 and 24; package checks | exact npm 12.0.2 pack and install canary |
| Package repository identity, version, or release tag | npm publishes the wrong repository, package, version, or source checkpoint | release-contract tests and `npm run release:check -- --tag rivet-vX.Y.Z` | protected tag ancestry, npm provenance, registry receipt |
| `MANIFEST.sha256` (compatibility-only), release docs, or tracked files | Source archive no longer represents the reviewed tracked tree | `bash scripts/release-source.sh --verify` from a clean final commit | archive receipt and release tag |
| Release governance, ruleset, release workflow, or npm workflow | Checked-in protection is not applied live; required checks, npm environment, public visibility, trusted publisher, tag, or registry state is wrong | `npm run governance:check`; `node scripts/repository-governance.mjs --check-remote` | live rulesets, required checks, tag immutability, OIDC publication, npm receipt |
| Documentation, README, examples, or version-facing copy | Users follow commands, package names, versions, paths, or workflows that no longer exist | relevant documentation contract tests and root `npm run check` | clean package install and published package README |

When a row is not applicable, record why. “Only documentation” is not a safe
assumption when the document contains an install command, workflow snippet,
package version, source pin, policy key, or release procedure.

## 4. Local verification gates

Run gates in order. Stop at the first failure; do not interpret a later check as
a waiver for an earlier one.

### Gate A — exact state and preservation

```bash
git status --short --branch
git diff --check
git rev-parse HEAD
```

Pass criteria:

- the intended commit is recorded;
- unrelated changes remain untouched;
- no secret, local acceptance state, or generated output is accidentally in
  the change;
- the working tree is clean before a release build.

A changed `HEAD`, changed package lock, or changed generated file invalidates
later evidence.

### Gate B — repository checks

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The root check covers the Rivet package, lint/format, governance, module
boundaries, local import cycles, release-tag tests, and source-release worktree
verification.

A failure caused by billing, a missing runner, unavailable credentials, or an
environment outage is an evidence gap, not a product pass or product failure.
Record the infrastructure cause and run the safe local checks that remain
available.

### Gate C — Rivet and structural contracts

```bash
npm run rivet:check
npm run architecture:check
```

Then run focused tests for every affected Rivet source, workflow, or packaged
asset.

Do not treat source-text assertions as end-to-end workflow evidence. Confirm that
the assertion reaches the production path and rejects a plausible wrong
implementation.

### Gate D — source manifest synchronization

Finish and commit the source change without `MANIFEST.sha256`. From that clean
source commit, run:

```bash
node scripts/refresh-release-manifest.mjs
```

The script computes and commits only the root `MANIFEST.sha256`. Never hand-edit
that file, and do not edit another tracked file afterward. If tracked content
changes, repeat the refresh from the new clean source commit.

Confirm the exact source checkpoint contains the intended package and workflow
contents. An ancestor can still be the wrong release checkpoint.

### Gate E — Rivet delivery boundary

The legacy Codekeeper package staging and candidate-pack tooling are retired.
From the exact clean release checkpoint, qualify the active package with the
same commands used by the protected release workflow:

```bash
cd packages/rivet
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run release:check -- --tag rivet-vX.Y.Z
npm run pack:check
cd ../..
```

The tag must exactly match `packages/rivet/package.json`. Publication runs only
from `.github/workflows/rivet-release.yml` on a protected `rivet-vX.Y.Z` tag,
uses the `npm` environment and OIDC trusted publishing, and must not use a
long-lived npm publication token.

### Gate F — workflow and trust-boundary proof

For every changed workflow or embedded workflow asset, verify:

- every third-party action is pinned to a reviewed full commit;
- the pinned `gh-aw` compiler version and checksum match the reviewed receipt;
- the managed Markdown source, native imports, compiled workflow lock, and
  installed actions remain aligned;
- checkout refs use the trusted default branch where policy or credentials are
  involved;
- `pull_request_target` callers never execute pull-request code on a
  privileged runner;
- repair validation runs without write credentials, and publication accepts
  only the validated artifact after rechecking the App-authored review, owner
  command, and unchanged head;
- model-provider and App credentials remain separate and never appear in
  evidence or validation environments;
- job permissions, `needs`, concurrency, cancellation, artifact names, and
  outputs still form a valid failure-closed chain;
- the package-rendered workflow and installed compiled lock remain semantically
  aligned.

Use both actionlint and Ruby/Psych parsing. A YAML parser pass alone does not
prove GitHub expression, permission, trigger, or reusable-workflow semantics.

### Gate G — behavior and adopter proof

The Rivet package tests and fixtures prove only their local assertions. They do
not prove provider availability, GitHub mutations, App identity, npm
publication, or a live adopter.

When authorized, use a private disposable adopter repository and retain
evidence for:

1. `@coryparry/rivet` identity, version, SHA-512, and source checkpoint;
2. `rivet app-verify` from a clean checkout;
3. configured App identity, selected repository installation, least-privilege
   permissions, and stored private key metadata;
4. configured `CODEX_API_KEY` or `OPENAI_API_KEY` secret metadata and a live
   run that proves the selected engine can authenticate;
5. a dry-run and setup-pull-request receipt for the affected install mode;
6. review and owner-authorized repair scenarios relevant to the release;
7. stale-head, duplicate-event, retry, timeout, and rerun behavior;
8. cleanup and restoration of the adopter's enabled/disabled state.

Do not substitute a local fixture, fake `gh`, hermetic adapter, or source test
for live adopter proof.

### Gate H — live release state

Before publication, separately confirm the external boundaries:

- the protected `main` ruleset is live and requires the intended checks;
- immutable `rivet-vX.Y.Z` tag protection is live;
- the npm environment, OIDC trusted-publisher connection, provenance
  prerequisites, and public package state are correct;
- the release tag resolves to the exact source commit;
- npm `view`, `pack`, and exact-version install receipts agree on name,
  version, tarball URL, and SHA-512;
- registry propagation retries only for confirmed missing-release responses
  (`E404`, `ETARGET`, or the documented “No matching version found” form);
- unrelated npm authentication, network, malformed receipt, or registry errors
  fail closed;
- a post-publication installed-adopter verification is retained separately from
  pre-publication candidate evidence.

A successful local build is not evidence that any of these live conditions is
true.

## 5. Failure modes agents must stop on

Stop and report an evidence gap or blocker when:

- `HEAD` changes after validation begins;
- the working tree is dirty during a release build;
- a compiler checksum, workflow lock, embedded asset, or root manifest is
  stale;
- a package receipt has an unexpected JSON shape or mismatched integrity;
- a registry lookup fails for a reason other than confirmed propagation delay;
- a workflow parses but its caller, inputs, permissions, or `needs` graph do not
  match the consumer;
- a test passes only because it mocks the production boundary or shares the
  implementation's oracle;
- a live check cannot run because credentials, billing, runner, GitHub, npm, or
  adopter state is unavailable;
- an agent cannot prove that a changed source file reaches the packaged and
  installed consumer;
- evidence refers to a different commit, package version, tag, or adopter run;
- a change requires a new permission, secret, runner, registry, or external
  service not explicitly authorized.

Never turn an infrastructure failure into a product conclusion, and never turn
missing evidence into a pass.

## 6. Final evidence packet

An agent should hand off:

- exact commit SHA and branch;
- initial and final `git status --short --branch`;
- changed paths and impact rows;
- commands run, exit status, and focused result;
- generated files and synchronization checks;
- package filename, version, SHA-512, source-manifest result, and source commit;
- workflow/action/policy contract results;
- live boundaries that were verified and those that were not;
- known limitations, skipped tests, and infrastructure blockers.

The release owner should refuse a release claim if the packet contains only
“tests pass” without boundary-specific receipts.

## 7. Required final sequence

For packaged-source changes, use this order:

1. Finish source changes and affected tests.
2. Commit the source changes, excluding `MANIFEST.sha256`.
3. From that clean commit, run `node scripts/refresh-release-manifest.mjs`.
4. Do not edit tracked files after refreshing the root manifest.
5. Run `bash scripts/release-source.sh --verify` and record the exact passing
   commit SHA.
6. Build and verify the exact package candidate.
7. Run the separate live release and adopter gates when publication is authorized.

If any later tracked-file edit occurs, repeat the manifest refresh and final
source verification sequence. A version bump, tag, or npm publication does not
replace that proof; package provenance and the release tag must bind the exact
commit that passed it.

## 8. Scope and support boundary

This contract covers the supported Node 22+ package, GitHub Actions workflows,
npm publication, GitHub App authorization, and private-adopter acceptance
paths. Forks, GitHub Enterprise Server, persistent self-hosted runners, and
unsupported external infrastructure remain outside the supported release proof
unless a separate test contract is added.
